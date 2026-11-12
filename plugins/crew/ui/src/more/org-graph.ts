// Org's shape (v1 org.js graph, tiers): who hands work to whom among the members that exist, and
// the tiers the chart lays them in. Pure; the rows go by id.

import type { TeamRow } from './types.ts';

export interface OrgMember {
  id: string;
  name: string;
  role: string;
  agent: string;
  team: readonly TeamRow[];
}

export interface Graph {
  out: Map<string, string[]>;
  inc: Map<string, string[]>;
}

/** Crew delegates only, and only members that exist: a delegate that left is no arrow. */
export function graph(list: readonly OrgMember[]): Graph {
  const ids = new Set(list.map((m) => m.id));
  const out = new Map(list.map((m) => [m.id, (m.team ?? []).flatMap((t) => (t.crew && t.crew !== m.id && ids.has(t.crew) ? [t.crew] : []))]));
  const inc = new Map<string, string[]>(list.map((m) => [m.id, []]));
  for (const [a, bs] of out) for (const b of bs) inc.get(b)?.push(a);
  return { out, inc };
}

const linked = (g: Graph, id: string): boolean => (g.out.get(id)?.length ?? 0) > 0 || (g.inc.get(id)?.length ?? 0) > 0;

/**
 * Tiers, top down: a member sits one below the deepest member that delegates to it (a loop's way
 * back up is ignored); within a tier, under the members that delegate to it, so arrows cross less.
 * Members with no links at all are left out (they get their own row: `alone`).
 */
export function tiers<M extends { id: string }>(list: readonly M[], g: Graph): M[][] {
  const mine = list.filter((m) => linked(g, m.id));
  const depth = new Map<string, number>();
  const path = new Set<string>();
  const visit = (id: string, d: number): void => {
    if (path.has(id) || (depth.get(id) ?? -1) >= d) return;
    depth.set(id, d);
    path.add(id);
    for (const b of g.out.get(id) ?? []) visit(b, d + 1);
    path.delete(id);
  };
  for (const m of mine) if (!(g.inc.get(m.id)?.length ?? 0)) visit(m.id, 0);
  for (const m of mine) if (!depth.has(m.id)) visit(m.id, 0); // a loop with nobody above it
  const rows: M[][] = [];
  for (const m of mine) (rows[depth.get(m.id) ?? 0] ??= []).push(m);
  const at = new Map<string, number>();
  return rows.filter(Boolean).map((row, t) => {
    const mean = (m: M): number => {
      const up = (g.inc.get(m.id) ?? []).filter((x) => at.has(x));
      return up.length ? up.reduce((n, x) => n + (at.get(x) ?? 0), 0) / up.length : Infinity;
    };
    const keyed = row.map((m, i) => ({ m, i, k: t ? mean(m) : i }));
    keyed.sort((a, b) => a.k - b.k || a.i - b.i);
    keyed.forEach((x, i) => at.set(x.m.id, i));
    return keyed.map((x) => x.m);
  });
}

export const alone = <M extends { id: string }>(list: readonly M[], g: Graph): M[] => list.filter((m) => !linked(g, m.id));

/** `from`'s team with `to` as a crew delegate (unchanged when it's there, or the same member). */
export function linkTeam(from: OrgMember, to: OrgMember): TeamRow[] | undefined {
  if (from.id === to.id || from.team.some((t) => t.crew === to.id)) return undefined;
  return [...from.team, { crew: to.id, name: to.name, label: to.name, role: to.role, agent: to.agent, model: '', effort: '', use: to.role, count: 1 }];
}

export const unlinkTeam = (from: OrgMember, to: string): TeamRow[] => from.team.filter((t) => t.crew !== to);

/** Members `m` may still add as a delegate. */
export const freeFor = <M extends OrgMember>(list: readonly M[], m: OrgMember): M[] => list.filter((c) => c.id !== m.id && !m.team.some((t) => t.crew === c.id));
