// Bridge for the MCP servers running inside an agent process (ask_user, approve, delegate, wisp_stats,
// wisp_sessions, wisp_session, wisp_crew*). Every call
// carries the per-run token wisp handed the agent; nothing else may use these.

import fs from 'node:fs';
import path from 'node:path';
import { adapters } from '../adapters/index.js';
import { plainMentions } from '../mentions.js';
import { blocksToMarkdown, sessionToMarkdown } from '../render.js';
import { summarize, workdir } from '../runner.js';
import { fromTask } from './stuff.js';
import { stuffDetail, stuffLine } from '../services/stuff.js';
import { delegationReport } from '../subagents.js';
import { toolStats, toolStatsText } from '../usage.js';
import { clip } from '../util.js';
import { EDIT_FIELDS, memberDetail, memberLine } from '../crew-tools.js';
import { applyImport, parseCrewFile, planImport } from '../crew-share.js';
import { fetchShared } from './spells.js';
import { describeSpell, normalizeSpell } from '../spells.js';
import { spellReference } from '../spell-guide.js';
import { ghProblem, wispPathProblem } from '../../web/js/spell-schema.js';
import { MAX_TAGS, normalizeTags } from '../../web/js/tags.js';

// 1536 → 1.5 KB, for the agent.
const size = (n) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

