// Where a built-in plugin's manifest and code come from, by package name. The manifest is read at boot
// (it is the whole static truth: contributions are live before any code runs); the code is imported
// only when the kernel activates the plugin (plan §6.4: lazy by default, cold start ≤ 150 ms).
// Run from source, a package is found through node's resolution; tools/bundle.ts swaps this file for
// one with literal imports and the manifests inlined (catalog.gen.ts), so the bundle needs no lookup.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Manifest, PluginDef } from '@wisp/kernel';

export interface HostModule {
  default: PluginDef;
  openapi?: unknown;
}

export interface CatalogEntry {
  pkg: string;
  manifest: Manifest;
  root: string;
  load(): Promise<HostModule>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function asHost(pkg: string, m: unknown): HostModule {
  const def = isObj(m) ? m['default'] : undefined;
  if (!isObj(def) || typeof def['id'] !== 'string' || typeof def['setup'] !== 'function') throw new Error(`${pkg} has no plugin definition as its default export`);
  return { default: def as unknown as PluginDef, openapi: isObj(m) ? m['openapi'] : undefined };
}

/** The host package's folder: its package.json sits beside wisp-plugin.json. */
function rootOf(pkg: string): string {
  // a startup read (allowed: boot only), never on a request path
  const entry = fileURLToPath(import.meta.resolve(pkg));
  let dir = path.dirname(entry);
  for (let i = 0; i < 4; i++) {
    try {
      readFileSync(path.join(dir, 'wisp-plugin.json'));
      return dir;
    } catch {
      dir = path.dirname(dir);
    }
  }
  throw new Error(`${pkg}: no wisp-plugin.json beside its package`);
}

/** A built-in plugin by package name; throws with the reason when it can't be found. */
export function entry(pkg: string): CatalogEntry {
  const root = rootOf(pkg);
  const manifest = JSON.parse(readFileSync(path.join(root, 'wisp-plugin.json'), 'utf8')) as Manifest;
  return { pkg, manifest, root, load: async () => asHost(pkg, await import(pkg)) };
}
