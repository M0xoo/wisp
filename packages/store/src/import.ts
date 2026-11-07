// The v1 import mechanism (plan §4.8): v1 keeps one JSON file per session (sessions/<id>.json,
// written temp + rename; `.light/` summaries beside them) and a few config files. The owner plugin
// supplies the handler; this runs it one transaction per file and records (mtime, size) in meta in
// that same transaction, so an import stopped at any point resumes where it was, and a file v1
// rewrote since (dual-write release) is imported again.

import fs from 'node:fs';
import path from 'node:path';
import { invalid } from './errors.ts';
import type { Writer } from './types.ts';

export interface ImportFile {
  path: string;
  name: string;
  mtimeMs: number;
  size: number;
  read(): Buffer;
  text(): string;
  /** parsed JSON; a cut-off or corrupt file throws, and the file is recorded as failed */
  json(): unknown;
}

export interface ImportOptions {
  /** the import's name, owner-prefixed ('runtime.sessions'): its progress is kept under it */
  name: string;
  dir: string;
  /** which files in `dir` (not recursive) to import; `*.json` by default. Temp files never match. */
  pattern?: RegExp | ((name: string) => boolean);
  /** writes the file's rows; must be safe to run again for a file that changed (upsert, not insert) */
  handle(file: ImportFile, w: Writer): void;
  signal?: AbortSignal;
}

export interface ImportReport {
  imported: string[];
  /** already imported with the same mtime and size, or failed before and unchanged since */
  unchanged: number;
  failed: { file: string; error: string }[];
  /** true when the signal stopped it before the last file */
  stopped: boolean;
}

interface Mark {
  mtimeMs: number;
  size: number;
  error?: string;
}

export interface ImportHost {
  tx<T>(fn: (w: Writer) => T): T;
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string | undefined): void;
}

export async function importFiles(store: ImportHost, opts: ImportOptions): Promise<ImportReport> {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(opts.name)) throw invalid(`bad import name: ${opts.name}`);
  const match = matcher(opts.pattern);
  const report: ImportReport = { imported: [], unchanged: 0, failed: [], stopped: false };
  let names: string[];
  try {
    names = fs.readdirSync(opts.dir).filter((n) => !n.endsWith('.tmp') && match(n)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return report; // nothing to import
    throw err;
  }
  for (const name of names) {
    if (opts.signal?.aborted) {
      report.stopped = true;
      break;
    }
    importOne(store, opts, name, report);
    // A background import: let requests and streams run between files.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return report;
}

function importOne(store: ImportHost, opts: ImportOptions, name: string, report: ImportReport): void {
  const file = path.join(opts.dir, name);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return; // gone since the listing
  }
  if (!st.isFile()) return;
  const key = `import:${opts.name}:${name}`;
  const had = parseMark(store.getMeta(key));
  if (had && had.mtimeMs === st.mtimeMs && had.size === st.size) {
    report.unchanged++;
    return;
  }
  const mark: Mark = { mtimeMs: st.mtimeMs, size: st.size };
  try {
    store.tx((w) => {
      opts.handle(fileOf(file, name, st), w);
      store.setMeta(key, JSON.stringify(mark));
    });
    report.imported.push(name);
  } catch (err) {
    const error = (err as Error).message;
    // Recorded so it isn't retried on every start; a new mtime or size retries it.
    store.setMeta(key, JSON.stringify({ ...mark, error }));
    report.failed.push({ file: name, error });
  }
}

function fileOf(file: string, name: string, st: fs.Stats): ImportFile {
  let buf: Buffer | undefined;
  const read = (): Buffer => (buf ??= fs.readFileSync(file));
  return {
    path: file,
    name,
    mtimeMs: st.mtimeMs,
    size: st.size,
    read,
    text: () => read().toString('utf8'),
    json: () => JSON.parse(read().toString('utf8')) as unknown,
  };
}

function parseMark(v: string | undefined): Mark | undefined {
  if (v === undefined) return undefined;
  try {
    return JSON.parse(v) as Mark;
  } catch {
    return undefined;
  }
}

function matcher(p: ImportOptions['pattern']): (name: string) => boolean {
  if (p === undefined) return (n) => n.endsWith('.json');
  if (typeof p === 'function') return p;
  return (n) => p.test(n);
}

