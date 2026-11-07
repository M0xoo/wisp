// What's shared to wisp from a phone's share sheet, DOM-free (v1 web/js/share-form.js): the caps, the
// prompt it makes, and how the service worker keeps it until the page reads it once. The worker
// (apps/web's) and the page import the same functions; the Android app applies the same caps itself.
// Any site can post the Home Screen app's form too, and neither side can tell, so nothing kept here
// acts on its own: the page shows it as from outside and sends nothing until Send.

export const MAX_FILES = 10;
export const MAX_BYTES = 20 * 1024 * 1024;
/** not the shell's cache: a new build empties that one */
export const CACHE = 'wisp-shared';
/** a share nobody opened goes with the next one */
export const STALE_MS = 24 * 3600 * 1000;
/** the manifest's share_target accept list */
export const FILE_TYPES = ['image/*', 'text/*', 'application/pdf'] as const;

export interface Sized {
  readonly name: string;
  readonly size: number;
}

/** In order, leaving out what doesn't fit: a small file after a huge one still goes. */
export function fits<F extends Sized>(files: readonly F[]): { kept: F[]; left: number } {
  const kept: F[] = [];
  let bytes = 0;
  for (const f of files) {
    if (kept.length >= MAX_FILES || bytes + f.size > MAX_BYTES) continue;
    kept.push(f);
    bytes += f.size;
  }
  return { kept, left: files.length - kept.length };
}

/** What goes in the box. Apps repeat themselves: a page's address in its text, its title in both. */
export function promptOf(o: { readonly title?: string; readonly text?: string; readonly url?: string } = {}): string {
  const [t, x, u] = [o.title, o.text, o.url].map((s) => String(s ?? '').trim()) as [string, string, string];
  const lines: string[] = [];
  if (t && !x.includes(t)) lines.push(t);
  if (x) lines.push(x);
  if (u && !x.includes(u)) lines.push(u);
  return lines.join('\n\n');
}

export const accepted = (f: { readonly type: string }): boolean => FILE_TYPES.some((t) => (t.endsWith('/*') ? f.type.startsWith(t.slice(0, -1)) : f.type === t));

/** The toast for files over the caps, as a key and its vars (the count picks one/other). */
export const leftOut = (count: number): { key: string; vars: { count: number; files: number; mb: number } } => ({ key: 'stuff.share.in.leftOut', vars: { count, files: MAX_FILES, mb: MAX_BYTES / 1024 / 1024 } });

/** The Cache API, as much of it as keep/take use (the worker's `caches`; tests pass a fake). */
export interface CacheLike {
  put(key: string, res: Response): Promise<void>;
  match(key: string): Promise<Response | undefined>;
  delete(key: string | { readonly url: string }): Promise<boolean>;
  keys(): Promise<readonly { readonly url: string }[]>;
}
export interface CacheStore {
  open(name: string): Promise<CacheLike>;
}

const keyOf = (id: string): string => `/shared/${id}`;

/** The worker: the form, capped, under a random id. One Response holds it all, files included. */
export async function keep(request: Request, store: CacheStore, now = Date.now()): Promise<string> {
  const form = await request.formData();
  const out = new FormData();
  for (const k of ['title', 'text', 'url']) {
    const v = form.get(k);
    if (typeof v === 'string' && v) out.set(k, v);
  }
  // A share with no files still sends the field, empty.
  const files = form.getAll('files').filter((f): f is File => typeof f !== 'string' && f.size > 0);
  const { kept } = fits(files.filter(accepted));
  for (const f of kept) out.append('files', f, f.name);
  out.set('left', String(files.length - kept.length));
  const cache = await store.open(CACHE);
  for (const old of await cache.keys()) {
    const at = parseInt(old.url.split('/').pop() ?? '', 36);
    if (!(now - at < STALE_MS)) await cache.delete(old);
  }
  const id = `${now.toString(36)}-${crypto.randomUUID()}`;
  await cache.put(keyOf(id), new Response(out));
  return id;
}

export interface SharedIn {
  readonly title: string;
  readonly text: string;
  readonly url: string;
  readonly files: readonly File[];
  readonly left: number;
}

/** The page: read once, then it's gone. A bad id or one already read is null. */
export async function take(id: string, store: CacheStore): Promise<SharedIn | null> {
  if (!/^[\w-]{1,64}$/.test(id)) return null;
  const cache = await store.open(CACHE);
  const hit = await cache.match(keyOf(id));
  if (!hit) return null;
  const form = await hit.formData();
  await cache.delete(keyOf(id));
  const field = (k: string): string => {
    const v = form.get(k);
    return typeof v === 'string' ? v : '';
  };
  return { title: field('title'), text: field('text'), url: field('url'), files: form.getAll('files').filter((f): f is File => typeof f !== 'string'), left: Number(field('left')) || 0 };
}
