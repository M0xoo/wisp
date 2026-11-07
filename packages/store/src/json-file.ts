// The few files that stay files (plan §4.8: secrets.json, 0600, kept out of the DB and its backups).
// Written temp + rename, so a crash mid-write never leaves a cut-off file (v1 once loaded a truncated
// config.json as the defaults). Of two background saves, only the newer lands: an older one that
// finishes late is dropped instead of overwriting it.

import fs from 'node:fs';
import path from 'node:path';
import { StoreError } from './errors.ts';

export interface JsonFileOptions {
  /** file mode for new writes; 0o600 by default, since these files hold secrets */
  mode?: number;
  space?: number;
}

// On Windows a rename over a file someone holds open for a moment (a reader, antivirus, the search
// indexer) fails with EPERM/EACCES/EBUSY: wait it out briefly instead of failing (v1 util.js).
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRIES = 10;
const nap = new Int32Array(new SharedArrayBuffer(4));

export class JsonFile<T> {
  readonly path: string;
  readonly #mode: number;
  readonly #space: number | undefined;
  #n = 0;

  constructor(file: string, opts: JsonFileOptions = {}) {
    this.path = path.resolve(file);
    this.#mode = opts.mode ?? 0o600;
    this.#space = opts.space;
  }

  /** The value, or undefined when there is no file. A file that isn't JSON throws: never guess. */
  read(): T | undefined {
    let text: string;
    try {
      text = fs.readFileSync(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new StoreError('invalid', `${this.path} is not valid JSON: ${(err as Error).message}`);
    }
  }

  /** Writes now. Any background save still on its way is dropped when it lands. */
  write(value: T): void {
    const n = ++this.#n;
    const tmp = this.#tmp(n);
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const fd = fs.openSync(tmp, 'w', this.#mode);
    try {
      fs.writeSync(fd, this.#text(value));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameSyncRetrying(tmp, this.path);
  }

  /** Writes in the background. Resolves false when a newer write made this one moot. */
  async save(value: T): Promise<boolean> {
    const n = ++this.#n;
    const tmp = this.#tmp(n);
    await fs.promises.mkdir(path.dirname(this.path), { recursive: true });
    const fh = await fs.promises.open(tmp, 'w', this.#mode);
    try {
      await fh.writeFile(this.#text(value));
      await fh.sync();
    } finally {
      await fh.close();
    }
    if (this.#n !== n) {
      await fs.promises.rm(tmp, { force: true });
      return false;
    }
    renameSyncRetrying(tmp, this.path); // sync: nothing can start a newer write between check and rename
    return true;
  }

  /** Removes temp files a crash left behind (older than a minute, so no live write is touched). */
  cleanTemps(now = Date.now()): number {
    const dir = path.dirname(this.path);
    const base = path.basename(this.path);
    let n = 0;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return 0;
    }
    for (const f of names) {
      if (!f.startsWith(`${base}.`) || !f.endsWith('.tmp')) continue;
      const file = path.join(dir, f);
      if (now - fs.statSync(file).mtimeMs > 60_000) {
        fs.rmSync(file, { force: true });
        n++;
      }
    }
    return n;
  }

  #tmp(n: number): string {
    return `${this.path}.${process.pid}.${n}.tmp`;
  }

  #text(value: T): string {
    return `${JSON.stringify(value, null, this.#space)}\n`;
  }
}

function renameSyncRetrying(from: string, to: string): void {
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (!BUSY.has(String((err as NodeJS.ErrnoException).code)) || i >= RETRIES) throw err;
      Atomics.wait(nap, 0, 0, i * 10);
    }
  }
}
