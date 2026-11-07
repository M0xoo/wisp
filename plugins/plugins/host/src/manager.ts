// The plugin manager: spells and folder plugins together, as the commands see them. Every command
// in commands.ts is a thin call into one of these methods; the routes are thin calls into commands.

import type { CheckBad, CheckOk, PluginHost, PluginView, Risk, Section, Source, SpellView, Vocabulary } from '@wisp-plugin/plugins-api';
import { spellPluginId, type Manifest, type PluginStatus } from '@wisp/kernel';
import { checkSpell, type Checked } from './check.ts';
import type { DataSources, DataTask } from './data.ts';
import { describeSpell } from './describe.ts';
import { recipesOf, settingsOf } from './effects.ts';
import { bad } from './errors.ts';
import { checkManifest, type Folder, Folders } from './folders.ts';
import { type Fetch, fetchShared, parseJson } from './shared.ts';
import { Spells } from './spells.ts';
import type { State } from './state.ts';
import type { Spell } from './types.ts';
import { mergeVocab, type Vocab } from './vocabulary.ts';

export interface ManagerDeps {
  home: string;
  state: State;
  safe: boolean;
  host(): PluginHost | undefined;
  vocabularies(): readonly Vocabulary[];
  sections(): readonly Section[];
  data: DataSources;
  fetch: Fetch;
  /** a task for a data source: its folder and summary (fields fill {templates}) */
  task(id: string): Promise<DataTask | null>;
  warn(msg: string): void;
}

/** What a request body names: { spell }, { plugin }, { text } (pasted), { url } (fetched) or { dir }. */
export interface Given {
  spell?: unknown;
  plugin?: unknown;
  text?: unknown;
  name?: unknown;
  url?: unknown;
  dir?: unknown;
  source?: unknown;
}

type Raw = { json: unknown; source: Omit<Source, 'at'> | null } | { dir: string };

const isPlugin = (j: unknown): boolean => typeof j === 'object' && j !== null && (j as Record<string, unknown>)['wispPlugin'] !== undefined;

export class Manager {
  readonly spells: Spells;
  readonly folders: Folders;
  readonly #d: ManagerDeps;

  constructor(d: ManagerDeps) {
    this.#d = d;
    this.spells = new Spells({ home: d.home, state: d.state, safe: d.safe, check: (raw) => this.check(raw), describe: (s) => this.describe(s), host: d.host, warn: d.warn });
    this.folders = new Folders({ home: d.home, state: d.state, safe: d.safe, host: d.host, warn: d.warn });
  }

