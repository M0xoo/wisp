// Helpers for the tests: is a process still running, and waiting on a condition.

import { execFileSync } from 'node:child_process';

export const win = process.platform === 'win32';

/** Running and not a zombie, per ps(1). */
export function running(pid: number): boolean {
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return stat !== '' && !stat.startsWith('Z');
  } catch {
    return false; // ps exits 1 when the pid isn't there
  }
}

/** The pids of `pids` still running after up to `ms`. */
export async function survivors(pids: readonly number[], ms = 3000): Promise<number[]> {
  const end = Date.now() + ms;
  for (;;) {
    const left = pids.filter(running);
    if (left.length === 0 || Date.now() > end) return left;
    await new Promise((r) => setTimeout(r, 25));
  }
}

export async function waitFor<T>(fn: () => T | undefined | false | null, ms = 8000, what = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export const pidsIn = (text: string): number[] => text.split(/\s+/).filter((w) => /^\d+$/.test(w)).map(Number);

let python: boolean | undefined;
/** A setsid'd grandchild needs python3; the tree tests use one when there is one. */
export function hasPython(): boolean {
  if (python === undefined) {
    try {
      execFileSync('python3', ['-c', '1'], { stdio: 'ignore' });
      python = true;
    } catch {
      python = false;
    }
  }
  return python;
}

/** A shell tree two levels deep, plus (with python3) a grandchild that left the process group. */
export function treeScript(): string {
  const escape = `python3 -c 'import os, time; os.setsid(); print(os.getpid(), flush=True); time.sleep(60)' & `;
  return `${hasPython() ? escape : ''}sleep 60 & echo $!; sh -c 'sleep 60 & echo $!; wait' & echo $!; sleep 0.3; echo ready; wait`;
}
