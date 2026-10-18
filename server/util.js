// Small helpers shared across the server. Nothing here imports another wisp module, so any
// file can use it without dragging in the runner, the store or an adapter.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const DEFAULT_PORT = 4477;
// The modes a session can run in: read-only planning, edits with approval rules, or full auto.
export const MODES = new Set(['plan', 'edits', 'auto']);

export const newId = () => randomUUID().replace(/-/g, '').slice(0, 12);

// An error the HTTP layer answers with `status` (400 unless said otherwise) and its message.
export const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// ~ and ~/x → the home folder. `expandHome` keeps the string as typed otherwise; `expand` also resolves it.
export const expandHome = (p) => String(p).replace(/^~(?=$|[\\/])/, os.homedir());
export const expand = (p) => path.resolve(expandHome(p));

// wisp's own copies of harness CLIs, installed from the app when there's none (~/.wisp/tools).
export const toolsDir = () => path.join(process.env.WISP_HOME || path.join(os.homedir(), '.wisp'), 'tools');

// Single-quote for a POSIX shell.
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// One line, at most n characters (whitespace collapsed).
export function clip(s, n = 80) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// Write JSON so a crash mid-write never leaves a half file behind: tmp file, then rename.
export function writeJsonAtomic(file, data, space) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, space));
  fs.renameSync(`${file}.tmp`, file);
}

// At most n characters, line breaks kept (messages, not one-liners).
export const truncate = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));
