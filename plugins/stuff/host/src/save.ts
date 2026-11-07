// Putting things in My Stuff (v1 Stuff.addFile, addText, addLink, receive, update, restore, allow,
// setPublished): each is a copy under its own id, and an update keeps the content before it as the
// one previous version, so Restore can swap them back.

import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { grantOf, WRITE_USES } from '@wisp-plugin/stuff-api';
import type { Published, StuffFrom, StuffItem } from '@wisp-plugin/stuff-api';
import { rmTree } from './app-files.ts';
import { bad } from './errors.ts';
import { content, excerptOf, extOf, fields, HEAD_BYTES, kindOf, LANG_EXT, MAX_STUFF, MAX_TEXT, newId, pruneGrant, safeName, TEXTY, titleFrom, withoutContent } from './items.ts';
import { MIME } from './mime.ts';
import type { Shelf } from './shelf.ts';

/** What a save may carry besides its content. */
export interface SaveOpts {
  title?: unknown;
  note?: unknown;
  tags?: unknown;
  starred?: unknown;
  from?: StuffFrom | undefined;
  by?: string | undefined;
  replace?: string | undefined;
  name?: string | undefined;
  lang?: unknown;
  mime?: string | undefined;
}

export const GONE = 'That’s no longer in My Stuff.';

/** Where new content for an item goes: a new id, or the item's own when it's an update. */
export function slot(shelf: Shelf, replace: string | undefined): { old: StuffItem | undefined; id: string; tag: string | null } {
  const old = replace ? shelf.get(replace) : undefined;
  if (replace && !old) throw bad(`No item ${replace} in My Stuff: wisp_stuff lists them.`, 404);
  return { old, id: old ? old.id : newId(), tag: old ? `${old.id}-r${(old.rev || 1) + 1}` : null };
}

/**
 * An update: the new content under the same id, place, star, note and tags, and the content before it
 * kept as the one previous version. A title from the file's name doesn't replace the one it has.
 */
export async function keep(shelf: Shelf, old: StuffItem | undefined, it: StuffItem, titled: boolean): Promise<StuffItem> {
  if (!old) return it;
  if (old.prev?.path && old.prev.path !== old.path) await rmTree(old.prev.path);
  if (old.cover && it.cover && old.cover !== it.cover) await fs.rm(old.cover, { force: true });
  const next: StuffItem = { ...old, ...it, title: titled ? it.title : old.title, id: old.id, at: old.at, updatedAt: shelf.now(), rev: (old.rev || 1) + 1, prev: content(old) };
  if (old.from) next.from = old.from;
  else delete next.from;
  if (!it.db) delete next.db; // the new version has no database (its data stays, for a later one)
  return pruneGrant(next, it.uses);
}

async function readHead(file: string, size: number): Promise<string> {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(size, HEAD_BYTES));
    await fh.read(buf, 0, buf.length, 0);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

/** The record for a file now in My Stuff's folder. */
async function record(shelf: Shelf, id: string, file: string, name: string, o: SaveOpts & { size: number; source?: string; old?: StuffItem | undefined }): Promise<StuffItem> {
  const kind = kindOf(name);
  const ext = extOf(name);
  const f = fields(o);
  const it: StuffItem = {
    id,
    kind,
    name,
    title: f.title ?? titleFrom(name),
    mime: o.mime || MIME[ext] || (TEXTY.has(ext) ? 'text/plain; charset=utf-8' : 'application/octet-stream'),
    size: o.size,
    at: shelf.now(),
    by: o.by ?? 'you',
    path: file,
    ...(o.source && { source: o.source }),
    ...(o.lang !== undefined && o.lang !== null && o.lang !== '' && { lang: String(o.lang).slice(0, 24) }),
    ...(o.from && { from: o.from }),
    ...f,
  };
  if ((kind === 'doc' || kind === 'code') && TEXTY.has(ext)) it.excerpt = excerptOf(await readHead(file, o.size), kind);
  if (kind === 'image' && ext === '.svg') it.mime = 'image/svg+xml';
  return shelf.save(await keep(shelf, o.old, it, f.title !== undefined));
}

/** A file on this computer, copied in. */
export async function addFile(shelf: Shelf, src: string, o: SaveOpts = {}): Promise<StuffItem> {
  const st = await fs.stat(src);
  if (!st.isFile()) throw bad('That’s a folder, not a file: save the files in it one by one, or a zip of it.');
  if (st.size > MAX_STUFF) throw bad('That file is too big for My Stuff (500 MB at most).', 413);
  const { old, id, tag } = slot(shelf, o.replace);
  const name = safeName(o.name || path.basename(src));
  const file = path.join(shelf.dir, `${tag || id}-${name}`);
  await fs.copyFile(src, file);
  return record(shelf, id, file, name, { ...o, size: st.size, source: src, old });
}

