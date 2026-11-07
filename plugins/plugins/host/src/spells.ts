// The user's v1 spells (v1 server/spells.js `Spells`): ~/.wisp/spells/<id>.json files, checked on
// load, on or off by plugins_state. Each is also a plugin to the kernel: its converted manifest
// (convertSpell) is installed and switched with it, so its UI, parts and settings apply like any
// plugin's. What a spell does to tasks (prompt rules, agent blocks, hooks) wisp.plugins applies
// itself, through the runtime's points, from the checked spell.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { PluginHost, Risk, Source, SpellView } from '@wisp-plugin/plugins-api';
import { convertSpell, spellPluginId, type Manifest } from '@wisp/kernel';
import type { Checked } from './check.ts';
import { bad, messageOf } from './errors.ts';
import { clip } from './schema.ts';
import type { State } from './state.ts';
import type { Spell } from './types.ts';

export interface SpellDeps {
  home: string;
  state: State;
  safe: boolean;
  check(raw: unknown): Checked;
  describe(s: Spell): { lines: string[]; kind: Risk };
  host(): PluginHost | undefined;
  warn(msg: string): void;
}

export const spellHash = (s: Spell): string => createHash('sha256').update(JSON.stringify(s)).digest('hex').slice(0, 16);

// Point contributions wisp.plugins applies itself (scoped by `when`, which a manifest can't say).
const APPLIED_HERE = ['runtime.prompt', 'runtime.hooks'];

/** The manifest the kernel gets for a spell, or why there is none. */
export function spellManifest(s: Spell): { manifest: Manifest } | { error: string } {
  const r = convertSpell(s);
  if (!r.ok) return { error: r.errors.map((e) => `${e.path}: ${e.message}`).join('; ') };
  const contributes = { ...r.manifest.contributes } as Record<string, unknown>;
  for (const k of APPLIED_HERE) delete contributes[k];
  return { manifest: { ...r.manifest, contributes: contributes as Manifest['contributes'] & {} } };
}

export class Spells {
  readonly dir: string;
  readonly spells = new Map<string, Spell>();
  /** id → why the file couldn't be loaded */
  readonly broken = new Map<string, string>();
  readonly #d: SpellDeps;

  constructor(d: SpellDeps) {
    this.#d = d;
    this.dir = path.join(d.home, 'spells');
  }

  get safe(): boolean {
    return this.#d.safe;
  }

  /** Reads every file (a broken one is listed, not loaded), then tells the kernel about each. */
  async load(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    for (const f of await fs.readdir(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const { spell } = this.#d.check(JSON.parse(await fs.readFile(path.join(this.dir, f), 'utf8')));
        this.spells.set(spell.id, spell);
      } catch (err) {
        this.broken.set(f.replace(/\.json$/, ''), clip(messageOf(err), 400));
      }
    }
    for (const s of this.spells.values()) await this.#register(s, this.isOn(s.id));
  }

