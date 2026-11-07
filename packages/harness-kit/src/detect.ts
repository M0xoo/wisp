// Finding a CLI and asking it about itself (v1 adapters/common.js), through the proc service: never
// blocking, never a shell.

import { access } from 'node:fs/promises';
import type { ProcService } from '@wisp/kernel';

export interface Detected {
  available: boolean;
  version?: string;
  error?: string;
}

const failure = (r: { code: number | null; stderr: string; timedOut: boolean }, bin: string): string =>
  r.timedOut ? `${bin} timed out` : r.stderr.trim().split('\n')[0] || `${bin} exited with code ${r.code}`;

/** `bin --version`'s first line, or why it didn't run. */
export async function detectVersion(proc: ProcService, bin: string, args: readonly string[] = ['--version']): Promise<Detected> {
  try {
    const r = await proc.exec(bin, args, { timeoutMs: 10_000 });
    if (r.code !== 0 || r.timedOut) return { available: false, error: failure(r, bin) };
    return { available: true, version: r.stdout.trim().split('\n')[0] ?? '' };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);

/**
 * Detect `bin`, or when it doesn't run, the first copy in `fallbacks` that does: CLIs that live off
 * PATH (an install wisp made, a desktop app's bundled CLI). Answers with the `bin` that answered. An
 * explicit WISP_*_BIN override (`pinned`) is never second-guessed.
 */
export async function detectFirst(proc: ProcService, bin: string, fallbacks: () => readonly string[] | Promise<readonly string[]>, pinned = false): Promise<Detected & { bin: string }> {
  const found = await detectVersion(proc, bin);
  if (found.available || pinned) return { ...found, bin };
  for (const b of await fallbacks()) {
    if (!(await exists(b))) continue;
    const there = await detectVersion(proc, b);
    if (there.available) return { ...there, bin: b };
  }
  return { ...found, bin };
}

/** A CLI's version line ("codex-cli 0.163.0", "2.1.316 (Claude Code)") as the bare version, or ''. */
export const versionIn = (line: unknown): string => /\d+(?:\.\d+)+[^\s,)]*/.exec(String(line ?? ''))?.[0] ?? '';

/** [major, minor, patch] from a version line, or [] when it has none. */
export const versionTriple = (v: unknown): number[] => (/(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '')) ?? []).slice(1).map(Number);

/**
 * `bin args`'s stdout, or '' on any failure (model discovery). env: the whole environment it runs
 * with, when it isn't wisp's own (an account's CODEX_HOME).
 */
export async function quietOutput(proc: ProcService, bin: string, args: readonly string[], timeoutMs = 15_000, env?: Record<string, string | undefined>): Promise<string> {
  try {
    const r = await proc.exec(bin, args, { timeoutMs, maxBuffer: 4 * 1024 * 1024, ...(env && { env }) });
    return r.code === 0 && !r.timedOut ? r.stdout : '';
  } catch {
    return '';
  }
}

/** `bin --help`, from whichever stream it prints to (agy uses stderr), or ''. */
export async function helpText(proc: ProcService, bin: string): Promise<string> {
  try {
    const r = await proc.exec(bin, ['--help'], { timeoutMs: 15_000, maxBuffer: 4 * 1024 * 1024 });
    return r.code === 0 && !r.timedOut ? `${r.stdout}\n${r.stderr}` : '';
  } catch {
    return '';
  }
}

/**
 * The thinking levels a CLI's --help gives for its effort flag: "(low, medium, high)",
 * "(low|medium|high)" or "[possible values: low, medium, high]". [] when it lists none.
 */
export function helpEfforts(text: string): string[] {
  const at = text.search(/--(?:reasoning-)?effort\b/);
  if (at < 0) return [];
  // Just this flag's entry: up to the next option.
  const entry = text.slice(at).split(/\n\s*-{1,2}\w/)[0] ?? '';
  const m = /(?:\(\s*|possible values:\s*)([a-z]+(?:\s*[,|]\s*[a-z]+)+)/.exec(entry);
  return m?.[1] ? m[1].split(/\s*[,|]\s*/) : [];
}
