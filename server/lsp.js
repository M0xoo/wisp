// Language intelligence for the side panel's editor: a language server per task folder and
// language (TypeScript/JavaScript, Python, Go, Rust), spoken to over stdio (LSP's JSON-RPC with
// Content-Length frames). It answers where a name is defined, every place it's used, what it is
// (hover), and what's wrong in a file (diagnostics). A server is found on PATH, in the repo's
// node_modules/.bin, or in wisp's own <home>/lsp (Install puts typescript-language-server and
// pyright there); none found, the editor keeps its text search (GET /grep).

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from './proc.js';

export const SERVERS = {
  ts: { name: 'TypeScript', bins: [['typescript-language-server', '--stdio']], exts: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'], npm: ['typescript@5', 'typescript-language-server'] },
  py: { name: 'Python', bins: [['pyright-langserver', '--stdio'], ['pylsp']], exts: ['py', 'pyi'], npm: ['pyright'] },
  go: { name: 'Go', bins: [['gopls']], exts: ['go'] },
  rs: { name: 'Rust', bins: [['rust-analyzer']], exts: ['rs'] },
};
const LANG_ID = { ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact', mjs: 'javascript', cjs: 'javascript', mts: 'typescript', cts: 'typescript', py: 'python', pyi: 'python', go: 'go', rs: 'rust' };
const IDLE = 10 * 60_000; // a server nobody asked for this long goes
const TIMEOUT = 15_000;

export const langOf = (file) => {
  const ext = path.extname(file).slice(1).toLowerCase();
  return Object.keys(SERVERS).find((k) => SERVERS[k].exts.includes(ext)) || null;
};

const isExe = (p) => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

// The command for lang in root: the repo's own, wisp's, then PATH (WISP_LSP_<LANG> overrides, for tests).
export function findServer(lang, root, home) {
  const env = process.env[`WISP_LSP_${lang.toUpperCase()}`];
  if (env) return env.split(' ');
  const exe = (b) => (process.platform === 'win32' ? [`${b}.cmd`, `${b}.exe`] : [b]);
  const dirs = [path.join(root, 'node_modules', '.bin'), home && path.join(home, 'lsp', 'node_modules', '.bin'), ...(process.env.PATH || '').split(path.delimiter)].filter(Boolean);
  for (const [bin, ...args] of SERVERS[lang]?.bins || [])
    for (const d of dirs)
      for (const b of exe(bin)) {
        const p = path.join(d, b);
        if (isExe(p)) return [p, ...args];
      }
  return null;
}

// One running server: requests by id, notifications (diagnostics) by uri.
class Client {
  constructor(cmd, root, lang) {
    this.root = root;
    this.lang = lang;
    this.seq = 0;
    this.pending = new Map();
    this.open = new Map(); // uri -> version
    this.diags = new Map(); // uri -> [{ line, col, severity, message }]
    this.waiters = new Map(); // uri -> [resolve]
    this.buf = Buffer.alloc(0);
    this.proc = spawn(cmd[0], cmd.slice(1), { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc.stdout.on('data', (d) => this.read(d));
    this.proc.on('exit', () => this.die(new Error(`The ${SERVERS[lang].name} language server stopped`)));
    this.proc.on('error', (err) => this.die(err));
    this.touch();
    this.ready = this.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      workspaceFolders: [{ uri: pathToFileURL(root).href, name: path.basename(root) }],
      capabilities: { textDocument: { completion: { completionItem: { snippetSupport: false } }, hover: { contentFormat: ['markdown', 'plaintext'] }, definition: {}, references: {}, publishDiagnostics: {}, synchronization: { didSave: true } } },
    }).then(() => this.notify('initialized', {}));
  }
  touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), IDLE);
    this.idle.unref?.();
  }
  send(msg) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }));
    this.proc.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }
  request(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => (this.pending.delete(id), reject(new Error(`The language server didn’t answer ${method} in time`))), TIMEOUT);
      this.pending.set(id, { resolve: (v) => (clearTimeout(t), resolve(v)), reject: (e) => (clearTimeout(t), reject(e)) });
      this.send({ id, method, params });
    });
  }
  notify(method, params) {
    this.send({ method, params });
  }
  read(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const head = this.buf.indexOf('\r\n\r\n');
      if (head < 0) return;
      const len = Number(/Content-Length: *(\d+)/i.exec(this.buf.slice(0, head).toString())?.[1]);
      if (!(len >= 0) || this.buf.length < head + 4 + len) return;
      let msg;
      try {
        msg = JSON.parse(this.buf.slice(head + 4, head + 4 + len).toString());
      } catch {}
      this.buf = this.buf.slice(head + 4 + len);
      if (msg) this.handle(msg);
    }
  }
  handle(msg) {
    if (msg.id != null && this.pending.has(msg.id) && !msg.method) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      return msg.error ? p.reject(new Error(msg.error.message || 'The language server refused')) : p.resolve(msg.result);
    }
    // The server asking us something (workspace/configuration …): answer so it carries on
    if (msg.id != null && msg.method) return this.send({ id: msg.id, result: msg.method === 'workspace/configuration' ? (msg.params?.items || []).map(() => null) : null });
    if (msg.method === 'textDocument/publishDiagnostics') {
      const { uri, diagnostics = [] } = msg.params || {};
      this.diags.set(uri, diagnostics.map((x) => ({ line: x.range.start.line + 1, col: x.range.start.character + 1, severity: x.severity === 1 ? 'error' : x.severity === 2 ? 'warning' : 'info', message: String(x.message || '').slice(0, 500) })));
      for (const w of this.waiters.get(uri) || []) w();
      this.waiters.delete(uri);
    }
  }
  // The editor's copy of a file (unsaved edits too) is what the server reads
  sync(file, text) {
    const uri = pathToFileURL(file).href;
    const v = (this.open.get(uri) || 0) + 1;
    if (v === 1) this.notify('textDocument/didOpen', { textDocument: { uri, languageId: LANG_ID[path.extname(file).slice(1).toLowerCase()] || 'plaintext', version: v, text } });
    else this.notify('textDocument/didChange', { textDocument: { uri, version: v }, contentChanges: [{ text }] });
    this.open.set(uri, v);
    return uri;
  }
  diagnostics(uri, wait = 4000) {
    if (this.diags.has(uri)) return Promise.resolve(this.diags.get(uri));
    return new Promise((resolve) => {
      const done = () => resolve(this.diags.get(uri) || []);
      this.waiters.set(uri, [...(this.waiters.get(uri) || []), done]);
      setTimeout(done, wait).unref?.();
    });
  }
  die(err) {
    this.dead = err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    pool.delete(`${this.root}\0${this.lang}`);
  }
  stop() {
    if (this.dead) return;
    this.dead = new Error('stopped');
    try {
      this.send({ id: ++this.seq, method: 'shutdown' });
      this.notify('exit');
    } catch {}
    setTimeout(() => this.proc.kill(), 500).unref?.();
    pool.delete(`${this.root}\0${this.lang}`);
  }
}

