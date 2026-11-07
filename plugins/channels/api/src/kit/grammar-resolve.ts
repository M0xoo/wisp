// Resolving what a message read: machine, project, model, in that order, because the chosen machine
// decides which models are valid (see grammar.ts).

import type { AgentView, MachineView, MemberView, ModelView } from '../index.ts';
import { type Ctx, type Opts, type With, findHarness, harnesses, matchModels, modelIds, namesOf, problem } from './grammar-words.ts';

const machineOf = (ctx: Ctx, id: string): MachineView | null => (ctx.machines || []).find((m) => m.id === id) || null;
const placeName = (ctx: Ctx, id: string | undefined): string => (id ? machineOf(ctx, id)?.name || id : 'this computer');

// What can run at a place: its harnesses, or null when that can't be known (offline, a sandbox).
function agentsAt(ctx: Ctx, id: string): AgentView[] | null {
  if (!id) return ctx.agents || [];
  if (id === 'sandbox') return null;
  return machineOf(ctx, id)?.agents || null;
}

// null agents don't always mean offline: a cloud computer asleep wakes when it gets work.
function resolveMachine(o: Opts, ctx: Ctx, mid: string): void {
  if (mid === 'sandbox' && !ctx.sandbox) problem(o, 'not-installed', 'Sandboxes need a wisp Grid: sign in to one in Settings → Cloud.');
  if (!mid || mid === 'sandbox') return;
  const m = machineOf(ctx, mid);
  if (m && !m.usable) problem(o, 'offline', `${m.name} is offline.`, namesOf((ctx.machines || []).filter((x) => x.usable)));
}

// A member's job: model, effort and mode can change for this one job. Its harness can't (its kit and
// memory are compiled for it), Auto picks for itself, and it works where it works.
function resolveMember(o: Opts, ctx: Ctx, m: MemberView): void {
  const w = o.withs;
  const name = m.name;
  if (o.project && o.project.path !== m.cwd) problem(o, 'refused', `${name} works in ${m.cwd ? (ctx.projects || []).find((p) => p.path === m.cwd)?.name || m.cwd : 'a folder of their own'}: a job can’t move them to ${o.project.name}.`);
  const own = m.sandbox ? 'sandbox' : m.machine || '';
  if (o.machine !== undefined && o.machine !== own) problem(o, 'refused', `${name} works on ${placeName(ctx, own)}: a job can’t move them to ${placeName(ctx, o.machine)}.`);
  if (!w) return;
  if (m.agent === 'auto') return problem(o, 'refused', `${name} is on Auto, which picks the harness and model itself. Change that in their settings, or start a task of your own.`);
  if (w.agent && w.agent !== m.agent) return problem(o, 'refused', `${name} runs on ${(findHarness(ctx, m.agent) || { name: m.agent }).name}: their kit and memory are made for it, so a job can’t change harness.`);
  if (m.sandbox) {
    if (w.model) o.model = w.model;
    if (w.effort) o.effort = w.effort;
    return;
  }
  const at = agentsAt(ctx, m.machine || '');
  if (!at) return problem(o, 'offline', `${placeName(ctx, m.machine)} is offline, so I can’t check that model for ${name}.`);
  resolveModel(o, ctx, w, at.filter((a) => a.id === m.agent), m.machine || '', m.agent);
  o.agent = null; // the member's, as it always is
}

const nameOf = (ctx: Ctx, id: string): string => (findHarness(ctx, id) || { name: id }).name || id;

// with <harness> [model]: that harness on the place.
function resolveNamed(o: Opts, ctx: Ctx, w: With, agents: AgentView[], place: string): void {
  const usable = agents.filter((a) => a.available && a.id !== 'wisp');
  const a = agents.find((x) => x.id === w.agent);
  if (!a?.available) return problem(o, 'not-installed', `${nameOf(ctx, w.agent)} isn’t ${a?.signedIn === false ? 'signed in' : 'installed'} on ${place}.`, namesOf(usable));
  o.agent = a.id;
  if (w.model) {
    const { hits } = matchModels(a, w.model);
    const [hit] = hits;
    if (!hit || hits.length !== 1) return problem(o, hits.length ? 'ambiguous' : 'not-installed', hits.length ? `“${w.model}” could be ${hits.length} models.` : `${a.name} on ${place} has no model “${w.model}”.`, (hits.length ? hits : modelIds(a)).map((m) => m.id));
    o.model = hit.id;
  }
  return effortFor(o, w, a, modelIds(a).find((m) => m.id === o.model) || null, place);
}

