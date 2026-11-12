// Files with a prompt (v1 attachments.js): picked, pasted or dropped on the box, they wait as chips, and go up
// when it's sent (wisp.stuff's `POST /uploads` on the task's computer, through the client's route call), the
// prompt then carrying what came back. A paste or drop of plain text is the box's own.
import { createSignal } from 'solid-js';
import type { PeerId } from '@wisp/client';
import type { ShellContext } from '../contract.ts';
import type { Attachment } from './commands.ts';

/** The files a paste or a drop carries (none: it's text, the box takes it as it would). */
export function filesOf(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const out = [...(data.files ?? [])];
  if (out.length) return out;
  // a pasted screenshot comes as an item, not in files, in some browsers
  for (const it of [...(data.items ?? [])]) {
    if (it.kind === 'file') {
      const f = it.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

/** A pasted image has no name of its own: it gets v1's. */
export const named = (f: File, at: number): File =>
  f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${new Date(at).toISOString().replace(/[:.]/g, '-')}.${(f.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg')}`, { type: f.type });

/** Each file up to the task's computer, in order; what it answered, as the prompt's attachments. */
export async function upload(shell: ShellContext, peer: PeerId, files: readonly File[]): Promise<Attachment[]> {
  const http = shell.client.plugin('shell').http(peer);
  const out: Attachment[] = [];
  for (const f of files) {
    const u = (await http.send({
      method: 'POST',
      path: `/uploads?name=${encodeURIComponent(f.name)}&type=${encodeURIComponent(f.type || 'application/octet-stream')}`,
      body: f,
      contentType: 'application/octet-stream',
    })) as Attachment;
    out.push({ id: u.id, name: u.name, mime: u.mime, size: u.size });
  }
  return out;
}

export interface Attachments {
  readonly files: () => readonly File[];
  /** picked, pasted or dropped: each starts up at once (v1), so sending waits for little or nothing */
  add(files: readonly File[]): void;
  remove(f: File): void;
  /** on send: what went up (waiting for any still going); the chips go. A failed one is dropped with a toast. */
  take(): Promise<Attachment[]>;
  /** a paste into the box: its files are taken (the text stays the box's) */
  paste(e: ClipboardEvent): void;
}

export function useAttachments(shell: ShellContext, peer: () => PeerId): Attachments {
  const [files, setFiles] = createSignal<readonly File[]>([]);
  const going = new Map<File, Promise<Attachment | undefined>>();
  const start = (f: File): void => {
    going.set(
      f,
      upload(shell, peer(), [f]).then(
        (a) => a[0],
        (e: unknown) => {
          shell.toast.error(shell.t('shell.attach.failed', { name: f.name, why: e instanceof Error ? e.message : String(e) }));
          setFiles(files().filter((x) => x !== f));
          return undefined;
        },
      ),
    );
  };
  const add = (list: readonly File[]): void => {
    const at = Date.now();
    const fresh = list.map((f) => named(f, at));
    fresh.forEach(start);
    setFiles([...files(), ...fresh]);
  };
  return {
    files,
    add,
    remove: (f) => {
      going.delete(f);
      setFiles(files().filter((x) => x !== f));
    },
    take: async () => {
      const now = files();
      setFiles([]);
      const done = await Promise.all(now.map((f) => going.get(f) ?? Promise.resolve(undefined)));
      now.forEach((f) => going.delete(f));
      return done.filter((a): a is Attachment => a !== undefined);
    },
    paste: (e) => {
      const fs = filesOf(e.clipboardData);
      if (!fs.length) return;
      e.preventDefault();
      add(fs);
    },
  };
}
