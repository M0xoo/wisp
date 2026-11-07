// The pure part of My Stuff (v1 server/services/stuff.js): what kind a file is, its name and title,
// the opening a card shows, the fields a person may set, and what an item's content is.

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { grantOf, WRITE_USES } from '@wisp-plugin/stuff-api';
import type { StuffContent, StuffItem, StuffKind } from '@wisp-plugin/stuff-api';

export const MAX_STUFF = 500 * 1024 * 1024;
export const MAX_TEXT = 2 * 1024 * 1024; // text saved from a reply (a doc, a snippet)
export const MAX_APP = 200 * 1024 * 1024;
export const MAX_APP_FILES = 5000;
const EXCERPT = 1400;
export const HEAD_BYTES = EXCERPT * 4;

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp', '.ico']);
const VIDEO = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const DOC = new Set(['.md', '.markdown', '.mdx', '.txt', '.pdf', '.rst', '.adoc']);
const CODE = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.sql', '.html', '.css', '.scss', '.vue', '.svelte', '.json', '.yaml', '.yml', '.toml', '.xml', '.ini', '.lua', '.dart', '.ex', '.exs', '.scala', '.r', '.pl', '.csv', '.tsv', '.diff', '.patch', '.env', '.graphql', '.proto', '.tf', '.dockerfile']);
export const TEXTY: ReadonlySet<string> = new Set([...CODE, ...[...DOC].filter((e) => e !== '.pdf')]);
// Left out of an app's copy: what a build or a package manager makes again.
export const SKIP: ReadonlySet<string> = new Set(['node_modules', '.git', '.hg', '.svn', '.DS_Store', '.next', '.cache', '.turbo', '.venv', '__pycache__']);

// A code block's language → the extension its file is saved under.
export const LANG_EXT: Readonly<Record<string, string>> = { javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', tsx: 'tsx', jsx: 'jsx', python: 'py', py: 'py', ruby: 'rb', go: 'go', rust: 'rs', java: 'java', kotlin: 'kt', swift: 'swift', c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', cs: 'cs', php: 'php', shell: 'sh', sh: 'sh', bash: 'sh', zsh: 'sh', console: 'sh', powershell: 'ps1', sql: 'sql', html: 'html', css: 'css', scss: 'scss', vue: 'vue', svelte: 'svelte', json: 'json', yaml: 'yml', yml: 'yml', toml: 'toml', xml: 'xml', lua: 'lua', dart: 'dart', elixir: 'ex', scala: 'scala', r: 'r', diff: 'diff', graphql: 'graphql', dockerfile: 'dockerfile', markdown: 'md', md: 'md', text: 'txt', txt: 'txt', csv: 'csv' };

/** v1 util.newId: 12 hex characters. */
export const newId = (): string => randomUUID().replace(/-/g, '').slice(0, 12);

export const extOf = (name: string): string => path.extname(name).toLowerCase();

export function kindOf(name: string): Exclude<StuffKind, 'link' | 'app'> {
  const ext = extOf(name);
  if (IMAGE.has(ext)) return 'image';
  if (VIDEO.has(ext)) return 'video';
  if (DOC.has(ext)) return 'doc';
  if (CODE.has(ext) || /^(dockerfile|makefile)$/i.test(name)) return 'code';
  return 'file';
}

export const safeName = (name: unknown, fallback = 'file'): string =>
  path.basename(String(name || '')).replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').slice(-120) || fallback;
export const titleFrom = (name: string): string => name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || name;

/** v1 util.clip: one line, at most n characters. */
export function clip(s: unknown, n = 80): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
/** Unlike clip(), it keeps the lines. */
export const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// The opening of a doc or snippet, for its card. Docs lose their front matter.
export const excerptOf = (text: string, kind: string): string =>
  cut((kind === 'doc' ? text.replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n+/, '') : text.replace(/\r\n/g, '\n')).trimEnd(), EXCERPT);

