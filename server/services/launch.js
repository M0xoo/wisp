// One way in for every launch (the launcher, the CLI, recipes, triggers, the phone and compare
// runs), here or on a machine, plus the follow-ups and "done" that every surface shares.

import fs from 'node:fs';
import { adapters } from '../adapters/index.js';
import { createWorktree, worktreeSource, ensureWorktree, removeWorktree } from '../git.js';
import { qualify } from '../machines.js';
import { fill, positional } from '../recipes.js';
import { summarize } from '../runner.js';
import { normalizeTeam } from '../subagents.js';
import { bad, expand, MODES, newId } from '../util.js';

export const MAX_COMPARE = 4;

export function createLaunch(app) {
  const { store, runner, machines } = app;

  // body: { prompt, cwd, scratch: true = no folder, agent, mode, model, effort, attachments: [uploadId], worktree, compare,
  //         subagents: [{ name, agent, model, effort, use }] | preset: teamId }
  async function launch(body, origin = null) {
    if (!String(body.prompt || '').trim()) throw bad('prompt required');
    // scratch: no project folder (general questions); the task gets an empty directory of its own.
    const scratch = body.scratch === true;
    const cwd = scratch ? store.scratchDir(newId()) : expand(body.cwd || process.cwd());
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw bad(`Not a directory: ${cwd}`);
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
      return { agent, model: r.model ?? (i ? d.models?.[agent] || '' : ''), effort: /^[\w-]{1,20}$/.test(r.effort || '') ? r.effort : '', ...(isRoute(r.route) && { route: r.route }) };
    });
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
    if (wantTree) {
      const must = body.worktree === true || (comparing && mode !== 'plan');
      // One fetch for the whole launch, then the checkouts side by side: compare runs used to
      // fetch and check out one after the other before anything showed up in the feed.
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
    return runners.map((r, i) => runner.create({ id: ids[i], prompt: body.prompt, cwd, ...r, mode, attachments, worktree: trees[i], groupId, origin, subagents, ...(r.route && { auto: { strategy }, scout: resolved.scout || null }) }));
  }

  // Where a launch runs: body.machine, else a project folder that only exists on a machine
  // (recipes and schedules keep just the path). null = here.
  function machineFor(body) {
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
  async function launchAny(body, origin = null) {
    const mid = machineFor(body);
    if (!mid) return (await launch(body, origin)).map((x) => summarize(x, store));
    // Auto for a machine: routed here, with the harnesses that machine has; its outcomes come
    // back through the summaries it streams (auto.signals), so one router learns from every place.
    const routed = await app.auto.resolve(body, machines.agentsOf(mid) || [], { team: !!(body.subagents?.length || body.preset) });
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
  async function replyTo(s, text, attachments = [], queue, mode, run) {
    await ensureWorktree(s.worktree);
    return runner.reply(s, text, attachments, { queue: queue ?? store.config.defaults.followUp === 'queue', mode, run });
  }

  function markDone(s) {
    if (s.state === 'running' || s.state === 'waiting') return false;
    s.state = 'done';
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

  return { launch, launchAny, machineFor, pushUploads, replyTo, markDone, runRecipe };
}
