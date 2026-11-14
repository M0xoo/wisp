// What each card under a turn says, DOM-free (v1 turns.js limitCard / refusalCard, sign-in-card.js, hold.js,
// what-changed.js + what-changed-line.js, receipt.js). A turn as the store keeps it: the `turn` row with the
// runtime's Turn in `body` (camelCase), its own facts in `body.ext['wisp.runtime']`.

export interface TurnDoc {
  readonly id: string;
  readonly idx: number;
  readonly status: string;
  readonly agent?: string;
  readonly account?: string;
  readonly isError?: boolean;
  readonly text?: string;
  readonly held?: { readonly by: string; readonly kind: string; readonly until?: number | null; readonly data?: { readonly label?: string; readonly why?: string } };
  readonly stats?: { readonly costUsd?: number; readonly inputTokens?: number; readonly outputTokens?: number; readonly cacheTokens?: number; readonly models?: Readonly<Record<string, { readonly input?: number; readonly output?: number; readonly cacheRead?: number; readonly cacheWrite?: number }>> } | null;
  readonly presentation?: { readonly blocks?: readonly { readonly type: string; readonly title?: string; readonly summary?: string; readonly status?: string }[] } | null;
  /** the harness turned it down (runtime's TurnRefusal, v1 `turn.refusal`) */
  readonly refusal?: { readonly agent?: string; readonly model?: string; readonly vendor?: string; readonly kind?: string; readonly line?: string } | null;
  /** it hit its account's usage limit (runtime's TurnLimit, v1 `turn.limit`) */
  readonly limit?: { readonly account?: string; readonly until?: number; readonly others?: readonly { readonly id: string; readonly label: string; readonly kind?: string }[]; readonly kind?: string; readonly extra?: string; readonly waiting?: boolean } | null;
  readonly ext?: {
    readonly 'wisp.runtime'?: { readonly authFailed?: boolean; readonly overage?: { readonly kind?: string } | null; readonly cli?: { readonly version?: string; readonly catalog?: string; readonly models?: Record<string, unknown> } | null };
    /** wisp.budget's shares of the plan windows this turn moved (v1 `turn.plan`) */
    readonly 'wisp.budget'?: { readonly plan?: readonly Share[] };
  };
}

/** A `turn` row's runtime Turn: `body` when the row carries one, else the row itself. */
export function docOf(row: unknown): TurnDoc | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const r = row as { body?: unknown; status?: string; idx?: number; id?: string };
  const b = (r.body && typeof r.body === 'object' ? r.body : r) as TurnDoc;
  return { ...b, status: b.status ?? r.status ?? '', idx: b.idx ?? r.idx ?? 0, id: b.id ?? r.id ?? '' };
}

export type T = (key: string, vars?: Readonly<Record<string, string | number>>) => string;

/** Held before it starts (v1 hold.js): what holds it and why; Start now / Skip release it. */
export function heldOf(d: TurnDoc): { label: string; why: string; until?: number } | null {
  if (d.status !== 'held' || !d.held) return null;
  const label = d.held.data?.label ?? d.held.kind;
  return { label, why: d.held.data?.why ?? '', ...(d.held.until ? { until: d.held.until } : {}) };
}

export type Halt =
  | { kind: 'signedOut' }
  | { kind: 'limit'; text: string; until?: number; extra?: string; waiting?: boolean; others: readonly { id: string; label: string }[] }
  | { kind: 'refused'; text: string; agent: string; model: string; vendor?: string };

/** Why a finished turn stopped short and what it can do next, or null (v1 limitCard, refusalCard, sign-in-card).
 * Only the three v1 had a card for: signed out, the harness's refusal (`turn.refusal`), and a usage limit
 * (`turn.limit`, or an error that says so before the runtime recorded one). Any other failure says itself in the
 * answer (its hero, its blocks, its Try again), so it gets no card. */
export function haltOf(d: TurnDoc): Halt | null {
  if (d.ext?.['wisp.runtime']?.authFailed) return { kind: 'signedOut' };
  if (d.refusal) return { kind: 'refused', text: String(d.refusal.line ?? '').trim(), agent: d.refusal.agent ?? d.agent ?? '', model: d.refusal.model ?? '', ...(d.refusal.vendor && { vendor: d.refusal.vendor }) };
  const hero = d.presentation?.blocks?.find((b) => b.type === 'hero');
  const text = (hero?.summary || d.text || '').trim();
  if (d.limit)
    return { kind: 'limit', text, ...(d.limit.until && { until: d.limit.until }), ...(d.limit.extra && { extra: d.limit.extra }), ...(d.limit.waiting && { waiting: true }), others: (d.limit.others ?? []).map((o) => ({ id: o.id, label: o.label })) };
  if (d.status !== 'error' && !d.isError) return null;
  return /usage limit|rate limit|limit (reached|resets)|out of (credits|usage)|quota/i.test(text) ? { kind: 'limit', text, others: [] } : null;
}

/** What moved in the CLI since the last turn on the same harness and account (v1 what-changed.js, the CLI
 * version and model catalogue), as one line, or null. A turn without the facts says nothing. */
