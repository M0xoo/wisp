// The files going with a prompt: they upload the moment they're added (paste, drop, pick), show as
// chips, and the ready ones are kept in the draft so a reload brings them back. Send takes them at
// once (the chips go with the text) and a refusal puts them back. Uploads belong to the box's
// owner, so leaving the task aborts the ones still going.
import { createSignal, onCleanup, type Accessor } from 'solid-js';
import { untrack } from 'solid-js';
import type { Env } from '../env.ts';
import { adding, busy, failed, fromSaved, nameOf, readyOf, removed, settled, type TrayFile } from '../model/tray.ts';
import type { Attachment, PeerId, Upload } from '../types.ts';

export interface Tray {
  readonly files: Accessor<readonly TrayFile[]>;
  readonly busy: Accessor<boolean>;
  add(files: readonly File[]): void;
  remove(key: string): void;
  /** waits for uploads still going, then empties the tray and hands over what's ready */
  take(): Promise<Attachment[]>;
  /** a refused send: the files come back */
  restore(list: readonly Attachment[]): void;
}

export interface TrayOptions {
  readonly env: Env;
  readonly entity: string;
  readonly peer: PeerId;
  readonly upload: Upload | undefined;
  readonly onError: (message: string) => void;
  /** object URLs for previews; injected so tests run without a DOM URL */
  readonly preview?: (f: File) => string | undefined;
}

export function useTray(o: TrayOptions): Tray {
  const [files, setFiles] = createSignal<readonly TrayFile[]>(fromSaved(untrack(o.env.files(o.entity))));
  const ctl = new AbortController();
  const waits = new Map<string, Promise<void>>();
  const urls: string[] = [];
  onCleanup(() => {
    ctl.abort();
    for (const u of urls) URL.revokeObjectURL(u);
  });
  const save = (list: readonly TrayFile[]): void => o.env.setFiles(o.entity, readyOf(list));
  const update = (fn: (l: readonly TrayFile[]) => readonly TrayFile[]): void => {
    const next = fn(files());
    setFiles(next);
    save(next);
  };

  function start(key: string, file: File): void {
    const up = o.upload;
    if (!up) return update((l) => failed(l, key, 'no uploads'));
    const run = up(o.peer, file, ctl.signal).then(
      (att) => update((l) => (l.some((f) => f.key === key) ? settled(l, key, att) : l)),
      (err: unknown) => {
        if (ctl.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        update((l) => failed(l, key, message));
        o.onError(o.env.t('shell-composer.attach.failed', { message }));
      },
    );
    waits.set(key, run.finally(() => waits.delete(key)));
  }

  return {
    files,
    busy: () => busy(files()),
    add(list) {
      const added = list.map((f, i) => {
        const thumb = f.type.startsWith('image/') ? (o.preview ?? ((x) => URL.createObjectURL(x)))(f) : undefined;
        if (thumb) urls.push(thumb);
        return { key: `f${Date.now().toString(36)}-${i}-${files().length}`, name: nameOf(f), size: f.size, mime: f.type || 'application/octet-stream', ...(thumb && { thumb }) };
      });
      setFiles((l) => adding(l, added));
      added.forEach((a, i) => {
        const f = list[i];
        if (f) start(a.key, f);
      });
    },
    remove: (key) => update((l) => removed(l, key)),
    async take() {
      await Promise.all(waits.values());
      const ready = readyOf(files());
      update(() => []);
      return ready;
    },
    restore(list) {
      update((l) => [...fromSaved(list), ...l]);
    },
  };
}
