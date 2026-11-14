// The extension host's core (plan §6.6): what every plugin registered, resolved per input. Plain
// TypeScript on the client's signals, no DOM, so the rules are tested in Node:
//
//   1. an extension with `overrides: X` takes X's place (X's slot and order unless it sets its own);
//      two overrides of one X: the later plugin wins, and the shell warns
//   2. tree config from every plugin, later plugins winning key by key: `disable` removes,
//      `attach` moves to another input, `order` places, `config` is parsed by the extension's own
//      `config.parse` (a value it refuses keeps the default, with a warning)
//   3. siblings sort by order, then by registration: stable, so a re-register never reshuffles
//
// `if` is not applied here: it reads the render's props (the session), so the slot applies it.

import { computed, signal, untracked, type Readable } from '@wisp/client';
import type { BlockRendererDef, ExtensionDef, PaletteSourceDef, PluginUiDef, PromptSourceDef, ResolvedExtension, SettingsPaneDef, ShortcutDef, SideTabDef, TreeConfig, ViewDef, HarnessUiDef } from './contract.ts';

export type Warn = (msg: string, data?: unknown) => void;

interface Entry {
  readonly plugin: string;
  readonly def: PluginUiDef;
  readonly index: number;
}

export interface Registry {
  add(def: PluginUiDef): void;
  remove(id: string): void;
  has(id: string): boolean;
  plugins(): readonly string[];
  /** the extensions on one input; the same array until something on that input changes */
  input(id: string): Readable<readonly ResolvedExtension[]>;
  settingsPanes: Readable<readonly SettingsPaneDef[]>;
  harnesses: Readable<readonly HarnessUiDef[]>;
  palette: Readable<readonly (PaletteSourceDef & { plugin: string })[]>;
  prompt: Readable<readonly (PromptSourceDef & { plugin: string })[]>;
  sideTabs: Readable<readonly (SideTabDef & { plugin: string })[]>;
  shortcuts: Readable<readonly (ShortcutDef & { plugin: string })[]>;
  block(type: string): BlockRendererDef | undefined;
  view(kind: string): ViewDef | undefined;
  /** the plugin that registered a view kind (the last one, as `view`) */
  viewOwner(kind: string): string | undefined;
}

const ORDER_STEP = 10;

function mergeTree(entries: readonly Entry[]): Required<TreeConfig> {
  const out: Required<TreeConfig> = { disable: [], config: {}, attach: {}, order: {} };
  for (const { def } of entries) {
    const t = def.tree;
    if (!t) continue;
    out.disable.push(...(t.disable ?? []));
    Object.assign(out.config, t.config);
    Object.assign(out.attach, t.attach);
    Object.assign(out.order, t.order);
  }
  return out;
}

function parseConfig(ext: ExtensionDef, raw: unknown, warn: Warn): Record<string, unknown> {
  const c = ext.config;
  if (!c) return {};
  if (raw === undefined) return c.default;
  try {
    return c.parse(raw);
  } catch (err) {
    warn(`config for ${ext.id} refused; it keeps its default`, String(err));
    return c.default;
  }
}

/** Every extension, overrides applied: id → [the extension in effect, where it came from]. */
function effective(entries: readonly Entry[], warn: Warn): Map<string, { ext: ExtensionDef; plugin: string; at: number }> {
  const byId = new Map<string, { ext: ExtensionDef; plugin: string; at: number }>();
  const overrides: { ext: ExtensionDef; plugin: string; at: number }[] = [];
  let at = 0;
  for (const e of entries) {
    for (const ext of e.def.extensions ?? []) {
      at += 1;
      if (ext.overrides) overrides.push({ ext, plugin: e.plugin, at });
      else if (byId.has(ext.id)) warn(`extension ${ext.id} is registered twice; the first stays`);
      else byId.set(ext.id, { ext, plugin: e.plugin, at });
    }
  }
  const taken = new Map<string, string>();
  for (const o of overrides) {
    const target = o.ext.overrides ?? '';
    const was = byId.get(target);
    const prev = taken.get(target);
    if (prev) warn(`${o.ext.id} and ${prev} both override ${target}; ${o.ext.id} wins`);
    taken.set(target, o.ext.id);
    byId.delete(target);
    // it takes the replaced one's place in the order unless it brings its own
    byId.set(target, { ext: o.ext, plugin: o.plugin, at: was?.at ?? o.at });
  }
  return byId;
}

