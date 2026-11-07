// New task's draft, which the share card and share-in read and write (shell-composer keeps the box's
// text in the drafts store under `<home>:launcher` → `text`). The two fields below are this
// plugin's: what Send should do with a share link in the box, and that the text came from outside.

import type { EntityKey, PluginClient } from '@wisp/client';

export const launcherKey = (c: Pick<PluginClient, 'home'>): EntityKey => `${c.home}:launcher` as EntityKey;
export const TEXT_FIELD = 'text';
/** `{ body: ImportArgs }` (Send imports it) or `{ why, tone, focus? }` (Send says why not) */
export const SHARE_FIELD = 'share';
export const SHARED_IN_FIELD = 'sharedIn';
