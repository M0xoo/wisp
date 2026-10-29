// My Stuff: the things you (or an agent, with wisp_save) kept from tasks: pictures, videos,
// documents, code, any file, links. Each one is a copy in ~/.wisp/stuff, so it stays when the task,
// its worktree or /tmp goes. <id>-<name> holds the file, <id>.json what wisp knows about it.
// Docs and code keep their opening in the record (`excerpt`), so the page draws every card from
// the list alone.

import fs from 'node:fs';
import path from 'node:path';
import { MIME } from '../http/static.js';
import { bad, clip, newId } from '../util.js';
import { normalizeTags } from '../../web/js/tags.js';

export const MAX_STUFF = 500 * 1024 * 1024;
const MAX_TEXT = 2 * 1024 * 1024; // text saved from a reply (a doc, a snippet)
const EXCERPT = 1400;

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp', '.ico']);
const VIDEO = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const DOC = new Set(['.md', '.markdown', '.mdx', '.txt', '.pdf', '.rst', '.adoc']);
const CODE = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.sql', '.html', '.css', '.scss', '.vue', '.svelte', '.json', '.yaml', '.yml', '.toml', '.xml', '.ini', '.lua', '.dart', '.ex', '.exs', '.scala', '.r', '.pl', '.csv', '.tsv', '.diff', '.patch', '.env', '.graphql', '.proto', '.tf', '.dockerfile']);
const TEXTY = new Set([...CODE, ...[...DOC].filter((e) => e !== '.pdf')]);
export const KINDS = ['image', 'video', 'doc', 'code', 'file', 'link', 'app'];
export const MAX_APP = 200 * 1024 * 1024;
const MAX_APP_FILES = 5000;
// Left out of an app's copy: what a build or a package manager makes again.
const SKIP = new Set(['node_modules', '.git', '.hg', '.svn', '.DS_Store', '.next', '.cache', '.turbo', '.venv', '__pycache__']);

// A code block's language → the extension its file is saved under.
const LANG_EXT = { javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', tsx: 'tsx', jsx: 'jsx', python: 'py', py: 'py', ruby: 'rb', go: 'go', rust: 'rs', java: 'java', kotlin: 'kt', swift: 'swift', c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', cs: 'cs', php: 'php', shell: 'sh', sh: 'sh', bash: 'sh', zsh: 'sh', console: 'sh', powershell: 'ps1', sql: 'sql', html: 'html', css: 'css', scss: 'scss', vue: 'vue', svelte: 'svelte', json: 'json', yaml: 'yml', yml: 'yml', toml: 'toml', xml: 'xml', lua: 'lua', dart: 'dart', elixir: 'ex', scala: 'scala', r: 'r', diff: 'diff', graphql: 'graphql', dockerfile: 'dockerfile', markdown: 'md', md: 'md', text: 'txt', txt: 'txt', csv: 'csv' };

export function kindOf(name) {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE.has(ext)) return 'image';
  if (VIDEO.has(ext)) return 'video';
  if (DOC.has(ext)) return 'doc';
  if (CODE.has(ext) || /^(dockerfile|makefile)$/i.test(name)) return 'code';
  return 'file';
}

const safeName = (name, fallback = 'file') => path.basename(String(name || '')).replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').slice(-120) || fallback;
const titleFrom = (name) => name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || name;
// The opening of a doc or snippet, for its card. Docs lose their front matter.
// Unlike clip(), it keeps the lines.
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const excerptOf = (text, kind) => cut((kind === 'doc' ? text.replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n+/, '') : text.replace(/\r\n/g, '\n')).trimEnd(), EXCERPT);

function readHead(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(size, EXCERPT * 4));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// The fields a person (or an agent) may set on an item.
function fields(body = {}) {
  const out = {};
  if (typeof body.title === 'string' && body.title.trim()) out.title = clip(body.title.replace(/\s+/g, ' ').trim(), 140);
  if (typeof body.note === 'string') out.note = cut(body.note.trim(), 2000);
  if (body.tags !== undefined) out.tags = normalizeTags(body.tags);
  if (body.starred !== undefined) out.starred = !!body.starred;
  return out;
}

// What makes up an item's content (the rest is yours: title, note, tags, star, where it's from).
const CONTENT = ['kind', 'name', 'mime', 'size', 'path', 'source', 'lang', 'excerpt', 'url', 'entry', 'files', 'by'];
const content = (it) => ({ ...Object.fromEntries(CONTENT.filter((k) => it[k] !== undefined).map((k) => [k, it[k]])), at: it.updatedAt || it.at });