// One harness on a place (agents), or every harness there, for the model and effort asked for.
function resolveModel(o: Opts, ctx: Ctx, w: With, agents: AgentView[], mid: string, prefer = ''): void {
  const place = placeName(ctx, mid);
  if (w.agent) return resolveNamed(o, ctx, w, agents, place);
  const usable = agents.filter((a) => a.available && a.id !== 'wisp');
  if (w.model) {
    const model = w.model;
    const found = usable.map((a) => ({ a, ...matchModels(a, model) })).filter((x) => x.hits.length);
    if (!found.length) return problem(o, 'not-installed', `No model “${model}” on ${place}.`, usable.flatMap((a) => modelIds(a).map((m) => m.id)).slice(0, 12));
    const best = Math.min(...found.map((x) => x.tier));
    const top = found.filter((x) => x.tier === best);
    const pick = top.find((x) => x.a.id === prefer && x.hits.length === 1) || (top.length === 1 && top[0]?.hits.length === 1 ? top[0] : null);
    const hit = pick?.hits[0];
    if (!pick || !hit) return problem(o, 'ambiguous', `“${model}” could be several models on ${place}.`, top.flatMap((x) => x.hits.map((m) => `${x.a.id} ${m.id}`)));
    o.agent = pick.a.id;
    o.model = hit.id;
    return effortFor(o, w, pick.a, hit, place);
  }
  const a = usable.find((x) => x.id === prefer) || null;
  if (!a) return problem(o, 'refused', `Auto picks the thinking level itself. Name a model too: with opus ${w.effort}.`);
  return effortFor(o, w, a, null, place);
}

function effortFor(o: Opts, w: With, a: AgentView, model: ModelView | null, place: string): void {
  const effort = w.effort;
  if (!effort) return;
  const list = model?.efforts || a.efforts || [];
  if (!list.includes(effort)) return problem(o, 'not-installed', `${model?.label || a.name} on ${place} has no thinking level “${effort}”.`, list);
  o.effort = effort;
}

function resolveWith(o: Opts, ctx: Ctx, w: With, mid: string): void {
  if (w.agent === 'auto') {
    if (ctx.thread) return problem(o, 'refused', 'Auto picks when a task starts: name a harness or a model for a follow-up.', namesOf((ctx.agents || []).filter((a) => a.available)));
    o.agent = 'auto';
    o.model = w.model || null;
    if (w.effort) problem(o, 'refused', 'Auto picks the thinking level itself.', ctx.goals || []);
    return;
  }
  const at = agentsAt(ctx, mid);
  if (at) return resolveModel(o, ctx, w, at, mid, ctx.thread?.agent || ctx.defaultAgent || '');
  // Offline or a sandbox: nothing to check against here, so what's known of the harness stands.
  const a = w.agent ? findHarness(ctx, w.agent) : harnesses(ctx).find((x) => matchModels(x, w.model).hits.length) || null;
  if (a) o.agent = a.id;
  if (w.model) o.model = (a && matchModels(a, w.model).hits[0]?.id) || w.model;
  if (w.effort) o.effort = w.effort;
}

export function resolve(o: Opts, ctx: Ctx): void {
  if (o.crew) return resolveMember(o, ctx, o.crew);
  const project = o.project || ctx.defaultProject;
  const mid = ctx.thread ? ctx.thread.machine || '' : o.machine ?? (project?.machine || '');
  if (!ctx.thread) resolveMachine(o, ctx, mid);
  if (!o.problems.length && o.withs) resolveWith(o, ctx, o.withs, mid);
}