  enabled(): Spell[] {
    if (this.#d.safe) return [];
    return this.#d.state
      .enabled()
      .filter((r) => r.kind === 'spell')
      .flatMap((r) => this.spells.get(r.id) ?? []);
  }

  get(id: string): Spell | null {
    return this.spells.get(id) ?? null;
  }

  isOn(id: string): boolean {
    return !this.#d.safe && this.#d.state.get(id)?.enabled === true;
  }

  view(s: Spell): SpellView {
    const d = this.#d.describe(s);
    return { ...s, enabled: this.isOn(s.id), source: this.#d.state.get(s.id)?.source ?? null, hash: spellHash(s), summary: d.lines, kind: d.kind };
  }

  list(): { safe: boolean; spells: SpellView[]; broken: { id: string; error: string }[] } {
    return {
      safe: this.#d.safe,
      spells: [...this.spells.values()].map((s) => this.view(s)).sort((a, b) => a.name.localeCompare(b.name)),
      broken: [...this.broken].map(([id, error]) => ({ id, error })),
    };
  }

  /** Another spell must fit: its block types and slash names mustn't clash with one that's on. */
  clashes(s: Spell): string[] {
    const out: string[] = [];
    for (const o of this.enabled()) {
      if (o.id === s.id) continue;
      for (const b of s.blocks ?? []) if ((o.blocks ?? []).some((x) => x.type === b.type)) out.push(`block type ${b.type} is already ${o.name}'s`);
      for (const x of s.slash ?? []) if ((o.slash ?? []).some((y) => y.name === x.name)) out.push(`/${x.name} is already ${o.name}'s`);
    }
    return out;
  }

  /** Save (new or a new version). It stays off unless `enable` (and a new version of one on stays on). */
  async install(raw: unknown, o: { source?: Source | null; enable?: boolean } = {}): Promise<{ spell: SpellView; warnings: string[]; updated: boolean }> {
    const { spell, warnings } = this.#d.check(raw);
    const was = this.spells.get(spell.id);
    if (o.enable) {
      const c = this.clashes(spell);
      if (c.length) throw bad(`Can't turn ${spell.name} on: ${c.join('; ')}.`, 409);
    }
    await writeAtomic(path.join(this.dir, `${spell.id}.json`), `${JSON.stringify(spell, null, 2)}\n`);
    this.spells.set(spell.id, spell);
    this.broken.delete(spell.id);
    const row = this.#d.state.put(spell.id, 'spell', { source: o.source ?? null, enable: o.enable === true });
    await this.#register(spell, row.enabled && !this.#d.safe);
    return { spell: this.view(spell), warnings, updated: !!was };
  }

  async setEnabled(id: string, on: boolean): Promise<SpellView> {
    const s = this.spells.get(id);
    if (!s) throw bad('no such spell', 404);
    if (on) {
      const c = this.clashes(s);
      if (c.length) throw bad(`Can't turn ${s.name} on: ${c.join('; ')}.`, 409);
    }
    // The kernel first: a refusal there (a requirement that's off) leaves the user's choice as it was.
    await this.#switch(s, on);
    this.#d.state.setEnabled(id, 'spell', on);
    return this.view(s);
  }

  async remove(id: string): Promise<void> {
    if (!this.spells.has(id) && !this.broken.has(id)) throw bad('no such spell', 404);
    await fs.rm(path.join(this.dir, `${id}.json`), { force: true });
    const host = this.#d.host();
    if (host && this.spells.has(id) && host.manifest(spellPluginId(id))) await host.remove(spellPluginId(id));
    this.spells.delete(id);
    this.broken.delete(id);
    this.#d.state.remove(id);
  }

  /** The file to share: the spell as written, nothing about this machine. */
  exported(id: string): Spell {
    const s = this.spells.get(id);
    if (!s) throw bad('no such spell', 404);
    return { ...s };
  }

  /** What the kernel holds for it: the manifest installed, on or off. A kernel refusal is logged. */
  async #register(s: Spell, on: boolean): Promise<void> {
    const host = this.#d.host();
    if (!host) return;
    const m = spellManifest(s);
    if ('error' in m) return this.#d.warn(`spell ${s.id} has no plugin manifest: ${m.error}`);
    try {
      await host.install(m.manifest);
      if (on) await host.enable(m.manifest.id);
    } catch (err) {
      this.#d.warn(`spell ${s.id}: ${messageOf(err)}`);
    }
  }

  async #switch(s: Spell, on: boolean): Promise<void> {
    const host = this.#d.host();
    if (!host) return;
    const pid = spellPluginId(s.id);
    if (!host.manifest(pid)) {
      const m = spellManifest(s);
      if ('error' in m) throw bad(`${s.name} can't load as a plugin: ${m.error}`, 409);
      await host.install(m.manifest);
    }
    if (on) await host.enable(pid);
    else await host.disable(pid);
  }
}

/** temp + rename, so a crash mid-write never leaves half a file. */
export async function writeAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file);
}