// --- what an agent reads (wisp_stuff, @-mentions in a prompt) --------------------------------------

const bytes = (n) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const day = (t) => new Date(t).toISOString().slice(0, 10);
const UPDATE = {
  app: 'To change it, copy the folder into your working directory, change it there, then wisp_save with id and app: <that folder>.',
  link: 'To change it, wisp_save with id and url.',
  doc: 'To change it, write the new version and wisp_save with id and text (or path).',
  code: 'To change it, write the new version and wisp_save with id and text (or path).',
};

// One line per item, with where its file is.
export function stuffLine(x) {
  const where = x.url ? `url: ${x.url}` : x.kind === 'app' ? `folder: ${x.path} (entry ${x.entry})` : `file: ${x.path}`;
  return `- \`${x.id}\` **${x.title}** — ${x.kind}${x.lang ? ` (${x.lang})` : ''}${x.size ? `, ${bytes(x.size)}` : ''}, saved ${day(x.at)} by ${x.by === 'agent' ? 'an agent' : 'the user'}${x.rev > 1 ? `, v${x.rev} (updated ${day(x.updatedAt)})` : ''}${x.from?.title ? ` from “${x.from.title}”` : ''}${x.starred ? ', starred' : ''}${x.tags?.length ? ` ${x.tags.map((t) => `#${t}`).join(' ')}` : ''}\n  ${where}${x.note ? `\n  note: ${clip(x.note, 200)}` : ''}`;
}

// One item in full: its line, how to change it, and a doc's or snippet's text (or an app's files).
export function stuffDetail(x, { text = true } = {}) {
  let body = '';
  if (text && (x.kind === 'doc' || x.kind === 'code') && x.path && TEXTY.has(path.extname(x.path).toLowerCase()) && x.size <= 20_000) {
    try {
      body = `\n\n\`\`\`${x.lang || path.extname(x.path).slice(1)}\n${fs.readFileSync(x.path, 'utf8').replace(/\n$/, '')}\n\`\`\``;
    } catch {}
  }
  if (x.kind === 'app' && x.path) {
    const files = [];
    const walk = (d, rel = '') => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (files.length >= 40) return;
        if (e.isDirectory()) walk(path.join(d, e.name), `${rel}${e.name}/`);
        else files.push(`${rel}${e.name}`);
      }
    };
    try {
      walk(x.path);
    } catch {}
    body = `\n  ${x.files} file${x.files === 1 ? '' : 's'}: ${files.join(', ')}${x.files > files.length ? ', …' : ''}\n  The user launches it from My Stuff (wisp serves it on a port of its own).`;
  }
  return `${stuffLine(x)}${body}\n  ${UPDATE[x.kind] || 'To change it, wisp_save with id and path (the new file).'} Don't change files in My Stuff's own folder.`;
}

