// Project-relative paths and the size cap on file contents wisp keeps (v1 server/paths.js). Pure:
// the driver resolves the cwd's real path once, before the run, and parsers get both spellings.

import path from 'node:path';

/** Larger files are tracked as changed, but their contents aren't kept. */
export const MAX_SNAPSHOT = 256 * 1024;

/** The run's folder as given and as the OS resolves it (/tmp vs /private/tmp on macOS). */
export interface RunPaths {
  cwd: string;
  real: string;
}

/**
 * Path relative to cwd, or the path as given if it lies outside. Harnesses may report paths through
 * the resolved cwd, so both spellings count.
 */
export function rel(file: unknown, paths: RunPaths | string): string {
  if (!file) return '';
  const f = String(file);
  const { cwd, real } = typeof paths === 'string' ? { cwd: paths, real: paths } : paths;
  const abs = path.resolve(cwd, f);
  for (const base of cwd === real ? [cwd] : [cwd, real]) {
    const r = path.relative(base, abs);
    if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r;
  }
  return f;
}
