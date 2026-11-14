// The transcript's pure half (v1 features/transcript.js, turns.js): which events belong to which
// turn, which of them are the final answer (shown as blocks, not as a message), how a long run of
// steps folds, and how a turn is drawn. No DOM and no signals, so it is tested exhaustively.
import type { EventRow, TurnRow } from '../types.ts';

type Ev<K extends EventRow['kind']> = Extract<EventRow, { kind: K }>;

/** One row of a turn's timeline. `key` is stable while the turn grows (the first event's seq). */
export type Step =
  | { readonly k: 'msg'; readonly key: string; readonly ev: Ev<'text'> }
  | { readonly k: 'thinking'; readonly key: string; readonly ev: Ev<'thinking'> }
  | { readonly k: 'tool'; readonly key: string; readonly ev: Ev<'tool'>; readonly output: string | undefined }
  | { readonly k: 'error'; readonly key: string; readonly ev: Ev<'tool_error'> }
  | { readonly k: 'blocked'; readonly key: string; readonly ev: Ev<'blocked'> }
  | { readonly k: 'notice'; readonly key: string; readonly ev: Ev<'notice'> };
export type Row = Step | { readonly k: 'fold'; readonly key: string; readonly steps: readonly Step[] };

/** A run of steps longer than this shows KEEP at each end and folds the middle (v1 layout()). */
export const FOLD_AT = 12;
export const KEEP = 4;
/** Characters of a long prompt laid out before Show all (v1 PROMPT_CUT). */
export const PROMPT_CUT = 4000;
/** A prompt longer than this, or with more lines, is clamped with Show all. */
export const PROMPT_LONG = 360;
export const PROMPT_LINES = 5;

/**
 * Events by turn, oldest first. A turn whose events didn't change keeps its array (the same
 * reference), so only the turn that grew repaints: pass the previous answer as `prev`.
 */
export function byTurn(events: readonly EventRow[], prev?: ReadonlyMap<string, readonly EventRow[]>): Map<string, readonly EventRow[]> {
  const out = new Map<string, EventRow[]>();
  for (const e of events) {
    const list = out.get(e.turn_id);
    if (list) list.push(e);
    else out.set(e.turn_id, [e]);
  }
  if (!prev) return out;
  const kept = new Map<string, readonly EventRow[]>();
  for (const [id, list] of out) {
    const was = prev.get(id);
    kept.set(id, was && sameItems(was, list) ? was : list);
  }
  return kept;
}

