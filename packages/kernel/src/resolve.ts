// Resolution (plan §6.4, §6.11.2 rule 8): a pure function from manifests to an activation order.
// Edges come from `extends` and `requires`, where a requirement names a plugin or a service contract
// (then it points at the chosen provider). Missing or switched-off requirements refuse the plugin with
// the exact reason, cycles refuse every plugin on them (printed), and refusals cascade to dependents.
// Optional requirements order the set when they can but never refuse anything.
import type { Manifest, Requirement } from './contract.ts';
import { satisfies } from './semver.ts';

export const KERNEL_API = '1.0.0';

export interface ResolveInput {
  manifests: readonly Manifest[];
  /** switched off, with the reason ('disabled in the group', 'switched off in Settings') */
  off?: ReadonlyMap<string, string>;
  /** which plugin provides a service when several do: contract id → plugin id */
  choices?: ReadonlyMap<string, string>;
  /** plugins that are overrides (not built-in): they win a service over built-ins */
  overrides?: ReadonlySet<string>;
  api?: string;
}

export interface Resolution {
  /** resolved plugin ids, dependencies first */
  order: string[];
  /** every plugin that won't run, with why */
  refused: Map<string, string>;
  /** contract id → the plugin chosen to provide it */
  providers: Map<string, string>;
  /** plugin id → the plugins it hard-depends on (for cascades) */
  deps: Map<string, string[]>;
}

const req = (r: string | Requirement): Requirement => (typeof r === 'string' ? { version: r } : r);

/** Candidate providers per contract, best first: the user's choice, then overrides, then manifest order. */
export function providerCandidates(input: ResolveInput): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of input.manifests) for (const sid of Object.keys(m.provides ?? {})) out.set(sid, [...(out.get(sid) ?? []), m.id]);
  for (const [sid, ids] of out) {
    const chosen = input.choices?.get(sid);
    const rank = (id: string): number => (id === chosen ? 0 : input.overrides?.has(id) ? 1 : 2);
    out.set(sid, ids.map((id, i) => ({ id, i })).sort((a, b) => rank(a.id) - rank(b.id) || a.i - b.i).map((x) => x.id));
  }
  return out;
}

interface Edge {
  to: string; // a plugin id
  why: (state: string) => string;
  hard: boolean;
}

export function resolve(input: ResolveInput): Resolution {
  const api = input.api ?? KERNEL_API;
  const byId = new Map<string, Manifest>();
  const refused = new Map<string, string>();
  for (const m of input.manifests) if (!byId.has(m.id)) byId.set(m.id, m); // the kernel refuses a second registration
  for (const m of byId.values()) {
    const off = input.off?.get(m.id);
    if (off !== undefined) refused.set(m.id, off);
    else if (!satisfies(api, m.api)) refused.set(m.id, `${m.id} needs kernel api ${m.api}, this kernel is ${api}`);
  }
  const candidates = providerCandidates(input);
  const providers = new Map<string, string>();
  const edges = new Map<string, Edge[]>();
  // Refusals change which providers are usable, so iterate until nothing new is refused.
  for (let changed = true; changed; ) {
    changed = false;
    pickProviders(candidates, byId, refused, providers);
    for (const m of byId.values()) edges.set(m.id, edgesOf(m, byId, providers));
    // judged against this round's snapshot, so the result doesn't depend on registration order
    const round = new Map<string, string>();
    for (const m of byId.values()) {
      if (refused.has(m.id)) continue;
      const why = refusalOf(m, edges.get(m.id) ?? [], { byId, refused, providers, off: input.off });
      if (why) round.set(m.id, why);
    }
    for (const [id, why] of round) refused.set(id, why);
    changed = round.size > 0;
    if (!changed) changed = refuseCycles(byId, edges, refused);
  }
  const order = topoOrder([...byId.keys()].filter((id) => !refused.has(id)), edges);
  const deps = new Map([...edges].map(([id, es]) => [id, es.filter((e) => e.hard).map((e) => e.to)]));
  return { order, refused, providers, deps };
}

function pickProviders(candidates: Map<string, string[]>, byId: Map<string, Manifest>, refused: Map<string, string>, providers: Map<string, string>): void {
  providers.clear();
  for (const [sid, ids] of candidates) {
    const id = ids.find((x) => byId.has(x) && !refused.has(x));
    if (id) providers.set(sid, id);
  }
}

function edgesOf(m: Manifest, byId: Map<string, Manifest>, providers: Map<string, string>): Edge[] {
  const out: Edge[] = [];
  if (m.extends) out.push({ to: m.extends, hard: true, why: (s) => `${m.id} extends ${m.extends}, which is ${s}` });
  for (const [dep, r0] of Object.entries(m.requires ?? {})) {
    const r = req(r0);
    const hard = !r.optional;
    if (byId.has(dep) || !providers.has(dep)) out.push({ to: dep, hard, why: (s) => `${m.id} requires ${dep}, which is ${s}` });
    else {
      const p = providers.get(dep) ?? '';
      if (p !== m.id) out.push({ to: p, hard, why: (s) => `${m.id} requires ${dep}, whose provider ${p} is ${s}` });
    }
  }
  return out;
}

