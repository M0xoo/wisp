// Harnesses that sign in with an API key pasted into wisp (HarnessKeys: opencode Zen and Go), v1
// agent-login.js keysOf / setKey / removeKey. The key goes where the CLI keeps its own (auth.json, as
// `{ type: 'api', key }` per provider), next to the user's other providers' logins: a file wisp
// can't read is never overwritten. Which providers have a key comes back, never the key.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { HarnessKeys } from '@wisp-plugin/runtime-api';
import type { KeysView } from '@wisp-plugin/accounts-api';
import { bad, rec } from './ports.ts';

async function readAuth(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (rec(err)['code'] === 'ENOENT') return {};
    throw err;
  }
  try {
    const v: unknown = JSON.parse(text || '{}');
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // not JSON: refused below
  }
  // Never overwrite a file we can't read: it holds the user's other providers' logins too.
  throw bad(`wisp can’t read ${file}: fix or remove it, then try again.`, 409);
}

async function writeAuth(file: string, auth: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}

export class KeyLogins {
  readonly #keys: (id: string) => HarnessKeys | undefined;
  readonly #env: Record<string, string | undefined>;
  readonly #home: string;

  constructor(keys: (id: string) => HarnessKeys | undefined, env: Record<string, string | undefined>, home: string) {
    this.#keys = keys;
    this.#env = env;
    this.#home = home;
  }

  #spec(id: string): HarnessKeys {
    const k = this.#keys(id);
    if (!k) throw bad(`${id} doesn’t sign in with a key.`, 400);
    return k;
  }

  #provider(id: string, pid: string): HarnessKeys {
    const k = this.#spec(id);
    if (!k.providers.some((p) => p.id === pid)) throw bad(`Pick one of ${k.providers.map((p) => p.name).join(', ')}.`, 400);
    return k;
  }

  /** Which providers have a key. `env`: the env var that signs every one in, when wisp has it. */
  async view(id: string): Promise<KeysView> {
    const k = this.#spec(id);
    const auth = await readAuth(k.file(this.#env, this.#home));
    return { agent: id, url: k.url, env: this.#env[k.env] ? k.env : '', providers: k.providers.map((p) => ({ ...p, set: !!auth[p.id] })) };
  }

  async set(id: string, pid: string, key: unknown): Promise<KeysView> {
    const k = this.#provider(id, pid);
    const v = String(key || '').trim();
    if (!v || v.length > 500 || /\s/.test(v)) throw bad(`Paste the API key from ${k.url}.`, 400);
    const file = k.file(this.#env, this.#home);
    await writeAuth(file, { ...(await readAuth(file)), [pid]: { type: 'api', key: v } });
    return this.view(id);
  }

  async remove(id: string, pid: string): Promise<KeysView> {
    const k = this.#provider(id, pid);
    const file = k.file(this.#env, this.#home);
    const auth = await readAuth(file);
    if (auth[pid]) {
      delete auth[pid];
      await writeAuth(file, auth);
    }
    return this.view(id);
  }
}
