// The product is a list (plan §6.3): the ONLY place wisp's features are named. Each group is plugin ids
// in order; a plugin is its host package `@wisp-plugin/<name>` (id `wisp.<name>`). An install edits a
// group with build(group).disable(…).addAfter(…), and Settings → Plugins switches one off at runtime.
//   DefaultPlugins   everything wisp ships: `wisp` on a laptop and the desktop app
//   BoxPlugins       Default minus machines and update: a grid box (notify:native and other machines are
//                    refused by the `box` capability set; its proc is the grid's)
//   HeadlessPlugins  runtime, the harnesses, git, mcp: CI, `wisp mcp`, servers
//   MinimalPlugins   runtime, one harness: the smallest working wisp, and the base for tests
import { pluginGroup, type GroupEntry, type PluginDef, type PluginGroup } from '@wisp/kernel';
import { entry, type CatalogEntry } from './catalog.ts';

const HARNESSES = ['claude', 'codex', 'cursor', 'opencode', 'copilot', 'grok', 'antigravity'];

export const DEFAULT = [
  'settings',
  'runtime',
  ...HARNESSES,
  'accounts',
  'git',
  'worktrees',
  'ship',
  'review',
  'issues',
  'terminal',
  'lsp',
  'machine',
  'machines',
  'grid-client',
  'crew',
  'goal',
  'later',
  'budget',
  'router',
  'automations',
  'learn',
  'channels',
  'telegram',
  'slack',
  'discord',
  'github',
  'email',
  'ntfy',
  'mcp',
  'connectors',
  'stuff',
  'plugins',
  'telemetry',
  'update',
] as const;

export const BOX_OFF = ['machines', 'update'] as const;
export const HEADLESS = ['settings', 'runtime', ...HARNESSES, 'accounts', 'git', 'worktrees', 'mcp'] as const;
export const MINIMAL = ['settings', 'runtime', 'claude'] as const;

export const pkgOf = (name: string): string => `@wisp-plugin/${name}`;

export interface Catalog {
  entries: Map<string, CatalogEntry>;
  /** named in a group but not loadable here (not built yet, or broken), with why */
  missing: Map<string, string>;
}

/** Reads the manifests of every plugin the groups name (boot only: a few small JSON files). */
export function loadCatalog(names: readonly string[] = DEFAULT, find: (pkg: string) => CatalogEntry = entry): Catalog {
  const entries = new Map<string, CatalogEntry>();
  const missing = new Map<string, string>();
  for (const name of names) {
    try {
      entries.set(name, find(pkgOf(name)));
    } catch (err) {
      missing.set(name, err instanceof Error ? err.message : String(err));
    }
  }
  return { entries, missing };
}

/** The plugin's code, imported when the kernel first activates it. */
function lazyDef(e: CatalogEntry): PluginDef {
  return {
    id: e.manifest.id,
    async setup(ctx) {
      const host = await e.load();
      if (host.default.id !== e.manifest.id) throw new Error(`${e.pkg}'s host module says it is ${host.default.id}, its manifest ${e.manifest.id}`);
      await host.default.setup(ctx);
    },
  };
}

function group(id: string, names: readonly string[], catalog: Catalog): PluginGroup {
  const out: GroupEntry[] = [];
  for (const n of names) {
    const e = catalog.entries.get(n);
    if (e) out.push({ manifest: e.manifest, def: lazyDef(e), root: e.root, builtin: true });
  }
  return pluginGroup(id, out);
}

export const DefaultPlugins = (c: Catalog): PluginGroup => group('DefaultPlugins', DEFAULT, c);
export const BoxPlugins = (c: Catalog): PluginGroup => group('BoxPlugins', DEFAULT.filter((n) => !(BOX_OFF as readonly string[]).includes(n)), c);
export const HeadlessPlugins = (c: Catalog): PluginGroup => group('HeadlessPlugins', HEADLESS, c);
export const MinimalPlugins = (c: Catalog): PluginGroup => group('MinimalPlugins', MINIMAL, c);

export const GROUPS = { DefaultPlugins, BoxPlugins, HeadlessPlugins, MinimalPlugins } as const;
export type GroupName = keyof typeof GROUPS;
