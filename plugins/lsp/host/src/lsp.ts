// Language intelligence for the side panel's editor (v1 server/lsp.js): a language server per task
// folder and language (TypeScript/JavaScript, Python, Go, Rust). A server is found in the repo's
// node_modules/.bin, in wisp's own <home>/lsp (Install puts typescript-language-server and pyright
// there), or on PATH; none found, the editor keeps its text search (GET /grep).

import { access, constants, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hit, Lang, LspAnswer, LspOp } from '@wisp-plugin/lsp-api';
import { type Later, LspClient, type StdioChild } from './client.ts';

export const SERVERS: Readonly<Record<Lang, { name: string; bins: readonly (readonly string[])[]; exts: readonly string[]; npm?: readonly string[] }>> = {
  ts: { name: 'TypeScript', bins: [['typescript-language-server', '--stdio']], exts: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'], npm: ['typescript@5', 'typescript-language-server'] },
  py: { name: 'Python', bins: [['pyright-langserver', '--stdio'], ['pylsp']], exts: ['py', 'pyi'], npm: ['pyright'] },
  go: { name: 'Go', bins: [['gopls']], exts: ['go'] },
  rs: { name: 'Rust', bins: [['rust-analyzer']], exts: ['rs'] },
};
const LANGS = Object.keys(SERVERS) as Lang[];

export const langOf = (file: string): Lang | null => {
  const ext = path.extname(file).slice(1).toLowerCase();
  return LANGS.find((k) => SERVERS[k].exts.includes(ext)) ?? null;
};

const isExe = (p: string): Promise<boolean> => access(p, constants.X_OK).then(() => stat(p).then((s) => s.isFile()), () => false);

export interface Where {
  env: Record<string, string | undefined>;
  platform: string;
  /** wisp's home (its lsp/ folder holds what Install put there) */
  home: string | null;
}

/** The command for lang in root: the repo's own, wisp's, then PATH (WISP_LSP_<LANG> overrides, for tests). */
export async function findServer(lang: Lang, root: string, w: Where): Promise<string[] | null> {
  const forced = w.env[`WISP_LSP_${lang.toUpperCase()}`];
  if (forced) return forced.split(' ');
  const exe = (b: string): string[] => (w.platform === 'win32' ? [`${b}.cmd`, `${b}.exe`] : [b]);
  const dirs = [path.join(root, 'node_modules', '.bin'), w.home && path.join(w.home, 'lsp', 'node_modules', '.bin'), ...String(w.env['PATH'] ?? '').split(path.delimiter)].filter((d): d is string => !!d);
  for (const [bin, ...args] of SERVERS[lang].bins)
    for (const d of dirs)
      for (const b of exe(bin ?? '')) {
        const p = path.join(d, b);
        if (await isExe(p)) return [p, ...args];
      }
  return null;
}

export interface Spawner {
  spawn(bin: string, args: readonly string[], opts: { cwd: string; stdin: 'pipe' }): StdioChild;
}

/** Running servers, by folder and language. */
export class Pool {
  readonly #pool = new Map<string, LspClient>();
  readonly #o: { proc: Spawner; later: Later; where: Where; pid: number };

  constructor(o: { proc: Spawner; later: Later; where: Where; pid: number }) {
    this.#o = o;
  }

  get size(): number {
    return this.#pool.size;
  }

  async client(root: string, lang: Lang): Promise<LspClient | null> {
    const key = `${root}\0${lang}`;
    const c = this.#pool.get(key);
    if (c && !c.dead) return c;
    const cmd = await findServer(lang, root, this.#o.where);
    const again = this.#pool.get(key); // another ask started it while we looked
    if (again && !again.dead) return again;
    if (!cmd?.[0]) return null;
    const child = this.#o.proc.spawn(cmd[0], cmd.slice(1), { cwd: root, stdin: 'pipe' });
    const made: LspClient = new LspClient(child, root, SERVERS[lang].name, { later: this.#o.later, pid: this.#o.pid, gone: () => this.#pool.get(key) === made && this.#pool.delete(key) });
    this.#pool.set(key, made);
    return made;
  }

  stopAll(): void {
    for (const c of [...this.#pool.values()]) c.stop();
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
type Pos = { line: number; character: number };
const posOf = (v: unknown): Pos => (isRecord(v) ? { line: Number(v['line'] ?? 0), character: Number(v['character'] ?? 0) } : { line: 0, character: 0 });
const inside = (root: string, file: string): string | null => {
  const rel = path.relative(root, file);
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : rel.split(path.sep).join('/');
};

/** Where an LSP location points, as the editor wants it; a library's (outside root) isn't this task's to open. */
async function place(root: string, loc: unknown): Promise<Hit | null> {
  if (!isRecord(loc)) return null;
  const uri = loc['uri'] ?? loc['targetUri'];
  const range = loc['range'] ?? loc['targetSelectionRange'] ?? loc['targetRange'];
  if (typeof uri !== 'string' || !uri.startsWith('file:') || !isRecord(range)) return null;
  const file = fileURLToPath(uri);
  const rel = inside(root, file);
  if (rel === null) return null;
  const start = posOf(range['start']);
  const text = await readFile(file, 'utf8').then((t) => t.split('\n')[start.line]?.trim().slice(0, 240) ?? '', () => '');
  return { path: rel, line: start.line + 1, col: start.character + 1, text };
}

const hoverText = (h: unknown): string => {
  const c = isRecord(h) ? h['contents'] : undefined;
  const one = (x: unknown): string => (typeof x === 'string' ? x : isRecord(x) && typeof x['value'] === 'string' ? x['value'] : '');
  return (Array.isArray(c) ? c.map(one).join('\n\n') : one(c)).trim().slice(0, 4000);
};

/** op on file (absolute) with the editor's text, at a 1-based line and column. */
// size-ok: one branch per op, each a line or two; v1's ask() as it was
export async function ask(pool: Pool, root: string, op: LspOp, file: string, text: string, line = 1, col = 1, extra: { newName?: string } = {}): Promise<LspAnswer> {
  const lang = langOf(file);
  const c = lang && (await pool.client(root, lang));
  if (!lang || !c) return { lsp: null, lang, install: lang && SERVERS[lang].npm ? SERVERS[lang].name : null };
  c.touch();
  await c.ready;
  const uri = c.sync(file, text);
  const at = { textDocument: { uri }, position: { line: line - 1, character: col - 1 } };
  const name = SERVERS[lang].name;
  if (op === 'diagnostics') return { lsp: name, diagnostics: await c.diagnostics(uri) };
  if (op === 'hover') return { lsp: name, hover: hoverText(await c.request('textDocument/hover', at)) };
  if (op === 'completion') {
    const res = await c.request('textDocument/completion', at);
    const items = (Array.isArray(res) ? res : isRecord(res) && Array.isArray(res['items']) ? res['items'] : []).slice(0, 100).filter(isRecord);
    const insert = (x: Record<string, unknown>): string => (isRecord(x['textEdit']) && typeof x['textEdit']['newText'] === 'string' ? x['textEdit']['newText'] : typeof x['insertText'] === 'string' ? x['insertText'] : String(x['label'] ?? ''));
    return { lsp: name, items: items.map((x) => ({ label: String(x['label'] ?? ''), detail: String(x['detail'] ?? '').slice(0, 160), insert: insert(x) })) };
  }
  if (op === 'rename') return { lsp: name, ...(await applyEdit(root, await c.request('textDocument/rename', { ...at, newName: extra.newName }))) };
  const refs = op === 'references';
  const res = await c.request(refs ? 'textDocument/references' : 'textDocument/definition', refs ? { ...at, context: { includeDeclaration: true } } : at);
  const list = await Promise.all((Array.isArray(res) ? res : res ? [res] : []).map((l) => place(root, l)));
  return { lsp: name, hits: list.filter((h): h is Hit => !!h).slice(0, 200) };
}

type Edit = { range: { start: Pos; end: Pos }; newText: string };
const editsOf = (v: unknown): Edit[] => (Array.isArray(v) ? v.filter(isRecord).map((e) => ({ range: { start: posOf(isRecord(e['range']) ? e['range']['start'] : null), end: posOf(isRecord(e['range']) ? e['range']['end'] : null) }, newText: String(e['newText'] ?? '') })) : []);

/**
 * A rename's WorkspaceEdit, written to the task's files (none outside root): each file's edits from
 * its end back, so earlier offsets stay right. Returns the files it changed and how many places.
 */
export async function applyEdit(root: string, edit: unknown): Promise<{ files: string[]; count: number }> {
  const byUri = new Map<string, Edit[]>();
  if (isRecord(edit) && isRecord(edit['changes'])) for (const [uri, list] of Object.entries(edit['changes'])) byUri.set(uri, editsOf(list));
  for (const dc of isRecord(edit) && Array.isArray(edit['documentChanges']) ? edit['documentChanges'].filter(isRecord) : []) {
    const uri = isRecord(dc['textDocument']) ? String(dc['textDocument']['uri'] ?? '') : '';
    if (uri && dc['edits']) byUri.set(uri, [...(byUri.get(uri) ?? []), ...editsOf(dc['edits'])]);
  }
  const files: string[] = [];
  let count = 0;
  for (const [uri, edits] of byUri) {
    if (!uri.startsWith('file:') || !edits.length) continue;
    const file = fileURLToPath(uri);
    const rel = inside(root, file);
    if (rel === null) continue;
    const text = await readFile(file, 'utf8');
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    const off = (p: Pos): number => Math.min(text.length, (starts[p.line] ?? text.length) + p.character);
    let out = text;
    for (const e of [...edits].sort((a, b) => off(b.range.start) - off(a.range.start))) out = out.slice(0, off(e.range.start)) + e.newText + out.slice(off(e.range.end));
    await writeFile(file, out);
    files.push(rel);
    count += edits.length;
  }
  return { files, count };
}

/** Install: the npm servers into <home>/lsp, so every task folder finds them. */
export function installArgs(lang: string, home: string): { dir: string; args: string[] } | null {
  const pkgs = (SERVERS as Record<string, { npm?: readonly string[] }>)[lang]?.npm;
  return pkgs ? { dir: path.join(home, 'lsp'), args: ['install', '--no-audit', '--no-fund', '--prefix', path.join(home, 'lsp'), ...pkgs] } : null;
}
