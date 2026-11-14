// What the reply box says before you type (v1 composer.js updateDock): it tells you what Send will
// do. The owner's words for a running task without Queue: "Steer Claude Code — interrupts and sends
// now. /btw asks without interrupting". Pure: the copy is an i18n key and its vars.

import type { Ask } from '../types.ts';

export interface PlaceholderInput {
  /** the tour: a demo task, nothing to send */
  readonly tour?: boolean;
  readonly ask?: Ask | null | undefined;
  /** open in the agent's terminal */
  readonly tui?: boolean;
  readonly running: boolean;
  readonly done: boolean;
  /** Queue on: follow-ups wait for the run */
  readonly queue: boolean;
  /** the task's harness, and the one picked for the next follow-up */
  readonly name: string;
  readonly next: string;
  /** add the /btw suffix (v1 leaves it out while the working panel's /btw tip shows) */
  readonly btw: boolean;
  /** comments waiting to go with the next follow-up */
  readonly comments?: number;
}

export interface Copy {
  readonly key: string;
  readonly vars: Readonly<Record<string, string | number>>;
}

const K = 'shell-composer.ph';

export function placeholder(i: PlaceholderInput): Copy {
  const vars = { name: i.name, next: i.next };
  const suffix = i.btw ? '.btw' : '';
  if (i.tour) return { key: `${K}.tour`, vars };
  if (i.ask?.kind === 'clash') return { key: i.ask.by ? `${K}.clash-its` : `${K}.clash-main`, vars };
  if (i.ask?.kind === 'permission') return { key: `${K}.permission`, vars };
  if (i.ask) return { key: `${K}.question`, vars };
  if (i.comments) return { key: `${K}.comments`, vars: { count: i.comments } };
  if (i.tui) return { key: `${K}.terminal`, vars };
  const switched = i.next !== i.name;
  if (i.running && i.queue) return { key: `${K}.${switched ? 'queue-to' : 'queue'}${suffix}`, vars };
  if (i.running) return { key: `${K}.${switched ? 'handover' : 'steer'}${suffix}`, vars };
  if (i.done) return { key: switched ? `${K}.reopen-with` : `${K}.reopen`, vars };
  return { key: `${K}.follow`, vars };
}

/** The launcher's: a hint at ⌘L, except where there are no keys to press. */
export const launcherPlaceholder = (focused: boolean, touch: boolean): Copy => ({
  key: focused || touch ? 'shell-composer.launcher.ph' : 'shell-composer.launcher.ph-keys',
  vars: {},
});
