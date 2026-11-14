// The top bar's Update pill (v1 web/js/features/update.js renderUpdate / installUpdate), as pure decisions so
// each v1 behaviour has a test: when it shows and what it says, what a failed install offers, and when the page
// reloads onto the new wisp.

import { t } from './i18n.ts';
import type { UpdateState } from './types.ts';

type Row = Pick<UpdateState, 'available' | 'status' | 'latest' | 'current'>;

export interface PillView {
  /** in the bar: the version alone, beside the update icon (design/layout.md: a control, not a sentence) */
  readonly text: string;
  /** its accessible name: Update to 2.1.0, Updating…, Restarting… */
  readonly label: string;
  /** v1 title: wisp 2.0.0 → 2.1.0: install and restart */
  readonly title: string;
  /** installing or restarting: dimmed, not pressable */
  readonly busy: boolean;
}

/** v1: hidden unless a newer wisp is out or an install is under way. */
export function pillOf(u: Row | undefined): PillView | undefined {
  if (!u) return undefined;
  const busy = u.status !== 'idle';
  if (!u.available && !busy) return undefined;
  const latest = u.latest ?? '';
  const label = u.status === 'installing' ? t('update.updating') : u.status === 'restarting' ? t('update.restarting') : t('update.pill', { latest });
  return { text: latest, label, title: t('update.pill.title', { current: u.current, latest }), busy };
}

/** What a failed install's toast offers: the desktop app opens its downloads page, the others copy the command. */
export function failureAction(u: Pick<UpdateState, 'method' | 'command'>): { readonly kind: 'open' | 'copy'; readonly target: string } | undefined {
  if (!u.command) return undefined;
  return { kind: u.method === 'app' ? 'open' : 'copy', target: u.command };
}

/** v1 polled /health until the version changed, then reloaded. v2's row comes back on its own once the new wisp
 * is up: reload when it reports another version than the one that was restarting. */
export const cameBack = (from: string | undefined, u: Pick<UpdateState, 'current'> | undefined): boolean =>
  from !== undefined && u !== undefined && u.current !== from;

/** One row change while watching a restart. `from` is the version that was restarting: set as the row enters
 * `restarting` (again, on a retry: a new wait), reload once another version answers, and let go when the same
 * version comes back idle (the restart didn't take), so a later, unrelated version change never reloads. */
export function restartStep(
  from: string | undefined,
  prev: Pick<UpdateState, 'status'> | undefined,
  u: Pick<UpdateState, 'status' | 'current'> | undefined,
): { readonly from: string | undefined; readonly reload: boolean; readonly wait: boolean } {
  if (cameBack(from, u)) return { from: undefined, reload: true, wait: false };
  if (!u) return { from, reload: false, wait: false }; // the row away while wisp restarts
  if (u.status === 'restarting') return prev?.status === 'restarting' && from !== undefined ? { from, reload: false, wait: false } : { from: u.current, reload: false, wait: true };
  return { from: undefined, reload: false, wait: false };
}

/** v1 gave up after two minutes with "wisp did not come back". */
export const BACK_WITHIN_MS = 120_000;

export const notBack = (u: Pick<UpdateState, 'method'>): string => (u.method === 'app' ? t('update.notBack.app') : t('update.notBack'));