export const MAX_TAGS = 10;
/** v1 web/js/tags.js normalizeTags: "Rate Limiting", "#Redis" → "rate-limiting", "redis". */
export function normalizeTags(list: unknown): string[] {
  const out: string[] = [];
  const raw: unknown[] = Array.isArray(list) ? list : typeof list === 'string' ? list.split(',') : [];
  for (const x of raw) {
    const t = String(x ?? '')
      .toLowerCase()
      .trim()
      .replace(/^#+/, '')
      .replace(/[\s_/]+/g, '-')
      .replace(/[^\p{L}\p{N}\-.+]/gu, '')
      .replace(/-{2,}/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 32);
    if (t && !out.includes(t)) out.push(t);
    if (out.length === MAX_TAGS) break;
  }
  return out;
}

export interface Fields {
  title?: string;
  note?: string;
  tags?: string[];
  starred?: boolean;
}

/** The fields a person (or an agent) may set on an item. */
export function fields(body: unknown): Fields {
  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const out: Fields = {};
  if (typeof b['title'] === 'string' && b['title'].trim()) out.title = clip(b['title'].replace(/\s+/g, ' ').trim(), 140);
  if (typeof b['note'] === 'string') out.note = cut(b['note'].trim(), 2000);
  if (b['tags'] !== undefined) out.tags = normalizeTags(b['tags']);
  if (b['starred'] !== undefined) out.starred = !!b['starred'];
  return out;
}

// What makes up an item's content (the rest is yours: title, note, tags, star, where it's from).
export const CONTENT = ['kind', 'name', 'mime', 'size', 'path', 'source', 'lang', 'excerpt', 'url', 'entry', 'files', 'db', 'uses', 'by'] as const;

export function content(it: StuffItem): StuffContent {
  const out: Record<string, unknown> = {};
  for (const k of CONTENT) if (it[k] !== undefined) out[k] = it[k];
  return { ...(out as Omit<StuffContent, 'at'>), at: it.updatedAt || it.at };
}

/** An item without its content fields: what an update or a restore keeps. */
export function withoutContent(it: StuffItem): Partial<StuffItem> {
  const back: Record<string, unknown> = { ...it };
  for (const k of CONTENT) delete back[k];
  return back as Partial<StuffItem>;
}

/** An update (or a restore) may ask for less: what you allowed shrinks with it, a new ask waits for you. */
export function pruneGrant(it: StuffItem, uses: readonly string[] | undefined): StuffItem {
  const out: StuffItem = { ...it };
  if (!uses?.length) delete out.uses;
  const allowed = grantOf(uses ?? [], out.allowed);
  if (allowed.length) out.allowed = allowed;
  else delete out.allowed;
  if (!allowed.some((x) => WRITE_USES.includes(x))) delete out.grantHash;
  return out;
}

const day = (t: number): string => new Date(t).toISOString().slice(0, 10);
/** 1536 → 1.5 KB, for the agent. */
export const bytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

/** One line per item, with where its file is (what an agent reads: wisp_stuff, @-mentions). */
export function stuffLine(x: StuffItem): string {
  const where = x.url ? `url: ${x.url}` : x.kind === 'app' ? `folder: ${x.path} (entry ${x.entry})${x.published ? `, public at ${x.published.url}` : ''}` : `file: ${x.path}`;
  const rev = (x.rev ?? 1) > 1 ? `, v${x.rev} (updated ${day(x.updatedAt ?? x.at)})` : '';
  const tags = x.tags?.length ? ` ${x.tags.map((t) => `#${t}`).join(' ')}` : '';
  return `- \`${x.id}\` **${x.title}** — ${x.kind}${x.lang ? ` (${x.lang})` : ''}${x.size ? `, ${bytes(x.size)}` : ''}, saved ${day(x.at)} by ${x.by === 'agent' ? 'an agent' : 'the user'}${rev}${x.from?.title ? ` from “${x.from.title}”` : ''}${x.starred ? ', starred' : ''}${tags}\n  ${where}${x.note ? `\n  note: ${clip(x.note, 200)}` : ''}`;
}

/** v1 Stuff.search: every item matching all the words (a leading # matches a tag). */
export function matches(x: StuffItem, words: readonly string[], kind: string): boolean {
  if (kind && x.kind !== kind) return false;
  const hay = `${x.title} ${x.name} ${x.note || ''} ${(x.tags || []).join(' ')} ${x.from?.title || ''} ${x.url || ''} ${x.kind === 'app' ? `app ${x.excerpt || ''}` : ''}`.toLowerCase();
  return words.every((w) => hay.includes(w.replace(/^#/, '')));
}
