// The grammar's words: how a message is cut into tokens, and what's known of harnesses and models.
// Shared by grammar.ts (reading) and grammar-resolve.ts (resolving); not part of the kit's surface.

import type { AgentView, ChannelCtx, MemberView, Mode, ModelView, Problem, ProjectView } from '../index.ts';

export type Ctx = Partial<ChannelCtx>;

export const COLON = /^\s*[:：]/;
export const MARKS = /^[*_~`]+|[*_~`]+$/g;

export interface Token {
  raw: string;
  word: string;
  low: string;
  colon: boolean;
  comma: boolean;
  after: string;
}

// The next word, its own marks and punctuation apart from it.
export function token(s: string): Token {
  const raw = /^\S+/.exec(s)?.[0] || '';
  let w = raw.replace(MARKS, '');
  const colon = /[:：]$/.test(w);
  const comma = /,$/.test(w);
  if (colon || comma) w = w.slice(0, -1).replace(MARKS, '');
  return { raw, word: w, low: w.toLowerCase(), colon, comma, after: s.slice(raw.length).trimStart() };
}

export const lower = (x: unknown): string => String(x || '').toLowerCase();
export const namesOf = (list: readonly { name?: string }[]): string[] => list.map((x) => x.name).filter((n): n is string => !!n);
export const harnesses = (ctx: Ctx): AgentView[] => (ctx.adapters || []).filter((a) => a.id !== 'wisp');
export const placeList = (ctx: Ctx): AgentView[] => [...(ctx.machines || []).flatMap((m) => m.agents || []), ...(ctx.agents || []), ...harnesses(ctx)];
export const modelIds = (a: AgentView): ModelView[] => (a.models || []).filter((m) => m.id);

export const findHarness = (ctx: Ctx, w: string): AgentView | null =>
  harnesses(ctx).find((a) => a.id === w || lower(a.name) === w || lower(a.name).split(' ')[0] === w || (w.length >= 3 && a.id.startsWith(w))) || null;

// Id, label, then prefix (of the id, or the part after a provider's "/").
export function matchModels(a: AgentView, w: string): { tier: number; hits: ModelView[] } {
  const list = modelIds(a);
  const exact = list.filter((m) => lower(m.id) === w);
  if (exact.length) return { tier: 0, hits: exact };
  const label = list.filter((m) => lower(m.label) === w);
  if (label.length) return { tier: 1, hits: label };
  if (w.length < 3) return { tier: 2, hits: [] }; // "with a test" isn't a model
  return { tier: 2, hits: list.filter((m) => lower(m.id).startsWith(w) || (lower(m.id).split('/').pop() ?? '').startsWith(w) || lower(m.label).startsWith(w)) };
}
export const modelKnown = (ctx: Ctx, w: string): boolean => placeList(ctx).some((a) => a.id !== 'wisp' && matchModels(a, w).hits.length > 0);
export const effortKnown = (ctx: Ctx, w: string): boolean => placeList(ctx).some((a) => (a.efforts || []).includes(w) || modelIds(a).some((m) => m.efforts?.includes(w)));

export interface With {
  raw: string;
  agent: string;
  model: string;
  effort: string;
}

export interface Opts {
  crew: MemberView | null;
  tagged: MemberView[];
  project: ProjectView | null;
  machine: string | undefined;
  withs: With | null;
  mode: Mode | null;
  problems: Problem[];
  notes: string[];
  agent?: string | null;
  model?: string | null;
  effort?: string | null;
}

export interface Step {
  rest: string;
  colon?: boolean | undefined;
  stop?: boolean | undefined;
}

export const fresh = (): Opts => ({ crew: null, tagged: [], project: null, machine: undefined, withs: null, mode: null, problems: [], notes: [] });
export const problem = (o: Opts, kind: string, text: string, choices: string[] = []): void => {
  o.problems.push({ kind, text, choices });
};

// Past an in/on that matched nothing: would what follows be options up to a `:`? Then that's what