const pool = new Map(); // `${root}\0${lang}` -> Client
export const stopAll = () => [...pool.values()].forEach((c) => c.stop());

function client(root, lang, home) {
  const key = `${root}\0${lang}`;
  let c = pool.get(key);
  if (c && !c.dead) return c;
  const cmd = findServer(lang, root, home);
  if (!cmd) return null;
  c = new Client(cmd, root, lang);
  pool.set(key, c);
  return c;
}

// Where an LSP location points, as the editor wants it: a path inside root, 1-based line and column, the line's text.
function place(root, loc) {
  const uri = loc.uri || loc.targetUri;
  const range = loc.range || loc.targetSelectionRange || loc.targetRange;
  if (!uri?.startsWith('file:') || !range) return null;
  const file = fileURLToPath(uri);
  const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // a library's: not this task's to open
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8').split('\n')[range.start.line]?.trim().slice(0, 240) || '';
  } catch {}
  return { path: rel.split(path.sep).join('/'), line: range.start.line + 1, col: range.start.character + 1, text };
}

const hoverText = (h) => {
  const c = h?.contents;
  const one = (x) => (typeof x === 'string' ? x : x?.value || '');
  return (Array.isArray(c) ? c.map(one).join('\n\n') : one(c)).trim().slice(0, 4000);
};

