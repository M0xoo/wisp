// Something shared to wisp from a phone's share sheet (v1 features/share-in.js), once it's read:
// New task, with it in the box, ready to send. Nothing here starts a task, and nothing leaves the
// phone before Send. How it arrives is the shell's (the service worker's ?shared=<id>, which take()
// reads; Android's bridge): it hands what it read to receiveShared.

import type { PluginClient } from '@wisp/client';
import { leftOut, promptOf } from './form.ts';
import { launcherKey, SHARED_IN_FIELD, TEXT_FIELD } from './launcher.ts';

export interface Received {
  readonly title?: string;
  readonly text?: string;
  readonly url?: string;
  /** how many files came (they go as the composer's attachments) */
  readonly files?: number;
  /** files over the caps, left out */
  readonly left?: number;
}

/** The words for the box: the share's, or, for files alone, a prompt to start from (a picture
 *  alone doesn't come with one). */
export function sharedPrompt(t: (k: string, v?: Readonly<Record<string, string | number>>) => string, r: Received): string {
  const words = promptOf(r);
  if (words || !r.files) return words;
  return t('stuff.share.in.aboutFiles', { count: r.files });
}

/** Whatever's in the box stays, with this below it; New task opens with it. Returns the toast's
 *  words for files left out, or ''. */
export function receiveShared(c: PluginClient, r: Received, current: string): string {
  const t = (k: string, v?: Readonly<Record<string, string | number>>): string => c.t(k, v);
  const words = sharedPrompt(t, r);
  const key = launcherKey(c);
  c.drafts.set(key, TEXT_FIELD, [current.trim(), words].filter(Boolean).join('\n\n'));
  // Any site can post the Home Screen app's form: it says so above the box until it's sent.
  c.drafts.set(key, SHARED_IN_FIELD, true);
  c.navigate({ t: 'home' });
  if (!r.left) return '';
  const l = leftOut(r.left);
  return t(l.key, l.vars);
}