function resolveAll(entries: readonly Entry[], warn: Warn): Map<string, ResolvedExtension[]> {
  const tree = mergeTree(entries);
  const disabled = new Set(tree.disable);
  const out = new Map<string, ResolvedExtension[]>();
  for (const [key, { ext, plugin, at }] of effective(entries, warn)) {
    if (disabled.has(key) || disabled.has(ext.id)) continue;
    const where = tree.attach[ext.id] ?? tree.attach[key] ?? ext.attachTo;
    const input = where.input ? `${where.id}:${where.input}` : where.id;
    const order = tree.order[ext.id] ?? tree.order[key] ?? ext.order ?? at * ORDER_STEP;
    const resolved: ResolvedExtension = { id: ext.id, plugin, def: ext, config: parseConfig(ext, tree.config[ext.id] ?? tree.config[key], warn), order };
    const list = out.get(input) ?? [];
    list.push(resolved);
    out.set(input, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.order - b.order);
  return out;
}

const sameList = (a: readonly ResolvedExtension[], b: readonly ResolvedExtension[]): boolean =>
  a.length === b.length && a.every((x, i) => {
    const y = b[i];
    return y !== undefined && x.def === y.def && x.order === y.order && JSON.stringify(x.config) === JSON.stringify(y.config);
  });

const EMPTY: readonly ResolvedExtension[] = Object.freeze([]);

// size-ok: a factory of small closures over one registration list
export function createRegistry(warn: Warn = () => {}): Registry {
  const entries = signal<readonly Entry[]>([]);
  let counter = 0;
  const all = computed(() => resolveAll(entries(), warn));
  const inputs = new Map<string, Readable<readonly ResolvedExtension[]>>();
  const flat = <T>(pick: (d: PluginUiDef) => readonly T[] | undefined): Readable<readonly (T & { plugin: string })[]> =>
    computed(() => entries().flatMap((e) => (pick(e.def) ?? []).map((x) => ({ ...x, plugin: e.plugin }))));
  const lastBy = <T>(pick: (d: PluginUiDef) => readonly T[] | undefined, key: (x: T) => string, want: string): T | undefined => {
    let found: T | undefined;
    for (const e of untracked(entries)) for (const x of pick(e.def) ?? []) if (key(x) === want) found = x;
    return found;
  };

  return {
    add(def) {
      if (untracked(entries).some((e) => e.plugin === def.id)) throw new Error(`plugin UI ${def.id} is registered twice`);
      counter += 1;
      entries([...untracked(entries), { plugin: def.id, def, index: counter }]);
    },
    remove(id) {
      entries(untracked(entries).filter((e) => e.plugin !== id));
    },
    has: (id) => untracked(entries).some((e) => e.plugin === id),
    plugins: () => untracked(entries).map((e) => e.plugin),
    input(id) {
      let r = inputs.get(id);
      if (!r) {
        let last: readonly ResolvedExtension[] = EMPTY;
        r = computed(() => {
          const next = all().get(id) ?? EMPTY;
          if (!sameList(last, next)) last = next;
          return last;
        });
        inputs.set(id, r);
      }
      return r;
    },
    settingsPanes: computed(() => flat((d) => d.settings)().slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))),
    harnesses: computed(() => flat((d) => d.harnesses)().slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))),
    palette: computed(() => flat((d) => d.palette)().slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))),
    prompt: computed(() => flat((d) => d.prompt)().slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))),
    sideTabs: computed(() => flat((d) => d.sideTabs)().slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))),
    shortcuts: flat((d) => d.shortcuts),
    // a later plugin's renderer for the same block type wins: that's how one is replaced
    block: (type) => lastBy((d) => d.blocks, (b) => b.type, type),
    view: (kind) => lastBy((d) => d.views, (v) => v.kind, kind),
    viewOwner(kind) {
      let owner: string | undefined;
      for (const e of untracked(entries)) if ((e.def.views ?? []).some((v) => v.kind === kind)) owner = e.plugin;
      return owner;
    },
  };
}