export function register(r, app) {
  const { store, runner, telemetry } = app;
  // The token check, then the handler; a wrong token is a 403 whatever the route.
  const guarded = (fn) => (c) => (c.req.headers['x-wisp-token'] !== app.token ? c.send(403, { error: 'bad token' }) : fn(c));
  const opts = { doc: false };
  const lead = (c) => store.get(c.params.id);

  r.route(
    'POST',
    '/internal/ask',
    guarded(async (c) => {
      const body = await c.body();
      const s = store.get(body.session);
      if (!s) return c.send(404, { error: 'no such session' });
      telemetry.track('ask_user', { agent: s.agent });
      c.send(200, { id: runner.ask(s, body) });
    }),
    opts,
  );
  r.route('GET', '/internal/ask/:id', guarded((c) => c.send(200, runner.pollAnswer(c.params.id))), opts);

  // resume_later: the agent schedules a follow-up into its own task, or cancels one it made.
  r.route(
    'POST',
    '/internal/later',
    guarded(async (c) => {
      const body = await c.body();
      const s = store.get(body.session);
      if (!s) return c.send(404, { error: 'no such session' });
      if (s.parentId || s.delegated) return c.send(400, { error: 'A subagent can’t schedule follow-ups; say in your report what should be checked later, and your lead can.' });
      const by = s.crew ? app.crew?.get(s.crew.id)?.name || 'agent' : 'agent';
      const mine = (s.later || []).filter((l) => l.by === by);
      if (body.cancel) {
        const ok = mine.some((l) => l.id === body.cancel) && app.later.cancel(s, body.cancel);
        return c.send(200, { text: ok ? 'Cancelled.' : 'No follow-up of yours with that id is pending.' });
      }
      const minutes = body.minutes !== undefined ? Number(body.minutes) : undefined;
      if (body.at !== undefined && typeof body.at === 'string' && !/(Z|[+-]\d\d:?\d\d)$/.test(body.at.trim())) return c.send(400, { error: 'at must be an ISO time with its offset (2026-10-25T14:30+02:00), or use minutes.' });
      const l = app.later.add(s, { text: body.message, by, ...(minutes !== undefined ? { in: minutes } : { at: body.at }) });
      telemetry.track('resume_later', { agent: s.agent, minutes: Math.round((l.at - Date.now()) / 60_000) });
      const when = (t) => new Date(t).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
      const others = (s.later || []).filter((x) => x !== l).map((x) => `- ${x.id} at ${when(x.at)}: ${clip(x.text, 80)}`).join('\n');
      c.send(200, { text: `Scheduled (id ${l.id}) for ${when(l.at)}, in ${Math.round((l.at - Date.now()) / 60_000)} min. Finish your turn now with your report, saying what you'll check then; wisp resumes this conversation at that time with your message.${others ? `\nAlso pending on this task:\n${others}` : ''}` });
    }),
    opts,
  );

  // wisp_tag: the agent names its task's topics, the words the user will search it by (⌘K, #tag).
  // It replaces the tags: the agent passes the whole list each time.
  r.route(
    'POST',
    '/internal/tags',
    guarded(async (c) => {
      const body = await c.body();
      const s = store.get(body.session);
      if (!s) return c.send(404, { error: 'no such session' });
      const tags = normalizeTags(body.tags);
      if (!tags.length) return c.send(400, { error: 'Give 3 to 8 short topic words, e.g. ["auth", "rate-limit", "redis"].' });
      const was = s.tags || [];
      s.tags = tags;
      store.save(s);
      app.sessionChanged(s);
      if (!was.length) telemetry.track('wisp_tag', { agent: s.agent, tags: tags.length });
      const cut = Array.isArray(body.tags) && body.tags.length > MAX_TAGS ? ` (only the first ${MAX_TAGS} are kept)` : '';
      c.send(200, { text: `Tagged: ${tags.map((t) => `#${t}`).join(' ')}${cut}. Call wisp_tag again only if the work moves to another topic; it replaces these.` });
    }),
    opts,
  );

  // wisp_pr: the agent attaches a GitHub PR to its task (or detaches one). It shows on the task's PR
  // row like one Ship it opened, and wisp follows its checks and reviews (services/ship.js).
  r.route(
    'POST',
    '/internal/prs',
    guarded(async (c) => {
      const body = await c.body();
      const s = store.get(body.session);
      if (!s) return c.send(404, { error: 'no such session' });
      const host = s.parentId ? store.get(s.parentId) : null; // a subagent's PR goes on its lead's task, where the user looks
      const t = host && !s.crew ? host : s;
      const pr = await app.ship.attach(t, body.pr, { remove: !!body.remove });
      store.save(t);
      telemetry.track('wisp_pr', { agent: s.agent, remove: !!body.remove });
      if (body.remove) return c.send(200, { text: `Detached PR #${pr.number} (${pr.url}).` });
      const n = app.ship.prsOf(t).length;
      const where = pr.own ? 'It is the PR of this task’s own branch: Ship it pushes to it.' : n > 1 ? `The task has ${n} PRs now; attach each one you open or work on.` : '';
      c.send(200, { text: `Attached PR #${pr.number} “${pr.title}” (${String(pr.state).toLowerCase()}${pr.draft ? ', draft' : ''}): ${pr.url}. It shows on the task, and wisp follows its checks and reviews. ${where}`.trim() });
    }),
    opts,
  );

  // wisp_save: the agent keeps something in the user's My Stuff (services/stuff.js): a file it made,
  // text, or a link. wisp_stuff: what's there, with each file's path so the agent can use it.
  r.route(
    'POST',
    '/internal/stuff',
    guarded(async (c) => {
      const body = await c.body();
      const s = store.get(body.session);
      if (!s) return c.send(404, { error: 'no such session' });
      const lead = (s.parentId && store.get(s.parentId)) || s; // a subagent saves for its lead's task, where the user looks
      const replace = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : undefined;
      const meta = { title: body.title, note: body.note, tags: body.tags, from: fromTask(lead), by: 'agent', replace };
      const given = [body.path, body.text, body.url, body.app].filter((v) => typeof v === 'string' && v.trim()).length;
      const local = (p) => path.resolve(workdir(s), String(p));
      if (given > 1 || (!given && !replace)) return c.send(400, { error: 'Give exactly one of path (a file), text (with a name like notes.md), url, or app (a folder); with id, it updates that item.' });
      let it;
      if (!given) it = app.stuff.update(replace, body); // only its title, note or tags
      else if (body.url) it = app.stuff.addLink(body.url, meta);
      else if (body.text) it = app.stuff.addText(body.text, { ...meta, name: body.name || body.title });
      else {
        const file = local(body.app || body.path);
        if (!fs.existsSync(file)) return c.send(404, { error: `Nothing at ${file}.` });
        if (body.cover && !fs.existsSync(local(body.cover))) return c.send(404, { error: `No picture at ${local(body.cover)}.` });
        it = body.app ? app.stuff.addApp(file, { ...meta, cover: body.cover && local(body.cover) }) : app.stuff.addFile(file, { ...meta, name: body.name });
      }
      telemetry.track('stuff_save', { kind: it.kind, by: 'agent', update: !!replace });
      // The answer shows it as a card (runner.js keepStuff adds one if the agent doesn't).
      if (!(lead.savedStuff ||= []).includes(it.id)) lead.savedStuff.push(it.id);
      store.save(lead);
      const what = `“${it.title}” (${it.kind}${it.size ? `, ${size(it.size)}` : ''})`;
      let launch = it.kind === 'app' ? ' The user launches it from My Stuff: wisp serves it on a port of its own.' : '';
      // publish: its public link on the user's wisp Grid (services/publish.js). Saved either way.
      // false: taken down. Either way the answer's stuff card shows the link the user shares.
      if (body.publish === true && it.kind === 'app') {
        try {
          const was = it.published;
          it = await app.publish.publish(it.id);
          launch += ` ${was ? 'Updated its public link (same address)' : 'Published it'}: ${it.published.url} — anyone with the link can open it, no sign-in. Give the user this link to share, and show the stuff block: its card has the link with Copy.`;
          telemetry.track('stuff_publish', { by: 'agent', update: !!was });
        } catch (err) {
          launch += ` It wasn't published: ${err.message} Tell the user.`;
        }
      } else if (body.publish === false && it.published) {
        try {
          const url = it.published.url;
          it = await app.publish.unpublish(it.id);
          launch += ` Unpublished: ${url} no longer opens. It stays in My Stuff.`;
        } catch (err) {
          launch += ` It wasn't unpublished: ${err.message}`;
        }
      } else if (it.published) launch += ` It's public at ${it.published.url}${(it.published.rev || 1) !== (it.rev || 1) ? ', with an older version: wisp_save with this id and publish: true updates the link' : ''}.`;
      c.send(200, { text: replace ? `Updated ${what} in the user's My Stuff, now v${it.rev || 1}; the version before is kept and the user can restore it.${launch} Show it in your answer as {"type":"stuff","id":"${it.id}"}.` : `Saved ${what} to the user's My Stuff, id ${it.id}. It's a copy: later changes to the original don't reach it (wisp_save with this id updates it).${launch} Show it in your answer as {"type":"stuff","id":"${it.id}"}${it.kind === 'app' ? ' (the user launches it from there, inside wisp)' : ''}.` });
    }),
    opts,
  );
  r.route(
    'GET',
    '/internal/stuff/:id',
    guarded((c) => {
      if (!store.get(c.params.id)) return c.send(404, { error: 'no such session' });
      const one = c.query.get('id');
      if (one) {
        const it = app.stuff.get(one);
        return c.send(200, { text: it ? stuffDetail(it) : `No item ${one} in My Stuff.` });
      }
      const kind = c.query.get('kind') || '';
      const all = app.stuff.search(c.query.get('query') || '', kind);
      const limit = Math.min(100, Number(c.query.get('limit')) || 30);
      c.send(200, { text: all.length ? `${all.length} item${all.length > 1 ? 's' : ''} in My Stuff${all.length > limit ? ` (the newest ${limit})` : ''}:\n${all.slice(0, limit).map(stuffLine).join('\n')}\n\nRead or copy a file from its path; don't change it there. wisp_stuff with an id gives one in full (a doc's text, an app's files); wisp_save with an id updates it.` : app.stuff.list().length ? 'Nothing in My Stuff matches that.' : 'My Stuff is empty.' });
    }),
    opts,
  );

  // A live approval (the harness's permission prompt): { decision } at once, or an { id } to poll
  // like ask_user, whose answer carries the decision.
  r.route(
    'POST',
    '/internal/approve',
    guarded(async (c) => {
      const body = await c.body();
      const s = store.get(body.session);
      if (!s) return c.send(404, { error: 'no such session' });
      const out = runner.requestApproval(s, body);
      if (out.id) telemetry.track('approval', { agent: s.agent });
      c.send(200, out);
    }),
    opts,
  );

  // delegate: POST starts tasks on the lead's subagents; GET reports on them (done once all finished).
  r.route(
    'POST',
    '/internal/delegate/:id',
    guarded(async (c) => {
      const s = lead(c);
      if (!s) return c.send(404, { error: 'no such session' });
      const body = await c.body();
      const delegations = await runner.delegate(s, body.tasks);
      telemetry.track('delegate', { agent: s.agent, tasks: delegations.length, harnesses: [...new Set(delegations.filter((d) => d.agent).map((d) => d.agent))] });
      c.send(200, { delegations });
    }),
    opts,
  );
  r.route(
    'GET',
    '/internal/delegate/:id',
    guarded((c) => {
      const s = lead(c);
      if (!s) return c.send(404, { error: 'no such session' });
      // The helper of a run that's being stopped or interrupted (its MCP server can outlive the
      // agent, and holds it up until it exits) is told to stop waiting: the delegations move on
      // to the lead's next turn, which collects them.
      const turn = c.query.get('turn');
      const cur = s.turns.at(-1);
      const over = runner.stopping.has(s.id) || (turn && (cur?.id !== turn || cur.status !== 'running'));
      if (over) return c.send(200, { done: true, text: 'This turn is over.' });
      const ids = (c.query.get('ids') || '').split(',').filter(Boolean);
      const list = runner.delegations(s, ids);
      if (!list.length) return c.send(200, { done: true, text: 'No delegated tasks to report on.' });
      const running = ({ d, child }) => child?.turns.find((t) => t.id === d.turnId)?.status === 'running';
      for (const x of list) if (!running(x)) delete x.d.owed; // the lead has this report now
      c.send(200, { done: !list.some(running), text: list.map(({ d, child }) => delegationReport(d, child, adapters)).join('\n\n---\n\n') });
    }),
    opts,
  );

  // Cast a spell: the tools a spell task writes its spell with. Only that task's token works.
  const spellTask = (fn) =>
    guarded(async (c) => {
      const s = lead(c);
      if (!s) return c.send(404, { error: 'no such session' });
      if (s.kind !== 'spell') return c.send(403, { error: 'only a Cast a spell task can use this' });
      return fn(c, s);
    });
  r.route(
    'GET',
    '/internal/spells/:id',
    spellTask((c) => {
      const { spells } = app.spells.list();
      const one = (x) => [`### ${x.name} (\`${x.id}\` v${x.version}, ${x.enabled ? 'on' : 'off'})`, ...x.summary.map((l) => `- ${l}`), '', '```json', JSON.stringify(app.spells.exported(x.id), null, 2), '```'].join('\n');
      const text = spells.length ? spells.map(one).join('\n\n') : 'The user has no spells yet.';
      c.send(200, { text });
    }),
    opts,
  );
  r.route('GET', '/internal/spell-schema/:id', spellTask((c) => c.send(200, { text: JSON.stringify(spellReference(), null, 1) })), opts);
  r.route(
    'POST',
    '/internal/spell-data/:id',
    spellTask(async (c) => {
      const { source, task } = await c.body();
      const src = source && typeof source === 'object' ? source : {};
      const problem = src.wisp !== undefined ? wispPathProblem(src.wisp) : src.gh !== undefined ? ghProblem(src.gh) : 'source is { "wisp": "/path" } or { "gh": [args] }';
      if (problem) return c.send(200, { text: `Not allowed: ${problem}` });
      const session = task ? store.get(String(task)) : null;
      try {
        const value = await app.spellData.get(`check-${c.params.id}`, 'sample', { ...src, refresh: 10 }, { session, summary: session ? summarize(session, store) : null, fresh: true });
        const json = JSON.stringify(value, null, 1);
        c.send(200, { text: json.length > 12_000 ? `${json.slice(0, 12_000)}\n… (cut; ${json.length} characters in all)` : json });
      } catch (err) {
        c.send(200, { text: `The source failed: ${err.message}` });
      }
    }),
    opts,
  );
  r.route(
    'POST',
    '/internal/spell-check/:id',
    spellTask(async (c) => {
      const { spell } = await c.body();
      try {
        const { spell: n, warnings } = normalizeSpell(spell);
        const d = describeSpell(n);
        const was = app.spells.get(n.id);
        c.send(200, {
          text: [`ok — “${n.name}” (${d.kind}) would:`, ...d.lines.map((l) => `- ${l}`), ...(warnings.length ? ['', 'Warnings:', ...warnings.map((w) => `- ${w}`)] : []), ...(was ? ['', `The user already has \`${n.id}\` v${was.version}; yours replaces it${n.version === was.version ? ' (bump version)' : ''}.`] : []), '', 'End your report with {"type":"spell","spell":{…}} holding exactly this spell.'].join('\n'),
        });
      } catch (err) {
        c.send(200, { text: err.problems ? `Not ok. Fix:\n${err.problems.map((p) => `- ${p}`).join('\n')}` : `Not ok: ${err.message}` });
      }
    }),
    opts,
  );

  // wisp_stats: read-only tool counts, spend and success across sessions. project=current is the
  // asking session's project.
  r.route(
    'GET',
    '/internal/stats/:id',
    guarded((c) => {
      const s = lead(c);
      if (!s) return c.send(404, { error: 'no such session' });
      const projectFor = (x) => store.projectFor(x.cwd);
      let project = c.query.get('project') || '';
      if (project === 'current') project = projectFor(s)?.id || String(s.cwd || '').split(/[\\/]/).pop();
      const stats = toolStats(store.all(), { days: Number(c.query.get('days')) || 30, project: projectFor, filter: { agent: c.query.get('agent') || '', project } });
      telemetry.track('wisp_stats', { agent: s.agent });
      c.send(200, { stats, text: toolStatsText(stats) });
    }),
    opts,
  );
  // wisp_sessions: the user's other tasks (not the asker, its subagents or the tour), newest first.
  r.route(
    'GET',
    '/internal/sessions/:id',
    guarded((c) => {
      const s = lead(c);
      if (!s) return c.send(404, { error: 'no such session' });
      const q = Object.fromEntries(c.query);
      let project = q.project || '';
      if (project === 'current') project = store.projectFor(s.cwd)?.id || String(s.cwd || '').split(/[\\/]/).pop();
      const states = q.state ? q.state.split(',').map((x) => x.trim()) : null;
      const words = String(q.query || '').toLowerCase().split(/\s+/).filter(Boolean);
      const all = store
        .all()
        .filter((x) => x.id !== s.id && !x.parentId && x.agent !== 'wisp' && x.id !== s.parentId)
        .map((x) => summarize(x, store))
        .filter((x) => (q.archived === 'true' || !x.archived) && (!states || states.includes(x.state)))
        .filter((x) => !project || x.projectId === project || x.project === project)
        .filter((x) => words.every((w) => `${x.title} ${x.preview} ${(x.tags || []).join(' ')}`.toLowerCase().includes(w.replace(/^#/, ''))))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const list = all.slice(0, Math.min(Math.max(Number(q.limit) || 20, 1), 100));
      telemetry.track('wisp_sessions', { agent: s.agent });
      const text = list.length
        ? `${all.length} task${all.length === 1 ? '' : 's'}${all.length > list.length ? `, the newest ${list.length}` : ''}. Read one with wisp_session; show one in your answer with a task block.\n\n${list.map(sessionLine).join('\n')}`
        : 'No tasks match.';
      c.send(200, { text });
    }),
    opts,
  );

  // wisp_crew, wisp_crew_add, wisp_crew_edit, wisp_crew_remove: the user's crew, read and changed by
  // an agent the user asked to. Only the user's own tasks change it: not a subagent, nor a member's
  // job (no member hiring or firing members on its own). A refusal is the tool's answer, not an error.
  r.route(
    'GET',
    '/internal/crew/:id',
    guarded((c) => {
      const s = lead(c);
      if (!s) return c.send(404, { error: 'no such session' });
      // ?member=: that one in full (brief, notebook, kit), read before changing them.
      const key = c.query.get('member');
      if (key) {
        const m = app.crew.find(key.trim().replace(/^@/, ''));
        return c.send(200, m ? { text: memberDetail(app.crew.view(m)) } : { error: `No one called “${key}” on the user's crew. List it with wisp_crew.` });
      }
      const list = app.crew.list.map((m) => app.crew.view(m));
      c.send(200, { text: list.length ? `${list.length} on the user's crew:\n\n${list.map(memberLine).join('\n')}` : 'The user has no crew yet. Add a member with wisp_crew_add.' });
    }),
    opts,
  );
  const crewChange = (fn) =>
    guarded(async (c) => {
      const s = lead(c);
      if (!s) return c.send(404, { error: 'no such session' });
      if (s.parentId || s.crew) return c.send(200, { error: 'Only a task the user started can change their crew; a subagent or a crew member’s job can’t. Tell the user what to change instead.' });
      const body = await c.body();
      try {
        c.send(200, await fn(s, body || {}));
      } catch (err) {
        c.send(200, { error: err.message });
      }
    });
  const pick = (body) => Object.fromEntries(EDIT_FIELDS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
  const named = (key) => {
    const m = app.crew.find(String(key || '').trim().replace(/^@/, ''));
    if (!m) throw new Error(`No one called “${key}” on the user's crew. List it with wisp_crew.`);
    return m;
  };
  r.route(
    'POST',
    '/internal/crew/:id',
    crewChange(async (s, body) => {
      // No folder given: the asking task's project (its worktree is the task's, not the member's).
      const cwd = body.cwd !== undefined ? String(body.cwd || '') : store.projectFor?.(s.cwd)?.path || (store.isScratch?.(s.cwd) ? '' : s.cwd);
      // from: members someone shared (server/crew-share.js), paused until the user resumes them.
      if (body.from) {
        const from = String(body.from).trim();
        const json = /^(https:|gist:)/i.test(from) ? (await fetchShared(from, 'crew')).json : JSON.parse(from);
        const parsed = parseCrewFile(json);
        if (parsed.spell) throw new Error('That is a spell, not a crew file: the user adds it in Settings → Spells (or with wisp spell install).');
        const agents = (await app.auto?.agents?.().catch(() => null)) || [];
        const plan = planImport(parsed.members, { crew: app.crew, agents, choices: Object.fromEntries(parsed.members.map((b) => [b.key, { cwd }])) });
        const made = applyImport(plan, { crew: app.crew, triggers: app.triggers });
        telemetry.track('crew_imported', { members: made.length, source: 'agent' });
        return { text: `Added ${made.map((m) => m.name).join(', ')} to the user's crew, paused: they start once the user presses Resume on them.\n\n${made.map((m) => memberLine(app.crew.view(m))).join('\n')}${plan.some((p) => p.notes.length) ? `\n\nNotes:\n${plan.flatMap((p) => p.notes).map((n) => `- ${n}`).join('\n')}` : ''}` };
      }
      const m = app.crew.create({ ...pick(body), cwd });
      telemetry.track('crew_tool', { agent: s.agent, op: 'add' });
      const out = body.checkin === true ? await app.crew.checkin(m).catch(() => ({})) : {};
      return { text: `Added ${m.name} to the user's crew.\n\n${memberLine(app.crew.view(m))}${out.session ? `\n\nTheir first check-in is running (task \`${out.session.id}\`).` : ''}\n\nThe user can talk to them as @${m.name} in any prompt.` };
    }),
    opts,
  );
  r.route(
    'PATCH',
    '/internal/crew/:id',
    crewChange(async (s, body) => {
      const m = named(body.member);
      // remember: lines added to the end of their notebook (after a rewrite given with them).
      const lines = (Array.isArray(body.remember) ? body.remember : []).filter((x) => typeof x === 'string' && x.trim()).slice(0, 12);
      const fields = pick(body);
      if (lines.length) fields.notebook = [fields.notebook ?? m.notebook, ...lines.map((x) => `- ${x.replace(/\s+/g, ' ').trim().slice(0, 300)}`)].filter(Boolean).join('\n');
      app.crew.update(m, fields);
      telemetry.track('crew_tool', { agent: s.agent, op: 'edit' });
      const nb = fields.notebook !== undefined ? `\n\nTheir notebook now has ${m.notebook.length} characters.` : '';
      return { text: `Updated ${m.name}.\n\n${memberLine(app.crew.view(m))}${nb}` };
    }),
    opts,
  );
  // wisp_crew_kit: files proposed for a member's kit, shown under this task's turn for the user to
  // pick from. Nothing changes until they do, so a member's job may propose too (its own kit, or a
  // teammate's); a subagent's answer isn't where the user reads, so it can't.
  r.route(
    'POST',
    '/internal/crew/:id/kit',
    guarded(async (c) => {
      const s = lead(c);
      if (!s) return c.send(404, { error: 'no such session' });
      if (s.parentId) return c.send(200, { error: 'A subagent can’t propose kit files: put them in your report, and the lead task can propose them.' });
      const body = (await c.body()) || {};
      try {
        const m = named(body.member);
        if (m.spell) throw new Error(`${m.name} comes from the “${m.spell.name}” spell, which sets their kit. The user makes them theirs first (Make it mine), then you can propose files.`);
        const { offer, refused } = app.crew.propose(m, s, body.files);
        telemetry.track('crew_tool', { agent: s.agent, op: 'kit' });
        const list = offer.files.map((f) => `- ${f.kind === 'skill' ? 'skill' : 'instructions'} **${f.name}**${(m.kit || []).some((k) => k.kind === f.kind && k.name.toLowerCase() === f.name.toLowerCase()) ? ' (replaces theirs)' : ''}`).join('\n');
        c.send(200, {
          text: `Proposed for ${m.name}’s kit; nothing is added until the user picks. wisp shows these under your answer with Add to their kit:\n\n${list}${refused.length ? `\n\nLeft out:\n${refused.map((x) => `- ${x}`).join('\n')}` : ''}\n\nIn your answer, say what each file is for; don't repeat the files.`,
        });
      } catch (err) {
        c.send(200, { error: err.message });
      }
    }),
    opts,
  );
  r.route(
    'DELETE',
    '/internal/crew/:id',
    crewChange(async (s, body) => {
      const m = named(body.member);
      const running = app.crew.busy(m);
      app.crew.remove(m);
      telemetry.track('crew_tool', { agent: s.agent, op: 'remove' });
      return { text: `Removed ${m.name} from the user's crew. Their brief, notebook and schedule are gone; their jobs stay as ordinary tasks${running ? ` (${running} still running)` : ''}, and triggers that sent them work are off.` };
    }),
    opts,
  );

  // wisp_session: one task's requests and a turn's report (?of=<id>&turn=<1-based>).
  r.route(
    'GET',
    '/internal/session/:id',
    guarded((c) => {
      const s = lead(c);
      if (!s) return c.send(404, { error: 'no such session' });
      const id = String(c.query.get('of') || '').trim().replace(/^wisp:/, '');
      const x = store.get(id);
      telemetry.track('wisp_session', { agent: s.agent });
      if (!x) return c.send(200, { text: `No wisp task \`${id}\` on this computer. It may have been deleted, or it ran on another machine. List tasks with wisp_sessions.` });
      c.send(200, { text: sessionText(x, store, c.query.get('turn')) });
    }),
    opts,
  );
}

const age = (t) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

const sessionLine = (x) =>
  `- \`${x.id}\` **${x.title}** — ${x.archived ? 'archived, ' : ''}${x.state}, ${x.agent}${x.model ? ` (${x.model})` : ''}, ${x.project}, ${age(x.updatedAt)}${x.tags?.length ? ` ${x.tags.map((t) => `#${t}`).join(' ')}` : ''}${x.state === 'running' && x.live ? `: ${x.live}` : x.preview ? `: ${clip(x.preview, 160)}` : ''}`;

export function sessionText(x, store, turnArg) {
  const sum = summarize(x, store);
  const n = Number(turnArg);
  const turn = turnArg === null || turnArg === undefined || turnArg === '' || !n ? x.turns.at(-1) : x.turns[n - 1];
  const head = [
    `# ${x.title}`,
    `Task \`${x.id}\` · ${sum.archived ? 'archived · ' : ''}${x.state} · ${x.agent}${x.model ? ` (${x.model})` : ''} · project ${sum.project} · updated ${age(x.updatedAt)}`,
    `Folder: \`${x.worktree?.path || x.cwd}\`${x.worktree ? ` (worktree, branch \`${x.worktree.branch}\`)` : ''}${x.pr ? ` · PR #${x.pr.number} (${String(x.pr.state).toLowerCase()}): ${x.pr.url}` : ''}`,
    ...(x.prs?.length ? [`Attached PRs: ${x.prs.map((y) => `${y.repo} #${y.pr.number} (${String(y.pr.state).toLowerCase()}): ${y.pr.url}`).join(' · ')}`] : []),
  ];
  const asks = x.turns.map((t, i) => `${i + 1}. ${clip(plainMentions(t.prompt).replace(/\s+/g, ' '), 300)}${t.status === 'running' ? ' _(running)_' : t.status === 'error' ? ' _(failed)_' : t.status === 'stopped' ? ' _(stopped)_' : ''}`);
  if (!turn) return [...head, '', `Turn ${turnArg} doesn't exist; this task has ${x.turns.length}.`, '', '## Requests', ...asks].join('\n');
  const i = x.turns.indexOf(turn);
  const report = turn === x.turns.at(-1) ? sessionToMarkdown(x) : blocksToMarkdown(turn.presentation?.blocks, turn);
  const files = (turn.changes || []).filter((ch) => !ch.reverted).map((ch) => `\`${ch.file}\``);
  return [
    ...head,
    '',
    `## Requests (${x.turns.length})`,
    ...asks,
    '',
    `## Report for turn ${i + 1}${x.turns.length > 1 ? ` of ${x.turns.length} (pass turn to read another)` : ''}`,
    '',
    report || '_No report yet._',
    ...(files.length ? ['', `Files edited in this turn: ${files.join(', ')}`] : []),
  ].join('\n');
}
