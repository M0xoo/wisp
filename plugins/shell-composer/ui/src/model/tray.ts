// The files going with a prompt (v1 attachments.js tray). Pure list operations; the box runs the
// uploads and keeps the ready ones in its draft, so they come back after a reload. A file uploads
// the moment it's added; Send waits for the ones still going and leaves the failed ones out.

import type { Attachment } from '../types.ts';

export type TrayStatus = 'uploading' | 'ready' | 'failed';

export interface TrayFile {
  /** local id, stable while it uploads */
  readonly key: string;
  readonly name: string;
  readonly size: number;
  readonly mime: string;
  readonly status: TrayStatus;
  /** an image preview (object URL), while this page lives */
  readonly thumb?: string;
  /** the peer's record once uploaded */
  readonly att?: Attachment;
  readonly error?: string;
}

export const adding = (list: readonly TrayFile[], files: readonly Omit<TrayFile, 'status'>[]): TrayFile[] => [
  ...list,
  ...files.map((f) => ({ ...f, status: 'uploading' as const })),
];

export const settled = (list: readonly TrayFile[], key: string, att: Attachment): TrayFile[] =>
  list.map((f) => (f.key === key ? { ...f, status: 'ready' as const, att } : f));

export const failed = (list: readonly TrayFile[], key: string, error: string): TrayFile[] =>
  list.map((f) => (f.key === key ? { ...f, status: 'failed' as const, error } : f));

export const removed = (list: readonly TrayFile[], key: string): TrayFile[] => list.filter((f) => f.key !== key);

/** What Send carries: the uploaded ones (failed uploads are left out). */
export const readyOf = (list: readonly TrayFile[]): Attachment[] => list.flatMap((f) => (f.status === 'ready' && f.att ? [f.att] : []));

export const busy = (list: readonly TrayFile[]): boolean => list.some((f) => f.status === 'uploading');

/** A draft's saved files back as chips (no previews: object URLs don't survive a reload). */
export const fromSaved = (saved: readonly Attachment[]): TrayFile[] =>
  saved.map((a) => ({ key: `saved:${a.id}`, name: a.name, size: a.size, mime: a.mime, status: 'ready' as const, att: a }));

/** v1 A:88: an unnamed paste is "pasted", plus the type's extension. */
export function nameOf(file: { readonly name: string; readonly type: string }): string {
  if (file.name) return file.name;
  const ext = file.type.split('/')[1]?.split(/[+;]/)[0];
  return ext ? `pasted.${ext}` : 'pasted';
}

/** The icon a chip shows when there's no preview. */
export const iconOf = (mime: string): 'image' | 'video' | 'file' => (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file');
