// Agents driving wisp: the routes behind the injected MCP server's wisp_available, wisp_launch,
// wisp_task and the ad-hoc side of delegate (server/mcp-ask.js). What the user can do from the
// page (start a task anywhere, follow one up, stop, finish or archive it, pick subagents on any
// harness or machine), the task's agent can do when the user asks it to. Every call carries the
// run's token; subagents never get these tools.

import { adapters } from '../adapters/index.js';
import { MAX_SUBAGENTS, normalizeTeam } from '../subagents.js';
import { sessionText } from './internal.js';
import { clip, MODES } from '../util.js';

export const MAX_LAUNCHES = 8; // tasks one turn of an agent may start
export const MAX_DEPTH = 3; // a task started by a task started by a task, and no further

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
const settled = (s) => s.state === 'waiting' || (s.state !== 'running' && (!s.queue?.length || !!s.queueHeld));

export function register(r, app) {
  const { store, runner, machines, telemetry, launcher } = app;
  const guarded = (fn) => async (c) => {
    if (c.req.headers['x-wisp-token'] !== app.token) return c.send(403, { error: 'bad token' });
    const s = store.get(c.params.id);
    if (!s) return c.send(404, { error: 'no such session' });
    try {
      return await fn(c, s);
    } catch (err) {
      // A refusal is the tool's answer for the agent to act on, not a crash.
      return c.send(200, { error: err.message });
    }
  };
  const opts = { doc: false };
  // Only a task the user (or their crew) started drives wisp: a subagent works for its lead.
  const lead = (s, what) => {
    if (s.parentId || s.delegated) throw new Error(`A subagent can't ${what}: say so in your report, and your lead can.`);
  };

  // A machine by id or name ('' / 'here' / this computer = null).
  const machineOf = (key) => {
    const k = String(key ?? '').trim();
    if (!k || /^(here|local|this computer)$/i.test(k)) return null;
    const m = machines.list.find((x) => x.id === k) || machines.list.find((x) => x.name?.toLowerCase() === k.toLowerCase());
    if (!m) throw new Error(`No machine “${k}”. wisp_available lists the user's machines.`);
    return m;
  };
  const harnesses = async (m) => (m ? machines.agentsOf(m.id) : await app.auto.agents());
  // A harness that's there and signed in, or why not.
  const checkHarness = async (agent, m) => {
    if (!agent || agent === 'auto') return;
    if (!adapters[agent] || agent === 'wisp') throw new Error(`Unknown harness “${agent}”. One of: ${Object.keys(adapters).filter((a) => a !== 'wisp').join(', ')}, or auto.`);
    const list = await harnesses(m);
    if (!list) return; // a machine that's offline: it says when it gets the task
    const a = list.find((x) => x.id === agent);
    if (!a?.available) throw new Error(`${adapters[agent].name} isn't ${a?.signedIn === false ? 'signed in' : 'installed'} on ${m ? m.name : 'this computer'}.`);
  };
  // A project by name or id, else a folder.
  const folderOf = (body, s) => {
    if (body.project) {
      const k = String(body.project).trim().toLowerCase();
      const p = store.config.projects.find((x) => x.id === body.project || x.name?.toLowerCase() === k);
      if (!p) throw new Error(`No project “${body.project}”. wisp_available lists them.`);
      return { cwd: p.path, machine: p.machine || null };
    }
    if (body.cwd) return { cwd: String(body.cwd) };
    // None given: the asking task's project (its worktree is the task's own).
    return { cwd: store.projectFor?.(s.cwd)?.path || (store.isScratch?.(s.cwd) ? '' : s.cwd) };
  };
  // How many tasks up the chain started this one.
  const depth = (s) => {
    let n = 0;
    for (let x = s; x?.origin?.kind === 'task' && n < 10; x = store.get(x.origin.id)) n++;
    return n;
  };

  // wisp_available: everything an agent can pick from, in one read.
  r.route(
    'GET',
    '/internal/available/:id',
    guarded(async (c, s) => {
      const here = await app.auto.agents();
      const harness = (a) => {
        if (!a.available) return `- ${a.id} (${a.name}): ${a.signedIn === false ? 'not signed in' : 'not installed'}`;
        const models = (a.models || []).map((m) => m.id).filter(Boolean);
        return `- **${a.id}** (${a.name}${a.version ? ` ${a.version}` : ''})${models.length ? `: models ${models.slice(0, 15).join(', ')}${models.length > 15 ? ', …' : ''}` : ''}${a.efforts?.length ? `; thinking ${a.efforts.join(', ')}` : ''}`;
      };
      const view = machines.view();
      const machine = (m) => {
        const on = m.state === 'online';
        const list = (m.remote?.agents || []).filter((a) => a.available).map((a) => a.id);
        return `- \`${m.id}\` **${m.name}**${m.kind === 'grid' ? ' (cloud)' : ''}: ${on ? 'online' : m.state === 'asleep' ? 'asleep (wakes when it gets work)' : m.state}${list.length ? `; harnesses ${list.join(', ')}` : ''}`;
      };
      const projects = store.config.projects
        .slice()
        .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))
        .slice(0, 30)
        .map((p) => `- **${p.name}** (\`${p.id}\`): ${p.path}${p.machine ? ` on ${view.find((m) => m.id === p.machine)?.name || p.machine}` : ''}`);
      const presets = (store.config.teams || []).map((t) => `- \`${t.id}\` **${t.name}**: ${t.members.map((m) => m.crew ? `@${m.label || m.name}` : `${m.name} (${m.agent}${m.model ? ` ${m.model}` : ''}${m.machine ? ` on ${m.place || m.machine}` : ''})`).join(', ')}`);
      const team = s.subagents || [];
      const crew = (app.crew?.list || []).map((m) => `@${m.name}`);
      const d = store.config.defaults || {};
      telemetry.track('wisp_available', { agent: s.agent });
      const text = [
        '## Harnesses on this computer',
        ...here.filter((a) => a.id !== 'wisp').map(harness),
        `- **auto**: wisp picks the harness and model from what worked before${d.agent ? ` (the user's default is ${d.agent})` : ''}`,
        '',
        '## Machines',
        ...(view.length ? view.map(machine) : ['None: everything runs on this computer.']),
        '',
        '## Projects',
        ...(projects.length ? projects : ['None yet.']),
        '',
        '## Subagent presets (saved teams)',
        ...(presets.length ? presets : ['None.']),
        '',
        '## This task',
        `Task \`${s.id}\` on ${s.agent}${s.model ? ` (${s.model})` : ''}, mode ${s.mode}, in ${s.worktree?.path || s.cwd}.`,
        team.length ? `Its subagents: ${team.map((m) => `\`${m.name}\``).join(', ')} (delegate to them by name).` : 'No subagents yet: delegate creates them on the fly.',
        ...(crew.length ? [`The user's crew: ${crew.join(', ')} (wisp_crew reads them).`] : []),
        '',
        'Modes: plan (read-only) | edits (auto-accept edits) | auto (no permission prompts).',
        'delegate: subagents for this task (their edits land in your folder; any harness, any machine). wisp_launch: a separate task the user follows on its own. wisp_task: follow up, stop, finish or archive a task.',
      ].join('\n');
      c.send(200, { text });
    }),
    opts,
  );

  // wisp_launch: a new task, here or on a machine, like the user's launcher.
  r.route(
    'POST',
    '/internal/launch/:id',
    guarded(async (c, s) => {
      lead(s, 'start tasks');
      const body = (await c.body()) || {};
      const prompt = String(body.prompt || '').trim();
      if (!prompt) throw new Error('prompt is required: brief it like a colleague, it can’t see your conversation.');
      if (depth(s) >= MAX_DEPTH) throw new Error(`This task was started by another agent ${MAX_DEPTH} levels deep; it can't start more. Do the work here, or tell the user.`);
      const turn = s.turns.at(-1);
      if ((turn?.launched || []).length >= MAX_LAUNCHES) throw new Error(`This turn already started ${MAX_LAUNCHES} tasks. Say in your report what else should start.`);
      if (body.mode !== undefined && !MODES.has(body.mode)) throw new Error('mode must be plan, edits or auto.');
      const where = folderOf(body, s);
      const m = body.machine !== undefined ? machineOf(body.machine) : where.machine ? machineOf(where.machine) : null;
      await checkHarness(body.agent, m);
      const team = Array.isArray(body.subagents) ? body.subagents.map((x) => ({ ...x, machine: x?.machine ? machineOf(x.machine)?.id || 'here' : '' })) : undefined;
      if (body.preset && !(store.config.teams || []).some((t) => t.id === body.preset)) throw new Error(`No subagent preset “${body.preset}”. wisp_available lists them.`);
      const d = store.config.defaults || {};
      const launchBody = {
        prompt,
        ...(body.scratch === true ? { scratch: true } : { cwd: where.cwd }),
        ...(Array.isArray(body.also) && { also: body.also }),
        machine: m ? m.id : '',
        agent: body.agent || d.agent || 'auto',
        mode: body.mode || d.mode || 'auto',
        ...(body.model !== undefined && { model: String(body.model) }),
        ...(body.effort && { effort: String(body.effort) }),
        ...(typeof body.worktree === 'boolean' && { worktree: body.worktree }),
        ...(team && { subagents: team }),
        ...(body.preset && !team && { preset: body.preset }),
      };
      if (!where.cwd && body.scratch !== true) launchBody.scratch = true;
      const out = await launcher.launchAny(launchBody, { kind: 'task', id: s.id, name: clip(s.title || 'a task', 60) });
      if (turn) (turn.launched ||= []).push(...out.map((x) => x.id));
      store.save(s);
      telemetry.track('agent_launch', { agent: s.agent, harness: out[0]?.agent, machine: !!m, team: !!(team?.length || body.preset) });
      const line = (x) => `- \`${x.id}\` “${x.title}” on ${x.agent}${x.model ? ` (${x.model})` : ''}${m ? ` on ${m.name}` : ''}, mode ${x.mode || launchBody.mode}, in ${x.cwd || 'a scratch folder'}`;
      c.send(200, {
        ids: out.map((x) => x.id),
        text: `Started ${out.length > 1 ? `${out.length} tasks` : 'a task'} the user sees in wisp:\n${out.map(line).join('\n')}\n\nIt runs on its own. wisp_task with action "wait" blocks until it finishes or asks; wisp_session reads its report. Show it in your answer as {"type":"task","id":"${out[0].id}"}.`,
      });
    }),
    opts,
  );

  // wisp_task: act on another task, as the user would from its card.
  r.route(
    'GET',
    '/internal/task/:id',
    guarded((c) => {
      const x = store.get(String(c.query.get('of') || '').trim().replace(/^wisp:/, ''));
      if (!x) throw new Error('No such task on this computer. wisp_sessions lists them.');
      c.send(200, { state: x.state, settled: settled(x), question: x.ask?.question || null, text: sessionText(x, store) });
    }),
    opts,
  );
  r.route(
    'POST',
    '/internal/task/:id',
    guarded(async (c, s) => {
      lead(s, 'act on other tasks');
      const body = (await c.body()) || {};
      const id = String(body.task || '').trim().replace(/^wisp:/, '');
      const x = store.get(id);
      if (!x) throw new Error(`No task \`${id}\` on this computer. wisp_sessions lists them.`);
      if (x.id === s.id) throw new Error('That is this task. resume_later schedules a follow-up to yourself.');
      if (x.parentId || x.delegated) throw new Error('That is a subagent of another task; act on its lead instead.');
      if (x.id === s.parentId) throw new Error('That is your own lead.');
      if (x.agent === 'wisp') throw new Error('That is the welcome tour; it has no agent.');
      const action = String(body.action || '');
      const name = `“${x.title}” (\`${x.id}\`)`;
      telemetry.track('agent_task', { agent: s.agent, action });
      if (action === 'reply') {
        const text = String(body.text || '').trim();
        if (!text) throw new Error('text is required.');
        if (x.kind === 'reminder') throw new Error('A reminder has no agent to follow up with. Start a new task instead.');
        if (body.mode !== undefined && !MODES.has(body.mode)) throw new Error('mode must be plan, edits or auto.');
        if (body.agent !== undefined && body.agent !== x.agent) await checkHarness(body.agent, null);
        const run = body.agent !== undefined || body.model !== undefined || body.effort !== undefined ? { agent: body.agent || x.agent, ...(body.model !== undefined && { model: String(body.model || '') }), ...(body.effort !== undefined && { effort: String(body.effort || '') }) } : undefined;
        // Like a schedule's follow-up: held at the user's usage line, not refused.
        const r2 = (await launcher.replyTo(x, text, [], body.queue === true, body.mode, run, undefined, { auto: true })) || {};
        const how = r2.answered ? 'Answered its question; it carries on.' : r2.held ? 'Held at the user’s usage line; it goes when they say.' : r2.queued ? 'Queued: it goes once its current run finishes.' : r2.interrupted ? 'Interrupted its run; it carries on with your message.' : 'Sent; it is working on it.';
        return c.send(200, { text: `${how} ${name}. wisp_task with action "wait" blocks until it is done.` });
      }
      if (action === 'stop') {
        if (x.state !== 'running' && !runner.live.has(x.id)) return c.send(200, { text: `${name} isn't running.` });
        runner.stop(x);
        return c.send(200, { text: `Stopped ${name}. Its queued follow-ups stay.` });
      }
      if (action === 'done') {
        if (!launcher.markDone(x)) throw new Error(`${name} is still working; stop it first or wait.`);
        return c.send(200, { text: `Marked ${name} done.` });
      }
      if (action === 'archive' || action === 'unarchive') {
        if (action === 'archive' && (x.state === 'running' || x.state === 'waiting')) throw new Error(`${name} is still working; stop it first or wait.`);
        if (action === 'archive') Object.assign(x, { archived: true, unread: false });
        else delete x.archived;
        delete x.forLater;
        app.sessionChanged(x);
        return c.send(200, { text: `${action === 'archive' ? 'Archived' : 'Unarchived'} ${name}.` });
      }
      if (action === 'rename') {
        const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (!title) throw new Error('title is required.');
        Object.assign(x, { title, titleAuto: false });
        app.sessionChanged(x);
        return c.send(200, { text: `Renamed it “${title}”.` });
      }
      throw new Error('action is one of reply, stop, done, archive, unarchive, rename (wait is answered by the MCP server).');
    }),
    opts,
  );

  // delegate's ad-hoc subagents: tasks naming a harness (and machine) instead of a team member
  // join the lead's team first, so wisp runs, shows and resumes them like the ones the user picked.
  app.adhocTeam = async (s, tasks) => {
    // Not running: runner.delegate refuses, and the team stays as it was.
    if (!Array.isArray(tasks) || s.turns.at(-1)?.status !== 'running') return { tasks, errors: [] };
    const team = [...(s.subagents || [])];
    const errors = [];
    const out = [];
    for (const t of tasks.slice(0, 12)) {
      if (t?.subagent || !(t?.agent || t?.machine || t?.name)) {
        out.push(t);
        continue;
      }
      // A name the team already has: continue that one.
      const known = t.name && team.find((m) => m.name === slug(t.name));
      if (known) {
        out.push({ subagent: known.name, prompt: t.prompt });
        continue;
      }
      try {
        const m = t.machine ? machineOf(t.machine) : null;
        const agent = String(t.agent || 'auto');
        await checkHarness(agent, m);
        if (team.length >= MAX_SUBAGENTS) throw new Error(`A task has at most ${MAX_SUBAGENTS} subagents; delegate to one it has (${team.map((x) => x.name).join(', ')}).`);
        const base = slug(t.name) || slug(m ? `${agent}-${m.name}` : agent) || 'helper';
        const [member] = app.relay.placeTeam([{ name: base, agent, model: t.model, effort: t.effort, use: t.use, machine: m ? m.id : '' }], null);
        const next = normalizeTeam([...team, member], adapters);
        team.splice(0, team.length, ...next);
        out.push({ subagent: next.at(-1).name, prompt: t.prompt });
      } catch (err) {
        errors.push({ subagent: t.name || t.agent || t.machine, error: err.message });
      }
    }
    if (team.length !== (s.subagents || []).length) {
      s.subagents = team;
      s.children ||= {};
      store.save(s);
    }
    return { tasks: out, errors };
  };
}