export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A message as it reads mid-run: the wisp presentation it ends with is on its way, not prose. */
export function messageText(text: string): string {
  const open = text.search(/```wisp/);
  return (open < 0 ? text : text.slice(0, open)).trim();
}

/**
 * The seqs of the trailing messages that are the final answer (v1 finalAnswer): the turn's `text`
 * holds them, so they show as the answer's blocks and leave the timeline.
 */
export function finalAnswer(turn: Pick<TurnRow, 'text' | 'status'>, events: readonly EventRow[]): Set<number> {
  const out = new Set<number>();
  const raw = turn.text ?? '';
  if (!raw.trim() || turn.status === 'running') return out;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) break;
    if (e.kind === 'notice') continue; // wisp's own note after the answer doesn't break the run
    const head = e.kind === 'text' ? e.text.trim().slice(0, 200) : '';
    if (!head || !raw.includes(head)) break;
    out.add(e.seq);
  }
  return out;
}

/** A turn's events as timeline steps: tool output joins its call, the final answer leaves. */
export function stepsOf(turn: Pick<TurnRow, 'text' | 'status'>, events: readonly EventRow[]): Step[] {
  const skip = finalAnswer(turn, events);
  const outputs = new Map<string, string>();
  for (const e of events) if (e.kind === 'tool_output') outputs.set(e.callId, (outputs.get(e.callId) ?? '') + e.text);
  const out: Step[] = [];
  for (const e of events) {
    if (skip.has(e.seq)) continue;
    const key = String(e.seq);
    switch (e.kind) {
      case 'text':
        if (messageText(e.text) !== '') out.push({ k: 'msg', key, ev: e });
        break;
      case 'thinking':
        out.push({ k: 'thinking', key, ev: e });
        break;
      case 'tool':
        out.push({ k: 'tool', key, ev: e, output: e.output ?? (e.callId === undefined ? undefined : outputs.get(e.callId)) });
        break;
      case 'tool_output':
        break; // shown under its call
      case 'tool_error':
        out.push({ k: 'error', key, ev: e });
        break;
      case 'blocked':
        out.push({ k: 'blocked', key, ev: e });
        break;
      case 'notice':
        out.push({ k: 'notice', key, ev: e });
        break;
    }
  }
  return out;
}

/** Steps between two messages, in runs: a run longer than FOLD_AT keeps KEEP at each end. */
export function layout(steps: readonly Step[], unfolded: ReadonlySet<string> = new Set()): Row[] {
  const out: Row[] = [];
  let run: Step[] = [];
  const flush = (): void => {
    const foldKey = run.length > FOLD_AT ? `fold:${run[KEEP]?.key ?? ''}` : '';
    if (foldKey && !unfolded.has(foldKey)) out.push(...run.slice(0, KEEP), { k: 'fold', key: foldKey, steps: run.slice(KEEP, -KEEP) }, ...run.slice(-KEEP));
    else out.push(...run);
    run = [];
  };
  for (const s of steps) {
    if (s.k === 'msg') {
      flush();
      out.push(s);
    } else run.push(s);
  }
  flush();
  return out;
}

/** How many messages and steps a timeline holds (its head's count). */
export function counts(steps: readonly Step[]): { messages: number; steps: number } {
  let messages = 0;
  for (const s of steps) if (s.k === 'msg') messages++;
  return { messages, steps: steps.length - messages };
}

/** Whether a step opens to more: a command and what it printed, an error in full, a thought. */
export function opens(s: Step): boolean {
  switch (s.k) {
    case 'tool':
      return !!(s.output || s.ev.detail);
    case 'error':
      return s.ev.text !== '';
    case 'thinking':
      return !!s.ev.text;
    default:
      return false;
  }
}

/** The command a run step shows, unless its label already says it (v1 stepHtml `cmd`). */
export function commandOf(s: Step): string {
  if (s.k !== 'tool' || s.ev.tool !== 'run' || !s.ev.detail) return '';
  const flat = s.ev.detail.replace(/\s+/g, ' ').trim();
  return s.ev.label.replace(/\s+/g, ' ').includes(flat.slice(0, 24)) ? '' : flat;
}

/** What a turn's article draws. */
export type TurnView = 'held' | 'running' | 'compact' | 'folded' | 'open';

/**
 * Older turns fold to one line (v1 renderFoldedTurn); the latest is open; a turn opened by hand
 * stays open; under a Compact now the answer before it stays open (nothing moves on the click).
 */
export function viewOf(turn: Pick<TurnRow, 'id' | 'status' | 'by'>, latest: boolean, unfolded: ReadonlySet<string>, keepOpen: string | undefined): TurnView {
  if (turn.status === 'held') return 'held';
  if (turn.status === 'running') return turn.by === 'compact' ? 'compact' : 'running';
  if (turn.by === 'compact') return latest || unfolded.has(turn.id) ? 'compact' : 'folded';
  return latest || unfolded.has(turn.id) || keepOpen === turn.id ? 'open' : 'folded';
}

/** The answer a trailing Compact now keeps open: the last turn before it that isn't a compact. */
export function keptOpen(turns: readonly Pick<TurnRow, 'id' | 'by'>[]): string | undefined {
  if (turns.at(-1)?.by !== 'compact') return undefined;
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i]?.by !== 'compact') return turns[i]?.id;
  return undefined;
}

/** A prompt clamped behind Show all: long, or many lines. */
export function promptIsLong(text: string): boolean {
  return text.length > PROMPT_LONG || text.split('\n').length > PROMPT_LINES;
}

/** Where a timeline ends (v1 endLabel). */
export function endOf(turn: Pick<TurnRow, 'status' | 'presentation'>): { label: 'error' | 'stopped' | 'interrupted' | 'finished'; icon: 'warn' | 'stop' | 'check' } {
  if (turn.status === 'error') return { label: 'error', icon: 'warn' };
  if (turn.status === 'stopped') {
    const first = turn.presentation?.blocks[0] as { title?: unknown } | undefined;
    return { label: first?.title === 'Interrupted' ? 'interrupted' : 'stopped', icon: 'stop' };
  }
  return { label: 'finished', icon: 'check' };
}

/** v1 fmtDuration: 400ms, 12s, 3m 04s, 1h 12m. */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return `${Math.max(0, Math.round(ms))}ms`;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The hero's title, for a folded turn's one line. */
export function heroTitle(turn: Pick<TurnRow, 'presentation'>): string {
  for (const b of turn.presentation?.blocks ?? []) {
    const o = b as { type?: unknown; title?: unknown };
    if (o.type === 'hero' && typeof o.title === 'string') return o.title;
  }
  return '';
}

/** What a Compact now turn said (its markdown), or the default. */
export function compactSaid(turn: Pick<TurnRow, 'presentation'>): string {
  for (const b of turn.presentation?.blocks ?? []) {
    const o = b as { type?: unknown; text?: unknown };
    if (o.type === 'markdown' && typeof o.text === 'string') return o.text;
  }
  return '';
}

/** The non-message steps a live panel ticks through: the last five, newest first. */
export function ticker(steps: readonly Step[], n = 5): Step[] {
  const out: Step[] = [];
  for (let i = steps.length - 1; i >= 0 && out.length < n; i--) {
    const s = steps[i];
    if (s && s.k !== 'msg') out.push(s);
  }
  return out;
}
