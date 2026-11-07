// Where the wisp-native binary is (plan §7.1, the esbuild model): WISP_NATIVE_BIN, then the
// optional dependency for this platform, then a dev build in native/target/release.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BinarySource } from './types.ts';

/** Every platform a binary is published for; `@wisp/native-<platform>-<arch>` (Node's names). */
export const NATIVE_TARGETS = [
  { platform: 'darwin', arch: 'arm64', rust: 'aarch64-apple-darwin' },
  { platform: 'darwin', arch: 'x64', rust: 'x86_64-apple-darwin' },
  { platform: 'linux', arch: 'x64', rust: 'x86_64-unknown-linux-musl' },
  { platform: 'linux', arch: 'arm64', rust: 'aarch64-unknown-linux-musl' },
  { platform: 'win32', arch: 'x64', rust: 'x86_64-pc-windows-msvc' },
  { platform: 'win32', arch: 'arm64', rust: 'aarch64-pc-windows-msvc' },
] as const;

export const nativePackageName = (platform: string, arch: string): string => `@wisp/native-${platform}-${arch}`;
export const binaryName = (platform: string): string => (platform === 'win32' ? 'wisp-native.exe' : 'wisp-native');

export interface LocateDeps {
  env: Readonly<Record<string, string | undefined>>;
  platform: string;
  arch: string;
  exists: (file: string) => boolean;
  /** the folder of an installed package, or null */
  packageDir: (name: string) => string | null;
  /** the repo's native/ folder, for a dev build */
  devRoot: string;
}

export type Located = { binary: string; source: BinarySource } | { binary: null; reason: string };

export function locateBinary(deps: LocateDeps): Located {
  const tried: string[] = [];
  const fromEnv = deps.env['WISP_NATIVE_BIN'];
  if (fromEnv) {
    if (deps.exists(fromEnv)) return { binary: fromEnv, source: 'env' };
    tried.push(`WISP_NATIVE_BIN=${fromEnv} (missing)`);
  }
  const pkg = nativePackageName(deps.platform, deps.arch);
  const dir = deps.packageDir(pkg);
  const bin = binaryName(deps.platform);
  if (dir) {
    const file = path.join(dir, 'bin', bin);
    if (deps.exists(file)) return { binary: file, source: 'package' };
    tried.push(`${pkg} (no bin/${bin})`);
  } else {
    tried.push(`${pkg} (not installed)`);
  }
  const dev = path.join(deps.devRoot, 'target', 'release', bin);
  if (deps.exists(dev)) return { binary: dev, source: 'dev' };
  tried.push(`${dev} (not built)`);
  return { binary: null, reason: `no wisp-native binary: ${tried.join('; ')}` };
}

const here = path.dirname(fileURLToPath(import.meta.url));

export function defaultLocateDeps(env: Readonly<Record<string, string | undefined>>): LocateDeps {
  const require = createRequire(import.meta.url);
  return {
    env,
    platform: process.platform,
    arch: process.arch,
    exists: (file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    },
    packageDir: (name) => {
      try {
        return path.dirname(require.resolve(`${name}/package.json`));
      } catch {
        return null;
      }
    },
    devRoot: path.resolve(here, '../../../native'),
  };
}
