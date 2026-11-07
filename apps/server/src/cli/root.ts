// Where this package's own files are: apps/server in a checkout, the dist folder once tools/bundle.ts has
// bundled it. Found by walking up to the package.json named wisp-agents, so it holds wherever the
// bundler puts the code that asks (an entry, a chunk, a nested module).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = 'wisp-agents';

interface PackageJson {
  name?: unknown;
  bin?: unknown;
}

export interface PackageRoot {
  dir: string;
  /** the `wisp` bin as package.json names it: bin/wisp.ts in a checkout, bin/wisp.js published */
  bin: string;
}

function readPackage(dir: string): PackageJson | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as PackageJson) : null;
  } catch {
    return null;
  }
}

function binOf(pkg: PackageJson): string {
  const bin = pkg.bin;
  return typeof bin === 'string' ? bin : bin && typeof bin === 'object' && 'wisp' in bin && typeof bin.wisp === 'string' ? bin.wisp : 'bin/wisp.js';
}

/** Sync on purpose: the CLI and the SDK ask once, at startup, before anything else runs. */
export function packageRoot(from: string = import.meta.url): PackageRoot {
  let dir = path.dirname(fileURLToPath(from));
  for (;;) {
    const pkg = readPackage(dir);
    if (pkg?.name === PACKAGE_NAME) return { dir, bin: path.join(dir, binOf(pkg)) };
    const up = path.dirname(dir);
    if (up === dir) throw new Error(`${PACKAGE_NAME}: no package.json named ${PACKAGE_NAME} above ${fileURLToPath(from)}`);
    dir = up;
  }
}

/**
 * A file the package carries (`skills/wisp/SKILL.md`). The bundle has it at its root; a checkout may
 * still keep it at the repository's root, two levels up from apps/server.
 */
export function packageFile(rel: string, root: string = packageRoot().dir): string {
  const here = path.join(root, rel);
  if (existsSync(here)) return here;
  const repo = path.join(root, '..', '..', rel);
  return existsSync(repo) ? repo : here;
}