export class Stuff {
  constructor(dir, { onChange = () => {} } = {}) {
    this.dir = dir;
    this.onChange = onChange;
    this.byId = new Map();
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const it = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (it.id && (it.kind === 'link' || (it.path && fs.existsSync(it.path)))) this.byId.set(it.id, it);
      } catch {}
    }
  }

  get(id) {
    return this.byId.get(id);
  }

  // Newest first.
  list() {
    return [...this.byId.values()].sort((a, b) => b.at - a.at);
  }

  // What the page sees: no paths on this computer.
  view(it) {
    const { path: _p, source: _s, prev, cover, ...rest } = it;
    return { ...rest, ...(prev && { prev: { at: prev.at, size: prev.size, by: prev.by } }), ...(cover && { cover: true }) };
  }

  // The same thing from the same place (a reply's picture saved twice) is the one item.
  findKey(key) {
    return key ? this.list().find((x) => x.from?.key === key) : null;
  }

  #save(it) {
    delete it.titled;
    this.byId.set(it.id, it);
    fs.writeFileSync(path.join(this.dir, `${it.id}.json`), JSON.stringify(it));
    this.onChange();
    return it;
  }

  #record(id, file, name, { size, mime, source, from, by = 'you', lang, keep, ...rest }) {
    const kind = kindOf(name);
    const it = {
      id,
      kind,
      name,
      title: titleFrom(name),
      mime: mime || MIME[path.extname(name).toLowerCase()] || (TEXTY.has(path.extname(name).toLowerCase()) ? 'text/plain; charset=utf-8' : 'application/octet-stream'),
      size,
      at: Date.now(),
      by,
      path: file,
      ...(source && { source }),
      ...(lang && { lang: String(lang).slice(0, 24) }),
      ...(from && { from }),
    };
    if ((kind === 'doc' || kind === 'code') && TEXTY.has(path.extname(name).toLowerCase())) it.excerpt = excerptOf(readHead(file, size), kind);
    if (kind === 'image' && path.extname(name).toLowerCase() === '.svg') it.mime = 'image/svg+xml';
    return this.#save(this.#keep(keep, { ...it, ...fields(rest), titled: !!fields(rest).title }));
  }

  // An update to an item (wisp_save with its id): the new content under the same id, place, star,
  // note and tags, and the content before it kept as the one previous version (restore swaps).
  #keep(old, it) {
    if (!old) return it;
    if (old.prev?.path && old.prev.path !== old.path) fs.rmSync(old.prev.path, { recursive: true, force: true });
    if (old.cover && it.cover && old.cover !== it.cover) fs.rmSync(old.cover, { force: true });
    // A title from the file's name doesn't replace the one it has (yours, or the agent's).
    const title = it.titled ? it.title : old.title;
    return { ...old, ...it, title, id: old.id, at: old.at, from: old.from, updatedAt: Date.now(), rev: (old.rev || 1) + 1, prev: content(old) };
  }

  // Swap an item with its previous version.
  restore(id) {
    const it = this.byId.get(id);
    if (!it?.prev) throw bad('There’s no earlier version of that.', 404);
    const was = content(it);
    const back = { ...it };
    for (const k of CONTENT) delete back[k];
    const { at: _at, ...prev } = it.prev;
    return this.#save({ ...back, ...prev, updatedAt: Date.now(), rev: (it.rev || 1) + 1, prev: was });
  }

  // Where new content for an item goes: a new id, or the item's own when it's an update.
  #slot(replace) {
    const old = replace && this.byId.get(replace);
    if (replace && !old) throw bad(`No item ${replace} in My Stuff: wisp_stuff lists them.`, 404);
    return { old, id: old ? old.id : newId(), tag: old ? `${old.id}-r${(old.rev || 1) + 1}` : null };
  }

  // A file on this computer, copied in.
  addFile(src, opts = {}) {
    const st = fs.statSync(src);
    if (!st.isFile()) throw bad('That’s a folder, not a file: save the files in it one by one, or a zip of it.');
    if (st.size > MAX_STUFF) throw bad('That file is too big for My Stuff (500 MB at most).', 413);
    const { old, id, tag } = this.#slot(opts.replace);
    const name = safeName(opts.name || path.basename(src));
    const file = path.join(this.dir, `${tag || id}-${name}`);
    fs.copyFileSync(src, file);
    return this.#record(id, file, name, { ...opts, size: st.size, source: src, keep: old });
  }

  // Text from a reply: a document or a snippet. A code block's language picks its extension.
  addText(text, { name, lang, ...opts } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw bad('Nothing to save: the text is empty.');
    if (Buffer.byteLength(text) > MAX_TEXT) throw bad('That text is too long for My Stuff (2 MB at most).', 413);
    const ext = LANG_EXT[String(lang || '').toLowerCase()] || (lang ? 'txt' : 'md');
    let base = safeName(name || '', '');
    if (base && !path.extname(base)) base += `.${ext}`;
    if (!base) base = `${(opts.title ? safeName(opts.title.replace(/\s+/g, '-').toLowerCase(), '') : '') || (lang ? 'snippet' : 'note')}.${ext}`;
    const { old, id, tag } = this.#slot(opts.replace);
    const file = path.join(this.dir, `${tag || id}-${base}`);
    fs.writeFileSync(file, text);
    return this.#record(id, file, base, { ...opts, lang, size: Buffer.byteLength(text), keep: old });
  }

  // A link: nothing to copy, just where it goes.
  addLink(url, opts = {}) {
    let u;
    try {
      u = new URL(String(url));
    } catch {
      throw bad('That isn’t a link: give a full http(s) URL.');
    }
    if (!/^https?:$/.test(u.protocol)) throw bad('Only http(s) links can be saved.');
    const { from, by = 'you', replace, ...rest } = opts;
    const { old, id } = this.#slot(replace);
    const host = u.hostname.replace(/^www\./, '');
    return this.#save(this.#keep(old, { id, kind: 'link', name: host, title: host, url: u.href, size: 0, at: Date.now(), by, ...(from && { from }), ...fields(rest), titled: !!fields(rest).title }));
  }

  // The raw body of a request (a file you dropped on the page, a picture from another computer).
  async receive(req, { name, ...opts } = {}) {
    name = safeName(name);
    const id = newId();
    const file = path.join(this.dir, `${id}-${name}`);
    let size = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(file);
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_STUFF) {
          req.destroy();
          out.destroy();
          fs.rmSync(file, { force: true });
          reject(bad('That file is too big for My Stuff (500 MB at most).', 413));
        }
      });
      req.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
    });
    if (!size) {
      fs.rmSync(file, { force: true });
      throw bad('Nothing to save: the file is empty.');
    }
    return this.#record(id, file, name, { ...opts, size });
  }

  update(id, body) {
    const it = this.byId.get(id);
    if (!it) throw bad('That’s no longer in My Stuff.', 404);
    const f = fields(body);
    if (f.title === '') delete f.title;
    return this.#save({ ...it, ...f });
  }

  remove(id) {
    const it = this.byId.get(id);
    if (!it) return false;
    this.byId.delete(id);
    for (const p of [it.path, it.prev?.path, it.cover]) if (p) fs.rmSync(p, { recursive: true, force: true });
    fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
    this.onChange();
    return true;
  }

  // An app an agent built (slides, a demo, a small tool): its folder, copied without what a build
  // makes again. wisp-app.json may name it ({ name, entry, description }); entry is index.html
  // unless it says otherwise, and has to be there. wisp serves it on a port of its own (apps.js).
  addApp(src, { cover, ...opts } = {}) {
    const st = fs.statSync(src);
    if (!st.isDirectory()) throw bad('An app is a folder with an index.html (or the entry its wisp-app.json names).');
    let manifest = {};
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(src, 'wisp-app.json'), 'utf8'));
    } catch {}
    const entry = String(manifest.entry || 'index.html').replace(/^\/+/, '');
    if (entry.split(/[\\/]/).includes('..') || !fs.existsSync(path.join(src, entry))) throw bad(`No ${entry} in ${src}: build the app first (static files: HTML, JS, CSS), or name its entry in wisp-app.json.`);
    const { old, id, tag } = this.#slot(opts.replace);
    const dest = path.join(this.dir, `${tag || id}-app`);
    let size = 0;
    let files = 0;
    const copy = (from, to) => {
      fs.mkdirSync(to, { recursive: true });
      for (const d of fs.readdirSync(from, { withFileTypes: true })) {
        if (SKIP.has(d.name)) continue;
        const a = path.join(from, d.name);
        const b = path.join(to, d.name);
        if (d.isDirectory()) copy(a, b);
        else if (d.isFile()) {
          size += fs.statSync(a).size;
          if (++files > MAX_APP_FILES || size > MAX_APP) throw bad(`That app is too big for My Stuff (${MAX_APP_FILES} files, 200 MB at most, without node_modules).`, 413);
          fs.copyFileSync(a, b);
        }
      }
    };
    try {
      copy(src, dest);
    } catch (err) {
      fs.rmSync(dest, { recursive: true, force: true });
      throw err;
    }
    const it = {
      id,
      kind: 'app',
      name: safeName(manifest.name || path.basename(src), 'app'),
      title: clip(manifest.name || titleFrom(path.basename(src)), 140),
      mime: 'text/html',
      size,
      files,
      entry,
      at: Date.now(),
      by: opts.by || 'you',
      path: dest,
      source: src,
      ...(manifest.description && { excerpt: clip(manifest.description, 400) }),
      ...(opts.from && { from: opts.from }),
    };
    if (cover) it.cover = this.#cover(cover, tag || id);
    return this.#save(this.#keep(old, { ...it, ...fields(opts), titled: !!(fields(opts).title || manifest.name) }));
  }

  // A picture of an app (a screenshot the agent took), for its card.
  #cover(src, tag) {
    if (kindOf(src) !== 'image' || !fs.statSync(src).isFile()) throw bad('cover has to be a picture (png, jpg, webp, svg).');
    const dest = path.join(this.dir, `${tag}-cover${path.extname(src).toLowerCase()}`);
    fs.copyFileSync(src, dest);
    return dest;
  }

  // For an agent: every item, filtered by words, with where its file is so it can use it.
  search(query = '', kind = '') {
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    return this.list().filter((x) => (!kind || x.kind === kind) && words.every((w) => `${x.title} ${x.name} ${x.note || ''} ${(x.tags || []).join(' ')} ${x.from?.title || ''} ${x.url || ''} ${x.kind === 'app' ? `app ${x.excerpt || ''}` : ''}`.toLowerCase().includes(w.replace(/^#/, ''))));
  }
}
