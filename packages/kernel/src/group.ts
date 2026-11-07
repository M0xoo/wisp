// Plugin groups (plan §6.3, Bevy's PluginGroupBuilder): the product is a list, and a list is data the
// app passes to the kernel. `build()` returns an editable copy; a disabled plugin keeps its slot so
// enabling it again puts it back where it was.
import type { Manifest, PluginDef } from './contract.ts';

export interface GroupEntry {
  manifest: Manifest;
  /** absent for a declarative plugin (a manifest only) and for the exec tier */
  def?: PluginDef;
  /** the folder its exec command and relative paths are resolved from */
  root?: string;
  builtin?: boolean;
}

export interface PluginGroup {
  readonly id: string;
  readonly entries: readonly Readonly<{ entry: GroupEntry; enabled: boolean }>[];
}

export function pluginGroup(id: string, entries: readonly GroupEntry[]): PluginGroup {
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.manifest.id)) throw new Error(`group ${id}: ${e.manifest.id} is listed twice`);
    seen.add(e.manifest.id);
  }
  return Object.freeze({ id, entries: Object.freeze(entries.map((entry) => Object.freeze({ entry, enabled: true }))) });
}

export class PluginGroupBuilder {
  readonly #id: string;
  #rows: { entry: GroupEntry; enabled: boolean }[];
  constructor(group: PluginGroup) {
    this.#id = group.id;
    this.#rows = group.entries.map((r) => ({ ...r }));
  }
  #index(id: string): number {
    const i = this.#rows.findIndex((r) => r.entry.manifest.id === id);
    if (i < 0) throw new Error(`group ${this.#id} has no plugin ${id}`);
    return i;
  }
  #insert(at: number, entry: GroupEntry): this {
    if (this.#rows.some((r) => r.entry.manifest.id === entry.manifest.id)) throw new Error(`group ${this.#id} already has ${entry.manifest.id}`);
    this.#rows.splice(at, 0, { entry, enabled: true });
    return this;
  }
  disable(id: string): this {
    const row = this.#rows[this.#index(id)];
    if (row) row.enabled = false;
    return this;
  }
  enable(id: string): this {
    const row = this.#rows[this.#index(id)];
    if (row) row.enabled = true;
    return this;
  }
  add(entry: GroupEntry): this {
    return this.#insert(this.#rows.length, entry);
  }
  addAfter(id: string, entry: GroupEntry): this {
    return this.#insert(this.#index(id) + 1, entry);
  }
  addBefore(id: string, entry: GroupEntry): this {
    return this.#insert(this.#index(id), entry);
  }
  /** Replace a plugin in its slot (an override by id keeps the slot and its enabled state). */
  set(entry: GroupEntry): this {
    const row = this.#rows[this.#index(entry.manifest.id)];
    if (row) row.entry = entry;
    return this;
  }
  /** Every enabled and disabled id, in order. */
  ids(): string[] {
    return this.#rows.map((r) => r.entry.manifest.id);
  }
  finish(id: string = this.#id): PluginGroup {
    return Object.freeze({ id, entries: Object.freeze(this.#rows.map((r) => Object.freeze({ ...r }))) });
  }
}

/** `build(DefaultPlugins).disable('wisp.telemetry').addAfter('wisp.runtime', mine).finish()`. */
export const build = (group: PluginGroup): PluginGroupBuilder => new PluginGroupBuilder(group);
