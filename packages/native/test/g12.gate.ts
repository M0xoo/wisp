// Gate G12 (plan §9.1), the process-tree half: spawn a tree, kill it, count what is left.
// Not part of `npm test` (it takes a minute); `npm run test:native` runs it against a fresh
// release build. WISP_G12_RUNS (default 200), WISP_G12_BACKEND=fallback to measure the fallback.
//
// Each run starts sh with a child, a grandchild and (with python3) a process that left the
// group with setsid; half the runs are on a PTY. A process still running after the kill, or
// a kill that reports survivors, is an orphan.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startNative } from '../src/index.ts';
import type { NativeHost } from '../src/types.ts';
import { pidsIn, survivors, treeScript, waitFor, win } from './util.ts';

const RUNS = Number(process.env['WISP_G12_RUNS'] ?? 200);
const PARALLEL = 8;
const backend = process.env['WISP_G12_BACKEND'] === 'fallback' ? 'fallback' : 'native';

async function once(host: NativeHost, i: number): Promise<{ procs: number; orphans: number[] }> {
  let out = '';
  let kill: () => Promise<{ survivors: number }>;
  let root: number;
  if (i % 2) {
    const pty = await host.spawnPty({ cmd: 'sh', args: ['-c', treeScript()] });
    pty.onData((d) => (out += d.toString()));
    root = pty.pid;
    kill = () => pty.kill({ graceMs: 1000 });
  } else {
    const p = await host.spawnTree({ cmd: 'sh', args: ['-c', treeScript()] });
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    root = p.pid;
    kill = () => p.kill({ graceMs: 1000 });
  }
  await waitFor(() => out.includes('ready'), 10_000, `run ${i}`);
  const pids = [root, ...pidsIn(out.slice(0, out.indexOf('ready')))];
  const report = await kill();
  const left = await survivors(pids, 1000);
  return { procs: pids.length, orphans: report.survivors > 0 && left.length === 0 ? [-1] : left };
}

test(`G12: ${RUNS} spawn + kill-tree runs leave 0 orphans (${backend})`, { skip: win && 'uses sh' }, async () => {
  const host = await startNative({ prefer: backend });
  const started = Date.now();
  let procs = 0;
  const orphans: number[] = [];
  try {
    for (let i = 0; i < RUNS; i += PARALLEL) {
      const batch = await Promise.all(Array.from({ length: Math.min(PARALLEL, RUNS - i) }, (_, k) => once(host, i + k)));
      for (const r of batch) {
        procs += r.procs;
        orphans.push(...r.orphans);
      }
    }
  } finally {
    await host.close();
  }
  console.log(`G12 ${backend}${host.info.binary ? ` (${host.info.binary})` : ''}: ${RUNS} runs, ${procs} processes, ${orphans.length} orphans, ${Date.now() - started} ms`);
  assert.deepEqual(orphans, []);
});
