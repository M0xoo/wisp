// One way in for every launch (the launcher, the CLI, recipes, triggers, the phone and compare
// runs), here or on a machine, plus the follow-ups and "done" that every surface shares.

import fs from 'node:fs';
import path from 'node:path';
import { adapters } from '../adapters/index.js';
import { btwQuestion } from '../btw.js';
import { createWorktree, worktreeSource, ensureWorktree, removeWorktree } from '../git.js';
import { qualify } from '../machines.js';
import { fill, positional } from '../recipes.js';
import { summarize } from '../runner.js';
import { normalizeTeam } from '../subagents.js';
import { crewJobOf } from '../crew.js';
import { goalCommand, normalizeGoal } from '../goal.js';
import { bad, expand, MODES, newId } from '../util.js';

export const MAX_COMPARE = 4;
export const MAX_ALSO = 8; // extra folders one task may work in

// also: more folders the task works in besides cwd (a backend and its web app, say). Each must be
// a directory; repeats, cwd itself and folders inside one already listed are dropped.
export function alsoDirs(list, cwd) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw bad('also must be a list of folders.');
  const inside = (a, b) => a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
  const out = [];
  for (const x of list) {
    const raw = typeof x === 'string' ? x : x?.cwd;
    if (!String(raw || '').trim()) continue;
    const dir = path.resolve(expand(String(raw).trim()));
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw bad(`Not a directory: ${dir}`);
    if (inside(dir, cwd) || out.some((d) => inside(dir, d))) continue;
    for (let i = out.length - 1; i >= 0; i--) if (inside(out[i], dir)) out.splice(i, 1);
    out.push(dir);
  }
  if (out.length > MAX_ALSO) throw bad(`A task can work in up to ${MAX_ALSO + 1} folders.`);
  return out;
}

