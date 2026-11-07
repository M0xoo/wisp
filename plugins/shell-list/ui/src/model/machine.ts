// The top bar's This Mac chip and a task row's RAM (v1 web/js/machine-view.js chipOf, resText;
// design/machine-page.md). Pure: the chip shows only when it matters (memory near the floor, work
// held, automations paused, processes left behind). Its short form is the number; the long form
// ("12% memory · 9 running") lives in its tooltip and popover (design/layout.md §2).

import type { Load, Row, SessionRow } from '../types.ts';

export const FLOOR_DEFAULT = 15;
/** within this many points of the floor, memory is tight */
export const TIGHT = 10;

export type ChipTone = 'neutral' | 'warn' | 'bad';

export type Chip =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'memory'; readonly free: number | null; readonly runs: number; readonly tone: ChipTone; readonly why: readonly Why[] }
  | { readonly kind: 'paused'; readonly until: number; readonly tone: ChipTone; readonly why: readonly Why[] }
  | { readonly kind: 'left'; readonly n: number; readonly tone: ChipTone; readonly why: readonly Why[] };

/** One sentence of the long form, as an i18n key and its vars. */
export interface Why {
  readonly key: string;
  readonly vars?: Readonly<Record<string, string | number>>;
}

export function chipOf(load: Row<Load> | undefined, now: number): Chip {
  if (!load) return { kind: 'hidden' };
  const floor = load.floor ?? FLOOR_DEFAULT;
  const free = load.memFreePct;
  const tight = free !== null && free < floor + TIGHT;
  const held = !!load.held && load.held.kind !== 'paused';
  const paused = !!load.pausedUntil && load.pausedUntil > now;
  const left = load.left ?? 0;
  if (!tight && !held && !paused && left === 0) return { kind: 'hidden' };
  const why: Why[] = [];
  if (held && load.held) why.push({ key: 'list.chip.held', vars: { why: load.held.why } });
  if (paused && load.pausedUntil) why.push({ key: 'list.chip.why-paused', vars: { at: load.pausedUntil } });
  if (left > 0) why.push({ key: 'list.chip.why-left', vars: { count: left } });
  const tone: ChipTone = free !== null && free < floor ? 'bad' : tight || held ? 'warn' : 'neutral';
  if (tight || held) return { kind: 'memory', free, runs: load.runs, tone, why };
  if (paused && load.pausedUntil) return { kind: 'paused', until: load.pausedUntil, tone, why };
  return { kind: 'left', n: left, tone, why };
}

/** The computer's name for the chip and the pane: This Mac, This PC, This computer. */
export const machineLabelKey = (platform: string | undefined): string =>
  platform === 'darwin' ? 'list.here.mac' : platform === 'win32' ? 'list.here.pc' : 'list.here.computer';

/** "3.4 GB": under 1 MB in KB (at least 1), under 1 GB in whole MB, under 10 GB one decimal. */
export function size(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (mb < 1024) return `${Math.round(mb)} MB`;
  const gb = mb / 1024;
  return gb < 10 ? `${gb.toFixed(1)} GB` : `${Math.round(gb)} GB`;
}

/** A running task heavy on this computer (the server sets `res` over 500 MB or 50% CPU): its RAM. */
export const resText = (s: SessionRow): string => (s.state === 'running' && s.res && s.res.rss > 0 ? size(s.res.rss) : '');