// op: 'definition' | 'references' | 'hover' | 'diagnostics'. file absolute, text the editor's copy,
// line/col 1-based. Returns { lsp: server name, ... } or { lsp: null } when no server is installed.
export async function ask(root, home, op, file, text, line = 1, col = 1, extra = {}) {
  const lang = langOf(file);
  const c = lang && client(root, lang, home);
  if (!c) return { lsp: null, lang, install: lang && SERVERS[lang].npm ? SERVERS[lang].name : null };
  c.touch();
  await c.ready;
  const uri = c.sync(file, text);
  const at = { textDocument: { uri }, position: { line: line - 1, character: col - 1 } };
  const name = SERVERS[lang].name;
  if (op === 'diagnostics') return { lsp: name, diagnostics: await c.diagnostics(uri) };
  if (op === 'hover') return { lsp: name, hover: hoverText(await c.request('textDocument/hover', at)) };
  if (op === 'completion') {
    const res = await c.request('textDocument/completion', at);
    const items = (Array.isArray(res) ? res : res?.items || []).slice(0, 100);
    return { lsp: name, items: items.map((x) => ({ label: x.label, detail: String(x.detail || '').slice(0, 160), insert: x.textEdit?.newText || x.insertText || x.label })) };
  }
  if (op === 'rename') return { lsp: name, ...applyEdit(root, await c.request('textDocument/rename', { ...at, newName: extra.newName })) };
  const res = await c.request(op === 'references' ? 'textDocument/references' : 'textDocument/definition', op === 'references' ? { ...at, context: { includeDeclaration: true } } : at);
  const list = (Array.isArray(res) ? res : res ? [res] : []).map((l) => place(root, l)).filter(Boolean);
  return { lsp: name, hits: list.slice(0, 200) };
}

// A rename's WorkspaceEdit, written to the task's files (none outside root): each file's edits from
// its end back, so earlier offsets stay right. Returns the files it changed and how many places.
function applyEdit(root, edit) {
  const byUri = new Map(Object.entries(edit?.changes || {}));
  for (const dc of edit?.documentChanges || []) if (dc.textDocument && dc.edits) byUri.set(dc.textDocument.uri, [...(byUri.get(dc.textDocument.uri) || []), ...dc.edits]);
  const files = [];
  let count = 0;
  for (const [uri, edits] of byUri) {
    if (!uri.startsWith('file:')) continue;
    const file = fileURLToPath(uri);
    const rel = path.relative(root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !edits.length) continue;
    const text = fs.readFileSync(file, 'utf8');
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    const off = (p) => Math.min(text.length, (starts[p.line] ?? text.length) + p.character);
    let out = text;
    for (const e of [...edits].sort((a, b) => off(b.range.start) - off(a.range.start))) out = out.slice(0, off(e.range.start)) + e.newText + out.slice(off(e.range.end));
    fs.writeFileSync(file, out);
    files.push(rel.split(path.sep).join('/'));
    count += edits.length;
  }
  return { files, count };
}

// Install: the npm servers into <home>/lsp, so every task folder finds them.
export function installArgs(lang, home) {
  const pkgs = SERVERS[lang]?.npm;
  return pkgs ? { dir: path.join(home, 'lsp'), args: ['install', '--no-audit', '--no-fund', '--prefix', path.join(home, 'lsp'), ...pkgs] } : null;
}