export function createLaunch(app) {
  const { store, runner, machines } = app;

  // body: { prompt, cwd, also: [folder], scratch: true = no folder, agent, mode, model, effort, attachments: [uploadId], worktree, compare,
  //         subagents: [{ name, agent, model, effort, use }] | preset: teamId, moved: { from, title, turns, packs }, account }
  // crew: a crew member's job ({ id, job, from? }, server/crew.js); only the crew sets it, never a request.
  // unattended: nobody started it by hand (a check-in, a trigger): it doesn't start on an account
  // past Settings → Usage → Automations stop at, and throws with `held` instead.
  async function launch(body, origin = null, { crew = null, unattended = false } = {}) {
    // crewJob: a job the wisp that owns a crew member sent here, with the member's note (server/crew.js).
    crew ||= crewJobOf(body.crewJob);
    // "/goal all tests pass" as the whole prompt: that's the goal, and the task is to reach it.
    const asGoal = !body.goal && goalCommand(body.prompt);
    if (asGoal) body = { ...body, goal: asGoal, prompt: asGoal };
    if (!String(body.prompt || '').trim()) throw bad('prompt required');
    // goal: { text, max }: the task keeps going until it holds (server/goal.js).
    const goal = !crew && !body.delegated && body.kind !== 'spell' ? normalizeGoal(body.goal, app.goals?.rounds()) : null;
    // kind 'spell': Cast a spell. The agent changes wisp, not a project: an empty scratch folder of
    // its own, one run. Edits mode, not Plan: Claude's Plan mode refuses MCP tools (the spell tools),
    // and there is nothing in the folder to edit; wisp installs the spell only when you keep it.
    const kind = body.kind === 'spell' ? 'spell' : '';
    if (kind) body = { ...body, scratch: true, mode: 'edits', compare: undefined, subagents: undefined, preset: undefined, worktree: false };
    // scratch: no project folder (general questions); the task gets an empty directory of its own.
    const scratch = body.scratch === true;
    const cwd = scratch ? store.scratchDir(newId()) : expand(body.cwd || process.cwd());
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw bad(`Not a directory: ${cwd}`);
    const also = scratch ? [] : alsoDirs(body.also, cwd);
    const d = store.config.defaults;
    const preset = body.preset && store.config.teams.find((t) => t.id === body.preset);
    if (body.preset && !preset && !body.subagents) throw bad(`no such subagent preset: ${body.preset}`);
    const subagents = normalizeTeam(body.subagents ?? preset?.members, adapters);
    // compare: more { agent, model, effort } to run the same task on, side by side. 'auto' is
    // resolved here: the router picks a harness and model (a different one per compare run).
    const resolved = await app.auto.resolve(body, await app.auto.agents(), { team: subagents.length > 0, cwd });
    // A launch routed by another wisp (this is a machine) arrives with its route: Auto's steps
    // (check, repair) still run here, where the files are.
    const isRoute = (x) => x && typeof x === 'object' && typeof x.key === 'string';
    const runners = [{ agent: resolved.agent, model: resolved.model, effort: resolved.effort, route: resolved.route ?? body.route }, ...(resolved.compare || [])].slice(0, MAX_COMPARE).map((r, i) => {
      const agent = r.agent || (i ? d.agent : '') || 'claude';
      if (!adapters[agent]) throw bad(`unknown agent: ${agent}`);
      // account: which of the harness's accounts (server/accounts.js); none = your last pick, else the first free.
      const account = !i && typeof body.account === 'string' && /^[\w-]{1,40}$/.test(body.account) && agent === resolved.agent ? body.account : '';
      return { agent, model: r.model ?? (i ? d.models?.[agent] || '' : ''), effort: /^[\w-]{1,20}$/.test(r.effort || '') ? r.effort : '', account, ...(isRoute(r.route) && { route: r.route }) };
    });
    if (unattended) {
      const h = app.reserve?.check(runners[0].agent, runners[0].account);
      if (h) throw Object.assign(bad(h.why, 409), { held: h });
    }
    const strategy = ['single', 'best2', 'compare'].includes(resolved.autoStrategy) ? resolved.autoStrategy : runners.length > 1 ? 'compare' : 'single';
    const mode = MODES.has(body.mode) ? body.mode : 'auto';
    // Worktrees are on by default in git repos (off in Plan mode: nothing gets written). Compare
    // runs need one each, or the harnesses would edit the same files.
    const comparing = runners.length > 1;
    const wantTree = !scratch && (body.worktree ?? (comparing || (mode !== 'plan' && d.worktree !== 'off')));
    // groupId: one launch sent to several machines (or here and there) shows as one task.
    const groupId = /^[a-f0-9]{12}$/.test(body.groupId || '') ? body.groupId : comparing ? newId() : null;
    const attachments = app.uploads.resolve(body.attachments);
    const ids = runners.map(() => newId());
    let trees = ids.map(() => null);
    // A task moved here from another place (services/move.js): its work comes in its bundles.
    const moved = body.moved && typeof body.moved === 'object' && !comparing ? body.moved : null;
    // A delegate's run for a lead on another place (services/relay.js): hidden, and it can't ask.
    const delegated = body.delegated && typeof body.delegated === 'object' && moved ? { lead: String(body.delegated.lead || '').slice(0, 200), name: String(body.delegated.name || '').slice(0, 40) } : null;
    if (moved) {
      const made = await app.mover.unpack([cwd, ...also], moved.packs, { id: ids[0], title: moved.title || body.prompt });
      trees = [made[0]];
      const extras = also.map((dir, i) => ({ cwd: dir, ...(made[i + 1] && { worktree: made[i + 1] }) }));
      const history = Array.isArray(moved.turns) ? moved.turns.filter((t) => t && typeof t === 'object' && typeof t.prompt === 'string') : [];
      const r = runners[0];
      return [runner.create({ id: ids[0], prompt: body.prompt, cwd, also: extras, ...r, mode, attachments, worktree: trees[0], groupId, origin: origin || moved.origin || null, subagents: delegated ? [] : subagents, history, title: moved.title, moved: { from: String(moved.from || ''), at: Date.now() }, delegated })];
    }
    if (wantTree) {
      const must = body.worktree === true || (comparing && mode !== 'plan');
      // One fetch for the whole launch, then the checkouts (git.js has them take turns in the
      // repo): compare runs used to fetch once per run before anything showed up in the feed.
      const results = await worktreeSource(cwd).then(
        (source) => source && Promise.allSettled(ids.map((id) => createWorktree({ cwd, home: store.home, id, title: body.prompt, source }))),
        (err) => [{ status: 'rejected', reason: err }],
      );
      const failed = results?.find((x) => x.status === 'rejected')?.reason;
      trees = ids.map((_, i) => (results?.[i]?.status === 'fulfilled' ? results[i].value : null));
      if (must && (failed || trees.some((t) => !t))) {
        await Promise.all(trees.map((t) => t && removeWorktree(t, { force: true, branch: 'force' }).catch(() => {})));
        if (failed) throw bad(`Could not create a worktree: ${failed.message}`);
        throw bad(comparing ? 'Compare needs a git repo with at least one commit, so each harness gets its own worktree.' : 'Not a git repo with commits, so there is nothing to make a worktree from.');
      }
      if (failed) console.warn(`wisp: no worktree for ${cwd}: ${failed.message}`);
    }
    // The other folders: a worktree of their own per run where they're git repos (so parallel
    // tasks don't collide there either), else the folder itself.
    const extras = await Promise.all(
      also.map(async (dir) => {
        const source = wantTree && (await worktreeSource(dir).catch(() => null));
        const made = await Promise.all(ids.map((id) => (source ? createWorktree({ cwd: dir, home: store.home, id, title: body.prompt, source }).catch((err) => console.warn(`wisp: no worktree for ${dir}: ${err.message}`)) : null)));
        return made.map((worktree) => ({ cwd: dir, ...(worktree && { worktree }) }));
      }),
    );
    return runners.map((r, i) => runner.create({ id: ids[i], prompt: body.prompt, cwd, also: extras.map((x) => x[i]), ...r, mode, attachments, worktree: trees[i], groupId, origin, subagents, kind, goal, ...(crew && !i && { crew }), ...(kind && { title: `Spell: ${String(body.prompt).trim().split('\n')[0].slice(0, 60)}` }), ...(r.route && { auto: { strategy }, scout: resolved.scout || null }) }));
  }

  // Where a launch runs: body.machine ('' = here), else a project folder that only exists on a
  // machine (recipes and schedules keep just the path). null = here.
  function machineFor(body) {
    if (typeof body.machine === 'string') return body.machine ? machines.get(body.machine).id : null; // '' = this computer
    if (body.machine) return machines.get(String(body.machine)).id;
    const cwd = String(body.cwd || '');
    if (!cwd || fs.existsSync(expand(cwd))) return null;
    return store.config.projects.find((p) => p.machine && (cwd === p.path || cwd.startsWith(`${p.path}/`)))?.machine || null;
  }

  // Attachments are uploaded here; a machine gets its own copies before a launch or reply.
  async function pushUploads(mid, ids) {
    const out = [];
    for (const u of app.uploads.resolve(ids)) out.push((await machines.upload(mid, u)).id);
    return out;
  }

  // launch(), here or on a machine. Resolves with summaries (a compare launch has several).
  // opts: launch()'s (unattended). A machine keeps its own plan budget, so it isn't held here.
  async function launchAny(body, origin = null, opts = {}) {
    const mid = body.kind === 'spell' ? null : machineFor(body); // spells change this wisp, so they're cast here
    // The team as that place runs it: members on other machines are carried there from here.
    const preset = !body.subagents && body.preset && store.config.teams.find((t) => t.id === body.preset);
    if (body.subagents || preset) body = { ...body, subagents: app.relay.placeTeam(body.subagents || preset.members, mid), preset: undefined };
    // Every project runs anywhere: its folders become the ones on that place, cloned there first if need be.
    body = await app.places.placeBody(body, mid);
    if (!mid) return (await launch(body, origin, opts)).map((x) => summarize(x, store));
    // Auto for a machine: routed here, with the harnesses that machine has; its outcomes come
    // back through the summaries it streams (auto.signals), so one router learns from every place.
    const routed = await app.auto.resolve(body, machines.agentsOf(mid) || [], { team: !!(body.subagents?.length || body.preset), place: machines.get(mid).name });
    const routes = [routed.route, ...(routed.compare || []).map((c) => c.route)];
    // The machine runs Auto's check and repair on these picks (an older wisp there ignores them).
    const sendBody = { ...routed };
    delete sendBody.scout;
    if (!sendBody.compare?.length && !body.compare) delete sendBody.compare;
    const out = await machines.launch(mid, { ...sendBody, attachments: await pushUploads(mid, body.attachments), ...(origin && { origin }) });
    (out.group || [out]).forEach((x, i) => routes[i] && app.router.record(qualify(x.id, mid), routes[i]));
    const known = out.scratch || store.projectFor(out.cwd, mid);
    if (!out.scratch) {
      (known || store.addProject(out.cwd, { machine: mid })).lastUsedAt = Date.now();
      store.saveConfig();
      if (!known) app.broadcast('config', {});
    }
    return (out.group || [out]).map((x) => machines.summary(mid, x));
  }

  // A follow-up from anywhere (UI, CLI, phone). An archived session may have lost its worktree.
  // One that starts with /btw is a side question instead: the run carries on (see askBtw).
  async function replyTo(s, text, attachments = [], queue, mode, run, team) {
    const question = btwQuestion(text);
    if (question !== null) return { btw: await askBtw(s, question, attachments) };
    // /goal <condition> sets the task's goal (and goes after it); /goal drop drops it.
    const goal = goalCommand(text);
    if (goal !== null) {
      if (/^(drop|clear|off|none)$/i.test(goal)) return { goal: app.goals.drop(s) ? null : undefined, dropped: true };
      for (const x of [s, ...(s.also || [])]) await ensureWorktree(x.worktree);
      return { goal: app.goals.set(s, goal) };
    }
    for (const x of [s, ...(s.also || [])]) await ensureWorktree(x.worktree);
    return runner.reply(s, text, attachments, { queue: queue ?? store.config.defaults.followUp === 'queue', mode, run, team });
  }

  // /btw: answered by a read-only run of its own, next to the task's run (server/btw.js).
  async function askBtw(s, question, attachments = []) {
    question = String(question || '').trim();
    if (!question) throw bad('Type your question after /btw.');
    if (s.agent === 'wisp') throw bad('This is the tour — launch a real wisp to ask it things.');
    for (const x of [s, ...(s.also || [])]) await ensureWorktree(x.worktree);
    const entry = runner.btw(s, question, attachments);
    app.telemetry?.track('btw', { agent: s.agent, forked: entry.forked, running: runner.live.has(s.id) });
    return entry;
  }

  function markDone(s) {
    if (s.state === 'running' || s.state === 'waiting') return false;
    const was = s.state;
    s.state = 'done';
    app.later?.done(s); // the agent's own wake-ups go; yours stay
    if (was !== 'done') app.triggers?.taskEvent('done', s); // crew members and triggers that watch for it
    s.unread = false;
    app.retro.schedule(s, 0);
    app.sessionChanged(s);
    return true;
  }

  async function runRecipe(r, { params = {}, words, cwd, machine, agent, model, effort, mode } = {}) {
    const values = words ? { ...positional(r.prompt, words), ...params } : params;
    const [s] = await launchAny({ prompt: fill(r.prompt, values), cwd: r.cwd || cwd, machine, agent: agent || r.agent || undefined, model: model ?? (r.model || undefined), effort: effort || r.effort || undefined, mode: mode || r.mode || undefined }, { kind: 'recipe', id: r.id, name: r.name });
    r.runs = (r.runs || 0) + 1;
    r.lastRunAt = Date.now();
    app.configChanged();
    return s;
  }

  return { launch, launchAny, machineFor, pushUploads, replyTo, askBtw, markDone, runRecipe };
}
