// Project-relative paths and the size cap for the file contents wisp keeps (diffs, checkpoints).
// Shared by the adapters (what a harness changed) and checkpoint.js (reverting it).

import fs from 'node:fs';
import path from 'node:path';

// Larger files are tracked as changed, but their contents aren't kept.
export const MAX_SNAPSHOT = 256 * 1024;

const realDirs = new Map();
function realDir(dir) {
  if (!realDirs.has(dir)) {
    try {
      realDirs.set(dir, fs.realpathSync(dir));
    } catch {
      realDirs.set(dir, dir);
    }
  }
  return realDirs.get(dir);
}

// Path relative to cwd, or the path as given if it lies outside. Harnesses may report paths
// through the resolved cwd (/private/tmp vs /tmp on macOS), so both spellings count.
export function rel(file, cwd) {
  if (!file) return '';
  const abs = path.resolve(cwd, file);
  for (const base of [cwd, realDir(cwd)]) {
    const r = path.relative(base, abs);
    if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r;
  }
  return file;
}
