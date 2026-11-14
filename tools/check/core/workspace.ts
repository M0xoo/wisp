// Finds the workspace packages from the root package.json, the same list npm and monoflow use, so the
// checker never needs its own config when a package is added.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Pkg, PkgKind } from './types.ts';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'target', '.turbo', '.vite']);
/** Outside every package but still checked (sizes, no-any): the tooling itself. */
export const EXTRA_DIRS = ['tools'];
/** Never scanned: fixture trees are bad code on purpose. */
const IGNORED_PREFIXES = ['tools/check/test/fixtures/'];

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function expand(root: string, pattern: string): string[] {
  let dirs = [''];
  for (const seg of pattern.split('/').filter(Boolean)) {
    const next: string[] = [];
    for (const d of dirs) {
      if (seg === '*') {
        const abs = join(root, d);
        if (!existsSync(abs)) continue;
        for (const e of readdirSync(abs, { withFileTypes: true })) {
          if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) next.push(d ? `${d}/${e.name}` : e.name);
        }
      } else {
        next.push(d ? `${d}/${seg}` : seg);
      }
    }
    dirs = next;
  }
  return dirs.filter((d) => existsSync(join(root, d, 'package.json')));
}

export function classify(dir: string): { kind: PkgKind; plugin: string | undefined } {
  const parts = dir.split('/');
  if (parts[0] === 'plugins' && parts.length === 3) {
    const half = parts[2];
    const kind: PkgKind = half === 'api' ? 'plugin-api' : half === 'ui' ? 'plugin-ui' : 'plugin-host';
    return { kind, plugin: parts[1] };
  }
  if (parts[0] === 'apps') return { kind: 'app', plugin: undefined };
  return { kind: 'package', plugin: undefined };
}

function exportKeys(manifest: Record<string, unknown>): string[] {
  const ex = manifest['exports'];
  if (typeof ex === 'string') return ['.'];
  if (!isRecord(ex)) return ['.'];
  const keys = Object.keys(ex);
  // conditions only ({ import, types }) mean a single entry
  return keys.every((k) => k.startsWith('.')) ? keys : ['.'];
}

export function discover(root: string): Pkg[] {
  const rootJson = readJson(join(root, 'package.json'));
  const patterns = isRecord(rootJson) && Array.isArray(rootJson['workspaces']) ? rootJson['workspaces'].filter((p): p is string => typeof p === 'string') : [];
  const dirs = [...new Set(patterns.flatMap((p) => expand(root, p)))].sort();
  const pkgs = dirs.map((dir): Pkg => {
    const raw = readJson(join(root, dir, 'package.json'));
    const manifest = isRecord(raw) ? raw : {};
    const { kind, plugin } = classify(dir);
    const name = typeof manifest['name'] === 'string' ? manifest['name'] : dir;
    const deps = ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((k) => {
      const v = manifest[k];
      return isRecord(v) ? Object.keys(v) : [];
    });
    const ui = kind === 'plugin-ui' || dir === 'packages/ui' || dir === 'apps/web';
    return { name, dir, kind, plugin, ui, declared: new Set(deps), exports: exportKeys(manifest), manifest };
  });
  const names = new Set(pkgs.map((p) => p.name));
  for (const p of pkgs) p.declared = new Set([...p.declared].filter((d) => names.has(d)));
  return pkgs;
}

function walk(root: string, dir: string, out: string[]): void {
  const abs = join(root, dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return;
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const rel = `${dir}/${e.name}`;
    if (IGNORED_PREFIXES.some((p) => `${rel}/`.startsWith(p))) continue;
    if (e.isDirectory()) walk(root, rel, out);
    else if (e.isFile()) out.push(rel);
  }
}

/** Every file of every package (nested packages are listed once, under the deepest owner). */
export function listFiles(root: string, pkgs: readonly Pkg[]): string[] {
  const out: string[] = [];
  const dirs = [...pkgs.map((p) => p.dir), ...EXTRA_DIRS];
  // a package nested in another one's folder would be walked twice
  const tops = dirs.filter((d) => !dirs.some((o) => o !== d && d.startsWith(`${o}/`)));
  for (const d of tops) walk(root, d, out);
  return [...new Set(out)].sort();
}