interface World {
  byId: Map<string, Manifest>;
  refused: Map<string, string>;
  providers: Map<string, string>;
  off: ReadonlyMap<string, string> | undefined;
}

function stateOf(id: string, w: World): string | undefined {
  if (!w.byId.has(id)) return 'missing';
  if (w.off?.has(id)) return 'off';
  const why = w.refused.get(id);
  return why === undefined ? undefined : `refused (${why})`;
}

function refusalOf(m: Manifest, edges: readonly Edge[], w: World): string | undefined {
  for (const e of edges) {
    const s = e.hard ? stateOf(e.to, w) : undefined;
    if (s) return e.why(s);
  }
  for (const [dep, r0] of Object.entries(m.requires ?? {})) {
    const r = req(r0);
    const provider = w.byId.has(dep) ? undefined : w.providers.get(dep);
    const target = provider ?? dep;
    const version = provider ? w.byId.get(provider)?.provides?.[dep]?.version : w.byId.get(dep)?.version;
    if (r.optional || version === undefined || w.refused.has(target) || provider === m.id) continue;
    if (!satisfies(version, r.version)) return `${m.id} requires ${dep} ${r.version}, but ${provider ? `${provider} provides ` : ''}${version}`;
  }
  return undefined;
}

/** Tarjan's SCCs over hard edges among plugins still in; every plugin on a cycle is refused. */
function refuseCycles(byId: Map<string, Manifest>, edges: Map<string, Edge[]>, refused: Map<string, string>): boolean {
  const live = [...byId.keys()].filter((id) => !refused.has(id));
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  let n = 0;
  let found = false;
  const visit = (v: string): void => {
    index.set(v, n);
    low.set(v, n++);
    stack.push(v);
    on.add(v);
    for (const e of edges.get(v) ?? []) {
      if (!e.hard || refused.has(e.to) || !byId.has(e.to)) continue;
      if (!index.has(e.to)) {
        visit(e.to);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(e.to) ?? 0));
      } else if (on.has(e.to)) low.set(v, Math.min(low.get(v) ?? 0, index.get(e.to) ?? 0));
    }
    if (low.get(v) !== index.get(v)) return;
    const scc: string[] = [];
    for (let w = stack.pop(); w !== undefined; w = stack.pop()) {
      on.delete(w);
      scc.push(w);
      if (w === v) break;
    }
    const self = (edges.get(v) ?? []).some((e) => e.hard && e.to === v);
    if (scc.length > 1 || self) {
      found = true;
      const cycle = cyclePath(scc.reverse(), edges);
      for (const id of scc) refused.set(id, `dependency cycle: ${cycle}`);
    }
  };
  for (const id of live) if (!index.has(id)) visit(id);
  return found;
}

/** 'a → b → a', following hard edges inside the component from its first member. */
function cyclePath(scc: readonly string[], edges: Map<string, Edge[]>): string {
  const inside = new Set(scc);
  const start = scc[0] ?? '';
  const path = [start];
  const seen = new Set([start]);
  for (let at = start; ; ) {
    const next = (edges.get(at) ?? []).find((e) => e.hard && inside.has(e.to) && (e.to === start || !seen.has(e.to)))?.to;
    if (next === undefined) break;
    path.push(next);
    if (next === start) break;
    seen.add(next);
    at = next;
  }
  return path.join(' → ');
}

/**
 * Kahn's algorithm: a plugin is placed once its hard requirements are. Among the ready ones, a plugin
 * whose optional requirements are placed goes first, then registration order: optional edges order
 * the set when they can, and never break a hard one.
 */
function topoOrder(ids: readonly string[], edges: Map<string, Edge[]>): string[] {
  const live = new Set(ids);
  const placed = new Set<string>();
  const out: string[] = [];
  const waitsOn = (id: string, hard: boolean): boolean => (edges.get(id) ?? []).some((e) => e.hard === hard && e.to !== id && live.has(e.to) && !placed.has(e.to));
  while (out.length < ids.length) {
    const ready = ids.filter((id) => !placed.has(id) && !waitsOn(id, true));
    const next = ready.find((id) => !waitsOn(id, false)) ?? ready[0];
    if (next === undefined) break; // only a hard cycle could get here, and those are refused before
    placed.add(next);
    out.push(next);
  }
  return out;
}

/** Everyone who hard-depends on `id`, directly or not, in the order they'd have to go off. */
export function dependentsOf(id: string, deps: ReadonlyMap<string, readonly string[]>): string[] {
  const out: string[] = [];
  const seen = new Set([id]);
  for (let frontier = [id]; frontier.length; ) {
    const next: string[] = [];
    for (const [p, ds] of deps) if (!seen.has(p) && ds.some((d) => frontier.includes(d))) (seen.add(p), next.push(p), out.push(p));
    frontier = next;
  }
  return out;
}