/** Text from a reply: a document or a snippet. A code block's language picks its extension. */
export async function addText(shelf: Shelf, text: unknown, o: SaveOpts = {}): Promise<StuffItem> {
  if (typeof text !== 'string' || !text.trim()) throw bad('Nothing to save: the text is empty.');
  if (Buffer.byteLength(text) > MAX_TEXT) throw bad('That text is too long for My Stuff (2 MB at most).', 413);
  const lang = typeof o.lang === 'string' ? o.lang : '';
  const ext = LANG_EXT[lang.toLowerCase()] || (lang ? 'txt' : 'md');
  let base = safeName(o.name || '', '');
  if (base && !path.extname(base)) base += `.${ext}`;
  const title = typeof o.title === 'string' ? o.title : '';
  if (!base) base = `${(title ? safeName(title.replace(/\s+/g, '-').toLowerCase(), '') : '') || (lang ? 'snippet' : 'note')}.${ext}`;
  const { old, id, tag } = slot(shelf, o.replace);
  const file = path.join(shelf.dir, `${tag || id}-${base}`);
  await fs.writeFile(file, text);
  return record(shelf, id, file, base, { ...o, lang, size: Buffer.byteLength(text), old });
}

/** A link: nothing to copy, just where it goes. */
export async function addLink(shelf: Shelf, url: unknown, o: SaveOpts = {}): Promise<StuffItem> {
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    throw bad('That isn’t a link: give a full http(s) URL.');
  }
  if (!/^https?:$/.test(u.protocol)) throw bad('Only http(s) links can be saved.');
  const { old, id } = slot(shelf, o.replace);
  const host = u.hostname.replace(/^www\./, '');
  const f = fields(o);
  const it: StuffItem = { id, kind: 'link', name: host, title: host, url: u.href, size: 0, at: shelf.now(), by: o.by ?? 'you', ...(o.from && { from: o.from }), ...f };
  return shelf.save(await keep(shelf, old, it, f.title !== undefined));
}

/** A request's raw body (a file dropped on the page, a picture from another computer), streamed to disk. */
export async function receive(shelf: Shelf, body: AsyncIterable<Uint8Array>, o: SaveOpts = {}): Promise<StuffItem> {
  const name = safeName(o.name);
  const id = newId();
  const file = path.join(shelf.dir, `${id}-${name}`);
  const size = await streamTo(file, body, MAX_STUFF, 'That file is too big for My Stuff (500 MB at most).');
  if (!size) {
    await fs.rm(file, { force: true });
    throw bad('Nothing to save: the file is empty.');
  }
  return record(shelf, id, file, name, { ...o, size });
}

/** Writes a body to `file`, at most `max` bytes (the file goes, and a 413, past that). */
export async function streamTo(file: string, body: AsyncIterable<Uint8Array>, max: number, tooBig: string): Promise<number> {
  const out = createWriteStream(file);
  let size = 0;
  try {
    for await (const chunk of body) {
      size += chunk.length;
      if (size > max) throw bad(tooBig, 413);
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', resolve));
    }
    out.end();
    await finished(out);
  } catch (err) {
    out.destroy();
    await fs.rm(file, { force: true });
    throw err;
  }
  return size;
}

export async function update(shelf: Shelf, id: string, body: unknown): Promise<StuffItem> {
  const it = shelf.get(id);
  if (!it) throw bad(GONE, 404);
  return shelf.save({ ...it, ...fields(body) });
}

/** Swap an item with its previous version. */
export async function restore(shelf: Shelf, id: string): Promise<StuffItem> {
  const it = shelf.get(id);
  if (!it?.prev) throw bad('There’s no earlier version of that.', 404);
  const was = content(it);
  const { at: _at, ...prev } = it.prev;
  const back = { ...withoutContent(it), ...prev, updatedAt: shelf.now(), rev: (it.rev || 1) + 1, prev: was } as StuffItem;
  return shelf.save(pruneGrant(back, prev.uses));
}

/** What you allowed a pane to use: only what its wisp-app.json asks for. A write scope is tied to its code. */
export async function allow(shelf: Shelf, id: string, uses: unknown): Promise<StuffItem> {
  const it = shelf.get(id);
  if (!it || it.kind !== 'app') throw bad('That’s not an app in My Stuff.', 404);
  const allowed = grantOf(it.uses ?? [], uses);
  const { allowed: _a, grantHash: _h, ...rest } = it;
  const tied = allowed.some((x) => WRITE_USES.includes(x));
  return shelf.save({ ...rest, ...(allowed.length && { allowed }), ...(tied && { grantHash: await shelf.hashOf(it) }) });
}

/** Where an app is published (the publisher), or null once it's taken down. */
export async function setPublished(shelf: Shelf, id: string, published: Published | null): Promise<StuffItem> {
  const it = shelf.get(id);
  if (!it) throw bad(GONE, 404);
  const { published: _p, ...rest } = it;
  return shelf.save(published ? { ...rest, published } : rest);
}

