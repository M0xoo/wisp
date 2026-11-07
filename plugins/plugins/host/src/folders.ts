// User plugins that are folders: ~/.wisp/plugins/<folder>/wisp-plugin.json (plan §6.0.4). Each is
// checked with the kernel's validateManifest, installed into the kernel from its folder, and on or
// off by plugins_state like a spell. A manifest-only plugin can also be installed from its JSON: it
// gets a folder of its own named after its id.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { PluginHost, Source } from '@wisp-plugin/plugins-api';
import { validateManifest, type Manifest } from '@wisp/kernel';
import { bad, messageOf } from './errors.ts';
import { clip } from './schema.ts';
import type { State } from './state.ts';
import { writeAtomic } from './spells.ts';

export const MANIFEST = 'wisp-plugin.json';

export interface Folder {
  manifest: Manifest;
  dir: string;
}

export interface FolderDeps {
  home: string;
  state: State;
  safe: boolean;
  host(): PluginHost | undefined;
  warn(msg: string): void;
}

/** The manifest, checked, or every problem in one refusal. */
export function checkManifest(raw: unknown): Manifest {
  const r = validateManifest(raw);
  if (r.ok) return r.manifest;
  const problems = r.errors.map((e) => `${e.path || '(root)'}: ${e.message}`);
  throw bad(`This plugin has ${problems.length} problem${problems.length > 1 ? 's' : ''}:\n- ${problems.join('\n- ')}`, 400, problems);
}

export class Folders {
  readonly dir: string;
  readonly plugins = new Map<string, Folder>();
  /** folder name → why it couldn't be loaded */
  readonly broken = new Map<string, string>();
  readonly #d: FolderDeps;

  constructor(d: FolderDeps) {
    this.#d = d;
    this.dir = path.join(d.home, 'plugins');
  }

  async load(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    for (const e of await fs.readdir(this.dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      try {
        await this.#read(path.join(this.dir, e.name));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // a folder of something else
        this.broken.set(e.name, clip(messageOf(err), 400));
      }
    }
    for (const f of this.plugins.values()) await this.#register(f, this.isOn(f.manifest.id));
  }

  async #read(dir: string): Promise<Folder> {
    const m = checkManifest(JSON.parse(await fs.readFile(path.join(dir, MANIFEST), 'utf8')));
    const had = this.plugins.get(m.id);
    if (had && had.dir !== dir) throw bad(`${m.id} is already in ${path.basename(had.dir)}`, 409);
    const f = { manifest: m, dir };
    this.plugins.set(m.id, f);
    this.broken.delete(path.basename(dir));
    return f;
  }

  isOn(id: string): boolean {
    return !this.#d.safe && this.#d.state.get(id)?.enabled === true;
  }

  get(id: string): Folder | undefined {
    return this.plugins.get(id);
  }

  /** A folder inside ~/.wisp/plugins (by name or full path), or a manifest to give a folder. */
  async install(o: { dir?: string; manifest?: unknown; source?: Source | null; enable?: boolean }): Promise<{ plugin: Folder; updated: boolean }> {
    let dir: string;
    if (o.manifest !== undefined) {
      const m = checkManifest(o.manifest);
      if (m.server) throw bad('A plugin with server code is installed as a folder in ~/.wisp/plugins, not from its manifest alone.');
      dir = this.plugins.get(m.id)?.dir ?? path.join(this.dir, m.id);
      await writeAtomic(path.join(dir, MANIFEST), `${JSON.stringify(m, null, 2)}\n`);
    } else {
      dir = path.resolve(this.dir, String(o.dir ?? ''));
      if (path.dirname(dir) !== this.dir) throw bad(`A plugin folder is one inside ${this.dir}.`);
    }
    const before = [...this.plugins.values()].find((f) => f.dir === dir);
    const f = await this.#read(dir);
    const row = this.#d.state.put(f.manifest.id, 'plugin', { source: o.source ?? { kind: 'folder', name: path.basename(dir), at: 0 }, enable: o.enable === true });
    await this.#register(f, row.enabled && !this.#d.safe);
    return { plugin: f, updated: !!before };
  }

  async setEnabled(id: string, on: boolean): Promise<Folder> {
    const f = this.plugins.get(id);
    if (!f) throw bad('no such plugin', 404);
    const host = this.#d.host();
    if (host) {
      if (!host.manifest(id)) await host.install(f.manifest, f.dir);
      if (on) await host.enable(id);
      else await host.disable(id);
    }
    this.#d.state.setEnabled(id, 'plugin', on);
    return f;
  }

  /** Forgets it; its folder stays unless `files` (a folder is the user's, a written manifest is ours). */
  async remove(id: string, o: { files?: boolean } = {}): Promise<void> {
    const f = this.plugins.get(id);
    if (!f) throw bad('no such plugin', 404);
    const host = this.#d.host();
    if (host?.manifest(id)) await host.remove(id);
    if (o.files) await fs.rm(f.dir, { recursive: true, force: true });
    this.plugins.delete(id);
    this.#d.state.remove(id);
  }

  async #register(f: Folder, on: boolean): Promise<void> {
    const host = this.#d.host();
    if (!host) return;
    try {
      await host.install(f.manifest, f.dir);
      if (on) await host.enable(f.manifest.id);
    } catch (err) {
      this.#d.warn(`plugin ${f.manifest.id}: ${messageOf(err)}`);
    }
  }
}
