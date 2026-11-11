// The cold-cache line and Compact now (v1 web/js/cold-cache.js, composer.js coldHtml, actions.js compactItem),
// DOM-free. The peer says (`runtime.cold`) how large an idle task's prompt cache is, when it goes cold and what
// compacting would cost; this decides, at a given time, what the reply box and the task's ⋯ menu say. Only words:
// nothing holds or pauses a send.

export interface ColdCache {
  readonly tokens: number;
  readonly ttlMs: number;
  readonly coldAt: number;
  readonly cold: boolean;
}
export interface CompactOffer {
  readonly tokens: number;
  readonly compact: number | null;
  readonly cold: number | null;
  readonly until: number;
}
export interface ColdOut {
  readonly cache: ColdCache | null;
  readonly compact: CompactOffer | null;
}

type T = (k: string, vars?: Readonly<Record<string, string | number>>) => string;

/** 483214 → "480k" (to the nearest ten thousand, v1 `about`). */
export function about(tokens: number): string {
  const n = Math.round(tokens / 10_000) * 10_000;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

/** The reply box's line once the cache is cold at `now` (the peer's `cold` may be older than the clock). */
export function coldHint(o: ColdOut | undefined, now: number, t: T): { long: string; short: string; title: string } | undefined {
  const c = o?.cache;
  if (!c || !(c.cold || now >= c.coldAt)) return undefined;
  const long = t('shell.cold.line', { about: about(c.tokens) });
  return { long, short: t('shell.cold.short', { about: about(c.tokens) }), title: `${long}. ${t('shell.cold.tip')}` };
}

const usd = (x: number): string => `$${x.toFixed(2)}`;

/** Compact now in the task's ⋯ menu while the cache is warm (until the TTL): its note and tooltip, or nothing. */
export function compactItem(o: ColdOut | undefined, now: number, t: T): { note: string; tip: string } | undefined {
  const c = o?.compact;
  if (!c || now >= c.until) return undefined;
  const priced = c.compact != null && c.cold != null;
  return {
    note: priced ? t('shell.cold.compactNote', { now: usd(c.compact ?? 0), cold: usd(c.cold ?? 0) }) : t('shell.cold.compactSize', { about: about(c.tokens) }),
    tip: priced ? `${t('shell.cold.compactTip')} ${t('shell.cold.compactPlan')}` : t('shell.cold.compactTip'),
  };
}