export function whatChanged(turns: readonly TurnDoc[], d: TurnDoc, name: string): string | null {
  const cur = d.ext?.['wisp.runtime']?.cli;
  if (!cur) return null;
  const same = (x: TurnDoc): boolean => (x.agent ?? '') === (d.agent ?? '') && (x.account ?? 'default') === (d.account ?? 'default');
  const prev = [...turns]
    .filter((x) => x.idx < d.idx && same(x) && x.ext?.['wisp.runtime']?.cli)
    .sort((a, b) => b.idx - a.idx)[0]?.ext?.['wisp.runtime']?.cli;
  if (!prev) return null;
  const parts: string[] = [];
  if (prev.version && cur.version && prev.version !== cur.version) parts.push(`${name} ${prev.version} → ${cur.version}`);
  if (prev.catalog && cur.catalog && prev.catalog !== cur.catalog) {
    const was = Object.keys(prev.models ?? {});
    const now = Object.keys(cur.models ?? {});
    const added = now.filter((m) => !was.includes(m));
    const removed = was.filter((m) => !now.includes(m));
    const detail = [added.length ? `${added.join(', ')} added` : '', removed.length ? `${removed.join(', ')} removed` : ''].filter(Boolean).join(', ');
    parts.push(`${name} model catalog changed${detail ? ` (${detail})` : ''}`);
  }
  return parts.length ? `Since the last turn: ${parts.join(', ')}.` : null;
}

export interface Share {
  readonly agent?: string;
  readonly account?: string;
  readonly window: string;
  /** 0–1 of that window */
  readonly used: number;
}

const DAY = 864e5;
const NAMES: Readonly<Record<string, string>> = { five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'weekly Opus', seven_day_sonnet: 'weekly Sonnet' };
const LENGTH: Readonly<Record<string, number>> = { seven_day: 7 * DAY, seven_day_opus: 7 * DAY - 1, seven_day_sonnet: 7 * DAY - 2, five_hour: 5 * 36e5 };
const lengthOf = (id: string): number => LENGTH[id] ?? (Number(/^w(\d+)m$/.exec(id)?.[1]) * 60_000 || 0);

/** A plan window's name (v1 receipt.js windowName): weekly, 5-hour, 2-day, plan. */
export function windowName(id: string): string {
  const named = NAMES[id];
  if (named) return named;
  const mins = Number(/^w(\d+)m$/.exec(id)?.[1]) || 0;
  return !mins ? 'plan' : mins >= 1440 ? `${Math.round(mins / 1440)}-day` : `${Math.round(mins / 60)}-hour`;
}

/** "<1%" for a share too small to round to one, and never "100%" for one that isn't all of it. */
export const pct = (x: number): string => (x > 0 && x < 0.005 ? '<1%' : x < 1 && x > 0.99 ? '99%' : `${Math.round(x * 100)}%`);

/** 38400 → "38k", 1250000 → "1.3M", 820 → "820" (v1 tokenWords). */
export function tokenWords(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

export const OVERAGE: Readonly<Record<string, { readonly label: string; readonly tip: string }>> = {
  extra: { label: 'shell-task.receipt.overage.extra', tip: 'shell-task.receipt.overage.extraTip' },
  credits: { label: 'shell-task.receipt.overage.extra', tip: 'shell-task.receipt.overage.creditsTip' },
  api: { label: 'shell-task.receipt.overage.api', tip: 'shell-task.receipt.overage.apiTip' },
  profile: { label: 'shell-task.receipt.overage.profile', tip: 'shell-task.receipt.overage.profileTip' },
};

export interface ReceiptLine {
  /** the quiet parts after the turn's token count: "71% cache", "3% of weekly", "Past your plan" */
  readonly parts: string[];
  /** every window and the whole count, for the title */
  readonly tip: string;
}

/** The usage receipt (v1 receipt.js receiptOf + receiptParts): the share of what the turn read that came from
 * the cache (Claude's per-model counts; the runtime folds reads and writes together otherwise, so no share),
 * its share of the account's longest plan window, and Past your plan when it was billed beyond it. The token
 * count itself is the turn's stats line (the frame's). null when there's nothing to add. */
export function receiptOf(d: TurnDoc, t: T): ReceiptLine | null {
  const n = (x: number | undefined): number => (Number.isFinite(x) && (x ?? 0) > 0 ? (x ?? 0) : 0);
  const models = Object.values(d.stats?.models ?? {});
  const m = models.reduce<{ read: number; cached: number; output: number }>((a, x) => ({ read: a.read + n(x.input) + n(x.cacheRead) + n(x.cacheWrite), cached: a.cached + n(x.cacheRead), output: a.output + n(x.output) }), { read: 0, cached: 0, output: 0 });
  const read = Math.max(m.read, n(d.stats?.inputTokens) + n(d.stats?.cacheTokens));
  const tokens = read + Math.max(m.output, n(d.stats?.outputTokens));
  const cache = m.read && m.cached ? m.cached / m.read : null;
  const by = new Map<string, number>();
  for (const p of d.ext?.['wisp.budget']?.plan ?? []) if (p.window && p.used > 0) by.set(p.window, (by.get(p.window) ?? 0) + p.used);
  const plan = [...by].map(([window, used]) => ({ window, used })).sort((a, b) => lengthOf(b.window) - lengthOf(a.window));
  const over = OVERAGE[d.ext?.['wisp.runtime']?.overage?.kind ?? ''];
  const parts = [cache !== null && tokens ? t('shell-task.receipt.cache', { pct: pct(cache) }) : '', plan[0] ? t('shell-task.receipt.share', { pct: pct(plan[0].used), window: windowName(plan[0].window) }) : '', over ? t(over.label) : ''].filter(Boolean);
  if (!parts.length) return null;
  const tip = [
    tokens ? t('shell-task.receipt.tokens', { n: tokens.toLocaleString('en-US') }) : '',
    cache !== null ? t('shell-task.receipt.cacheTip', { pct: pct(cache) }) : '',
    plan.map((p) => t('shell-task.receipt.shareTip', { pct: pct(p.used), window: windowName(p.window) })).join(', '),
    over ? t(over.tip) : '',
  ].filter(Boolean);
  return { parts, tip: tip.join('. ') };
}