  async load(): Promise<void> {
    await this.spells.load();
    await this.folders.load();
    // Built-ins the user switched off in Settings → Plugins stay off across restarts.
    const host = this.#d.host();
    for (const r of this.#d.state.all()) {
      if (r.kind !== 'plugin' || r.enabled || this.folders.get(r.id) || !host?.list().some((s) => s.id === r.id && s.builtin)) continue;
      await host.disable(r.id).catch((err: unknown) => this.#d.warn(`${r.id}: ${(err as Error).message}`));
    }
  }

  vocab(): Vocab {
    return mergeVocab(this.#d.vocabularies());
  }

  #crew(): Section | undefined {
    return this.#d.sections().find((s) => s.key === 'crew');
  }

  check(raw: unknown): Checked {
    return checkSpell(raw, { vocab: this.vocab(), sections: new Map(this.#d.sections().map((s) => [s.key, s])) });
  }

  describe(s: Spell): { lines: string[]; kind: Risk } {
    return describeSpell(s, this.#crew());
  }

  /** The body's file: pasted text, a link, a folder, or the object itself. */
  async given(body: Given): Promise<Raw> {
    if (body.url) {
      const { json, source } = await fetchShared(this.#d.fetch, body.url, 'spell');
      return { json, source };
    }
    if (typeof body.dir === 'string') return { dir: body.dir };
    if (typeof body.text === 'string') return { json: parseJson(body.text), source: { kind: 'file', name: String(body.name ?? '') } };
    const obj = body.spell ?? body.plugin;
    if (obj && typeof obj === 'object') {
      const s = body.source && typeof body.source === 'object' ? (body.source as Record<string, unknown>) : null;
      return { json: obj, source: s ? { kind: String(s['kind'] || 'local'), ...(s['session'] ? { session: String(s['session']) } : {}) } : null };
    }
    throw bad('Send { spell }, { text } or { url }.');
  }

  /** Validate without installing: what it does, its riskiest kind, problems or warnings. */
  async checkBody(body: Given): Promise<CheckOk | CheckBad> {
    const raw = await this.given(body);
    if ('dir' in raw) throw bad('Send { spell }, { text } or { url }.');
    try {
      if (isPlugin(raw.json)) {
        const m = checkManifest(raw.json);
        const was = this.folders.get(m.id);
        return { ok: true, spell: m as unknown as Record<string, unknown>, summary: manifestLines(m), kind: manifestRisk(m), warnings: [], installed: was ? { version: was.manifest.version, enabled: this.folders.isOn(m.id), same: JSON.stringify(was.manifest) === JSON.stringify(m) } : null };
      }
      const { spell, warnings } = this.check(raw.json);
      const d = this.describe(spell);
      const was = this.spells.get(spell.id);
      return { ok: true, spell: spell as unknown as Record<string, unknown>, summary: d.lines, kind: d.kind, warnings, installed: was ? { version: was.version, enabled: this.spells.isOn(spell.id), same: JSON.stringify(was) === JSON.stringify(spell) } : null };
    } catch (err) {
      const problems = (err as { problems?: readonly string[] }).problems;
      if (!problems) throw err;
      return { ok: false, problems: [...problems], error: (err as Error).message };
    }
  }

  /** Install (or update). Off unless enable: true, which only the user's own click sends. */
  async install(body: Given & { enable?: unknown }): Promise<{ spell?: SpellView; plugin?: PluginView; warnings: string[]; updated: boolean }> {
    const raw = await this.given(body);
    const enable = body.enable === true;
    if ('dir' in raw || isPlugin(raw.json)) {
      const o = 'dir' in raw ? { dir: raw.dir } : { manifest: raw.json, source: raw.source ? { ...raw.source, at: 0 } : null };
      const { plugin, updated } = await this.folders.install({ ...o, enable });
      return { plugin: this.folderView(plugin), warnings: [], updated };
    }
    return this.spells.install(raw.json, { source: raw.source ? { ...raw.source, at: 0 } : null, enable });
  }

  /** v1 PATCH /spells/:id, and /plugins/:id with a plugin id ('user.<spell>' for a spell). */
  async setEnabled(id: string, on: boolean): Promise<SpellView | PluginView> {
    const spell = this.#spellId(id);
    if (spell) return this.spells.setEnabled(spell, on);
    if (this.folders.get(id)) return this.folderView(await this.folders.setEnabled(id, on));
    return this.builtin(id, on);
  }

  /** A built-in plugin switched off or on in Settings → Plugins: the kernel's to do, and remembered here. */
  async builtin(id: string, on: boolean): Promise<PluginView> {
    if (id === 'wisp.plugins') throw bad('The plugin manager stays on: start wisp with WISP_SAFE=1 to turn every user plugin off.', 409);
    const host = this.#d.host();
    const st = host?.list().find((s) => s.id === id);
    if (!host || !st) throw bad('no such plugin', 404);
    const after = on ? await host.enable(id) : await host.disable(id);
    this.#d.state.setEnabled(id, 'plugin', on);
    return statusView(after, host.manifest(id));
  }

  async allOff(): Promise<void> {
    for (const s of this.spells.enabled()) await this.spells.setEnabled(s.id, false);
    for (const f of this.folders.plugins.values()) if (this.folders.isOn(f.manifest.id)) await this.folders.setEnabled(f.manifest.id, false);
  }

  async remove(id: string): Promise<void> {
    const spell = this.#spellId(id);
    if (spell !== undefined && (this.spells.get(spell) || this.spells.broken.has(spell))) return this.spells.remove(spell);
    if (this.folders.get(id)) return this.folders.remove(id, { files: this.#d.state.get(id)?.source?.kind !== 'folder' });
    throw bad(spell !== undefined ? 'no such spell' : 'no such plugin', 404);
  }

  /** 'my-prs' (v1) and 'user.my-prs' (its plugin id) both name a spell. */
  #spellId(id: string): string | undefined {
    if (this.spells.get(id) || this.spells.broken.has(id)) return id;
    const m = /^user\.([a-z0-9][a-z0-9-]*)$/.exec(id);
    if (m?.[1] && (this.spells.get(m[1]) || this.spells.broken.has(m[1]))) return m[1];
    return /^[a-z0-9][a-z0-9-]*$/.test(id) ? id : undefined;
  }

  async data(spell: Spell, name: string, o: { session?: unknown; fresh?: boolean; prefix?: string }): Promise<unknown> {
    const source = spell.data?.[name];
    if (!source) throw bad(`${spell.name} has no data source ${name}`, 404);
    const task = o.session ? await this.#d.task(String(o.session)) : null;
    return this.#d.data.get(`${o.prefix ?? ''}${spell.id}`, name, source, { task, fresh: o.fresh === true });
  }

  locks(): ReturnType<typeof settingsOf> {
    return settingsOf(this.spells.enabled());
  }

  recipes(): Record<string, unknown>[] {
    return recipesOf(this.spells.enabled());
  }

  folderView(f: Folder): PluginView {
    const st = this.#d.host()?.list().find((s) => s.id === f.manifest.id);
    return { ...manifestView(f.manifest), kind: 'plugin', enabled: this.folders.isOn(f.manifest.id), builtin: false, source: this.#d.state.get(f.manifest.id)?.source ?? null, state: st?.state ?? 'unknown', ...(st?.reason && { reason: st.reason }) };
  }

  spellView(s: Spell): PluginView {
    const v = this.spells.view(s);
    const st = this.#d.host()?.list().find((x) => x.id === spellPluginId(s.id));
    return { id: spellPluginId(s.id), name: s.name, version: s.version, description: s.description, kind: 'spell', enabled: v.enabled, builtin: false, source: v.source, summary: v.summary, risk: v.kind, state: st?.state ?? 'unknown', ...(st?.reason && { reason: st.reason }), trust: s.script ? 'untrusted' : 'declarative' };
  }

  /** Settings → Plugins: the user's plugins first (spells among them), then the built-ins. */
  views(): PluginView[] {
    const mine = [...[...this.spells.spells.values()].map((s) => this.spellView(s)), ...[...this.folders.plugins.values()].map((f) => this.folderView(f))].sort((a, b) => a.name.localeCompare(b.name));
    const ids = new Set(mine.map((v) => v.id));
    const host = this.#d.host();
    const builtins = (host?.list() ?? []).filter((s) => s.builtin && !ids.has(s.id)).map((s) => statusView(s, host?.manifest(s.id)));
    return [...mine, ...builtins];
  }
}

function manifestLines(m: Manifest): string[] {
  const c = m.contributes ?? {};
  const n = (k: string, what: string): string[] => {
    const v = (c as Record<string, unknown>)[k];
    const len = Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0;
    return len ? [`${what}: ${len}`] : [];
  };
  return [...(m.description ? [m.description] : []), ...n('ui', 'Adds to the UI'), ...n('commands', 'Commands'), ...n('partStyles', 'Restyles parts'), ...n('setSettings', 'Sets settings'), ...(m.server ? ['Runs its own code'] : []), ...(m.permissions?.length ? [`Asks for ${m.permissions.join(', ')}`] : [])];
}

const manifestRisk = (m: Manifest): Risk => (m.server ? 'runs' : m.permissions?.length ? 'reads' : 'safe');

function manifestView(m: Manifest): Omit<PluginView, 'kind' | 'enabled' | 'builtin' | 'source' | 'state'> {
  return { id: m.id, name: m.name ?? m.id, version: m.version, description: m.description ?? '', summary: manifestLines(m), risk: manifestRisk(m), trust: m.trust ?? (m.server ? 'untrusted' : 'declarative') };
}

function statusView(s: PluginStatus, m: Manifest | undefined): PluginView {
  const base = m ? manifestView(m) : { id: s.id, name: s.id, version: s.version, description: '', summary: [], risk: 'safe' as Risk, trust: s.trust };
  return { ...base, id: s.id, version: s.version, kind: 'plugin', enabled: s.state !== 'off' && s.state !== 'refused', builtin: s.builtin, source: null, state: s.state, ...(s.reason && { reason: s.reason }), trust: s.trust };
}
