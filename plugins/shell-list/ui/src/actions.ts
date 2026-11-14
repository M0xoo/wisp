// What the list's buttons, keys, swipes and menus do: a command (the row changes at once; a refusal
// rolls back with the client's red toast), the navigation intent that goes with it (#354: done,
// archived or deleted, the open task goes Home), and the toast v1 showed, with Undo where v1 had it
// (actions.js toggleDone, setForLater, setArchived, deleteSession).

import type { EntityKey, PluginClient, SessionId } from '@wisp/client';
import type { Toaster } from '@wisp/ui';
import { archive, markRead, remove, rename as renameCmd, setExt, setState } from './commands.ts';
import { canSaveForLater } from './model/menu.ts';
import { busy } from './model/row.ts';
import { isForLater } from './model/sections.ts';
import { KIND, type Session, type SessionRow } from './types.ts';

export interface ActionCtx {
  readonly client: PluginClient;
  readonly t: (key: string, vars?: Readonly<Record<string, string | number>>) => string;
  readonly toast: Toaster;
  /** the row is leaving the list: the keyboard moves to its neighbour */
  readonly handOff?: (key: EntityKey) => void;
  readonly now?: () => number;
}

const peek = (c: ActionCtx, key: EntityKey): SessionRow | undefined => c.client.entities.peek<Session>(KIND.session, key);
const sid = (key: EntityKey): SessionId => key as unknown as SessionId;
// a refusal already rolled back and toasted (the client's onError); nothing is left to do here
const quiet = (p: Promise<unknown>): void => {
  p.catch(() => {});
};

/** Mark done ↔ Reopen. A busy task can't be marked done; Done has Undo. */
export function toggleDone(c: ActionCtx, key: EntityKey): void {
  const s = peek(c, key);
  if (!s) return;
  if (busy(s)) {
    c.toast.show(c.t('shell-list.toast.still-working'));
    return;
  }
  const next = s.state === 'done' ? 'review' : 'done';
  if (next === 'done') {
    c.handOff?.(key);
    c.client.navigate({ t: 'markDone', id: sid(key) });
  }
  quiet(c.client.run(setState, { id: key, state: next }));
  if (next === 'done') c.toast.success(c.t('shell-list.toast.done'), { action: { label: c.t('shell-list.toast.undo'), onClick: () => toggleDone(c, key) } });
}

/** Save for later ↔ Unsave, both with Undo; Undo of Unsave puts it back where it was. */
export function toggleForLater(c: ActionCtx, key: EntityKey, at?: number): void {
  const s = peek(c, key);
  if (!s) return;
  if (isForLater(s)) {
    const was = s.forLater?.at;
    quiet(c.client.run(setExt, { id: key, plugin: 'forLater', value: null }));
    c.toast.show(c.t('shell-list.toast.unsaved'), { action: { label: c.t('shell-list.toast.undo'), onClick: () => toggleForLater(c, key, was) } });
    return;
  }
  if (!canSaveForLater(s)) {
    c.toast.show(c.t('shell-list.toast.still-working-later'));
    return;
  }
  quiet(c.client.run(setExt, { id: key, plugin: 'forLater', value: { at: at ?? (c.now ?? Date.now)(), by: 'user' } }));
  c.toast.show(c.t('shell-list.toast.saved'), { action: { label: c.t('shell-list.toast.undo'), onClick: () => toggleForLater(c, key) } });
}

/** Archive (with Undo) ↔ Unarchive (quiet). A busy task can't be archived. */
export function toggleArchived(c: ActionCtx, key: EntityKey): void {
  const s = peek(c, key);
  if (!s) return;
  const archived = !s.archived;
  if (archived && busy(s)) {
    c.toast.show(c.t('shell-list.toast.still-working'));
    return;
  }
  if (archived) {
    c.handOff?.(key);
    c.client.navigate({ t: 'archive', id: sid(key) });
  }
  quiet(c.client.run(archive, { id: key, archived }));
  if (archived) c.toast.show(c.t('shell-list.toast.archived'), { action: { label: c.t('shell-list.toast.undo'), onClick: () => toggleArchived(c, key) } });
}

/** After the confirm (or a swipe's Undo window): the row goes, and the open task goes Home. */
export function deleteTask(c: ActionCtx, key: EntityKey): void {
  if (!peek(c, key)) return;
  c.handOff?.(key);
  c.client.navigate({ t: 'delete', id: sid(key) });
  quiet(c.client.run(remove, { id: key }));
}

/** A new title, trimmed; nothing is sent when it is empty or the same. Renaming keeps it open (#406). */
export function renameTask(c: ActionCtx, key: EntityKey, title: string): boolean {
  const s = peek(c, key);
  const next = title.trim();
  if (!s || !next || next === s.title) return false;
  c.client.navigate({ t: 'rename', id: sid(key) });
  quiet(c.client.run(renameCmd, { id: key, title: next }));
  return true;
}

export function setUnread(c: ActionCtx, key: EntityKey, unread: boolean): void {
  const s = peek(c, key);
  if (!s || !!s.unread === unread) return;
  quiet(c.client.run(markRead, { id: key, unread }));
}

/** Opening a finished task reads it (v1 marks it read once its copy lands with the window focused). */
export function readOnOpen(c: ActionCtx, key: EntityKey): void {
  const s = peek(c, key);
  if (s?.unread && s.state !== 'running') setUnread(c, key, false);
}

export function togglePin(c: ActionCtx, key: EntityKey): void {
  const s = peek(c, key);
  if (!s) return;
  quiet(c.client.run(setExt, { id: key, plugin: 'pinned', value: s.pinned ? null : true }));
}

export async function copyId(c: ActionCtx, key: EntityKey, copy: (text: string) => Promise<boolean>): Promise<void> {
  const s = peek(c, key);
  if (!s) return;
  if (await copy(s.id)) c.toast.show(c.t('shell-list.toast.copied', { title: s.title }));
  else c.toast.error(c.t('shell-list.toast.copy-failed', { id: s.id }), { duration: 8000 });
}
