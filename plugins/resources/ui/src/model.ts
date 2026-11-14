// Settings → Setup (ADR-0034): your setup as code. DOM-free: the kinds with how many of each you have, the Import
// plan as cards (added, changed, removed, each in words, a change with its fields), what's picked to apply, and
// the format a pasted text is in.

export interface Resource {
  readonly kind: string;
  readonly name: string;
  readonly spec: unknown;
}
export interface Op {
  readonly op: 'create' | 'update' | 'delete';
  readonly kind: string;
  readonly name: string;
  readonly spec: unknown;
  readonly changes?: readonly { readonly path: string; readonly from?: unknown; readonly to?: unknown }[];
}
export interface Plan {
  readonly ops: readonly Op[];
  readonly unchanged: number;
  readonly missing_secrets?: readonly string[];
  readonly sensitive?: readonly string[];
  readonly problems?: readonly string[];
}
export interface KindInfo {
  readonly kind: string;
  readonly section: string;
  readonly scope: string;
  readonly order: number;
}

type T = (k: string, vars?: Readonly<Record<string, string | number>>) => string;

/** Shared kinds in their order, each with how many of it the export holds; personal and device kinds left out. */
export function kindCounts(kinds: readonly KindInfo[], have: readonly Resource[]): { kind: string; section: string; count: number }[] {
  return [...kinds]
    .filter((k) => k.scope === 'shared')
    .sort((a, b) => a.order - b.order)
    .map((k) => ({ kind: k.kind, section: k.section, count: have.filter((r) => r.kind === k.kind).length }))
    .filter((k) => k.count > 0);
}

/** YAML unless it plainly is JSON (starts with `{`) or TOML (`wisp = 1`). */
export function formatOf(text: string): 'yaml' | 'json' | 'toml' {
  const s = text.trimStart();
  if (s.startsWith('{')) return 'json';
  if (/^wisp\s*=\s*\d/m.test(s)) return 'toml';
  return 'yaml';
}

export const keyOf = (o: Pick<Op, 'kind' | 'name'>): string => `${o.kind}/${o.name}`;

/** The plan's cards, grouped as v1's plan reads: added, changed, removed. */
export function groups(plan: Plan): { id: 'create' | 'update' | 'delete'; ops: Op[] }[] {
  return (['create', 'update', 'delete'] as const).map((id) => ({ id, ops: plan.ops.filter((o) => o.op === id) })).filter((g) => g.ops.length > 0);
}

const short = (v: unknown): string => {
  if (v === undefined || v === null) return '—';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
};

/** A change's fields in words: `model: sonnet → opus`. */
export function changeLines(o: Op): string[] {
  return (o.changes ?? []).map((c) => `${c.path.replace(/^\//, '').replace(/\//g, '.')}: ${short(c.from)} → ${short(c.to)}`);
}

/** The card's title: "crew ada". */
export const opTitle = (o: Op, t: T): string => t(`resources.op.${o.op}`, { kind: o.kind, name: o.name });

/** What Apply sends: the pasted resources whose ops are still ticked (a delete only comes from prune, never here). */
export function picked(resources: readonly Resource[], plan: Plan, off: ReadonlySet<string>): Resource[] {
  const want = new Set(plan.ops.filter((o) => o.op !== 'delete' && !off.has(keyOf(o))).map(keyOf));
  return resources.filter((r) => want.has(keyOf(r)));
}
