// Pure helpers v1 shared between the server and the page (web/js/core/format.js haltOf,
// web/js/vendors.js vendorOf, web/js/cold-cache.js compactOffer). The summary and the runner need
// them; the page's copies live with the UI.

import type { Session, Turn } from './model.ts';

/** The row's word for a turn that failed, hit a limit or was refused (format.js haltOf). */
export const haltOf = (t: Turn | undefined): string =>
  t?.limit ? 'limit' : t?.signedOut && !t.signedOut.stillIn ? 'signedOut' : t?.refusal || t?.devices ? 'refused' : t?.status === 'error' ? 'failed' : '';

// Model id → vendor (vendors.js). Ids come as "claude-sonnet-4.5", "anthropic/claude-…", "openrouter/openai/gpt-5", "o4-mini", "opus".
const VENDORS: readonly (readonly [string, RegExp])[] = [
  ['anthropic', /claude|anthropic|(?:^|[/:\s_-])(?:opus|sonnet|haiku)(?:$|[/:\s._-]|\d)/i],
  ['openai', /openai|chatgpt|gpt|codex|(?:^|[/:\s_-])o\d(?:$|[/:\s._-])/i],
  ['google', /gemini|gemma|google|vertex/i],
  ['xai', /grok|xai|x-ai/i],
  ['deepseek', /deepseek/i],
  ['alibaba', /qwen/i],
  ['moonshot', /kimi|moonshot/i],
  ['zhipu', /glm|zhipu|z-ai/i],
  ['mistral', /mistral|codestral|devstral/i],
  ['meta', /llama/i],
  ['cursor', /(?:^|[/:\s_-])composer/i],
];
// What a harness runs when it isn't given a model: only the single-vendor ones are sure.
const HOME: Record<string, string> = { claude: 'anthropic', codex: 'openai', grok: 'xai' };

export function vendorOf(model: unknown, agent: string): string {
  const m = String(model ?? '').trim();
  if (m && !/^(?:auto|default)$/i.test(m)) {
    for (const [v, re] of VENDORS) if (re.test(m)) return v;
  }
  return HOME[agent] ?? '';
}

// ---------- Compact now (cold-cache.js) ----------

export const LARGE = 100_000;
export const GRACE = 1.25;
export const COMPACT_MIN = 200_000;
const COMPACT_OUTPUT = 20_000;
const COMPACT_WRITE = 30_000;
const PRICES: Record<string, readonly [number, number, number]> = {
  'claude-opus-5-5': [4, 0.2, 20],
  'claude-sonnet-5-5': [2, 0.2, 10],
  'claude-fable-5-1': [10, 0.25, 50],
  'claude-fable-5': [10, 0.25, 50],
};
const WRITE_1H = 2;
const WRITE_5M = 1.25;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
export const bareModel = (id: unknown): string => String(id ?? '').replace(/\[1m\]$/i, '').replace(/-\d{8}$/, '');

interface ModelUse {
  model?: string;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export function mainModel(st: Record<string, unknown> | null | undefined): string {
  const subsList = Array.isArray(st?.['subagents']) ? (st['subagents'] as { same?: boolean; model?: string }[]) : [];
  const subs = new Set(subsList.filter((x) => !x.same && x.model).map((x) => bareModel(x.model)));
  const models = Array.isArray(st?.['models']) ? (st['models'] as ModelUse[]) : [];
  const read = (m: ModelUse): number => num(m.input) + num(m.cacheRead) + num(m.cacheWrite);
  return models.map((m) => ({ id: bareModel(m.model), read: read(m) })).filter((m) => !subs.has(m.id)).sort((a, b) => b.read - a.read)[0]?.id ?? '';
}

export function coldCache(s: Session, at: number): { tokens: number; ttlMs: number; coldAt: number; cold: boolean } | null {
  if (!s?.agentSessionId || s.tui || s.state === 'running' || s.ask) return null;
  const turns = s.turns ?? [];
  if (turns.some((t) => t.status === 'running' || t.status === 'held')) return null;
  const from = turns.findLastIndex((t) => num(t.stats?.['contextTokens']) && num(t.stats?.['cacheTtlMs']));
  if (from < 0) return null;
  const [numbered, ...later] = turns.slice(from);
  if (!numbered) return null;
  if (later.some((t) => num(t.stats?.['outputTokens']) > 0 || t.stats?.['contextTokens'] === 0)) return null;
  const ended = [numbered, ...later].filter((t) => t.endedAt);
  if (!ended.length) return null;
  const agentOf = (t: Turn): string => t.agent || s.agent;
  if (agentOf(numbered) !== s.agent || agentOf(ended[ended.length - 1] as Turn) !== s.agent) return null;
  const tokens = num(numbered.stats?.['contextTokens']);
  const ttlMs = num(numbered.stats?.['cacheTtlMs']);
  if (tokens < LARGE) return null;
  const coldAt = Math.max(...ended.map((t) => t.endedAt ?? 0)) + ttlMs * GRACE;
  return { tokens, ttlMs, coldAt, cold: at >= coldAt };
}

export function compactUntil(s: Session, at: number): number {
  const c = coldCache(s, at);
  return c ? c.coldAt - c.ttlMs * (GRACE - 1) : 0;
}

export function compactOffer(s: Session, at: number): { tokens: number; compact: number | null; cold: number | null } | null {
  if (s?.agent !== 'claude' || s.sideOf || s.parentId || s.delegated || s.relay || s.kind || s.tui) return null;
  const c = coldCache(s, at);
  if (!c || c.tokens < COMPACT_MIN || at >= compactUntil(s, at)) return null;
  const last = s.turns[s.turns.length - 1];
  const compactStats = last?.stats?.compact as { none?: boolean } | undefined;
  if (!last || last.limit || compactStats?.none) return null;
  const numbered = s.turns.findLast((t) => num(t.stats?.['contextTokens']) && num(t.stats?.['cacheTtlMs']));
  const price = PRICES[mainModel(numbered?.stats)];
  if (!price) return { tokens: c.tokens, compact: null, cold: null };
  const [input, read, output] = price;
  const write = input * (c.ttlMs > 300_000 ? WRITE_1H : WRITE_5M);
  return { tokens: c.tokens, compact: (c.tokens * read + COMPACT_OUTPUT * output + COMPACT_WRITE * write) / 1e6, cold: (c.tokens * write) / 1e6 };
}
