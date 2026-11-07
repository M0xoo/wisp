// The behaviour every NativeHost promises, run against each backend (fallback.test.ts,
// native.test.ts). Edge cases are the ones v1 learned the hard way (test/pty.test.js).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { NativeError, type NativeHost, type Pty } from '../src/index.ts';
import { pidsIn, survivors, treeScript, waitFor, win } from './util.ts';

export interface Backend {
  name: string;
  start: () => Promise<NativeHost>;
  /** false, or why this backend's cases are skipped */
  skip: string | false;
  /** script(1) can't resize */
  resizable: boolean;
}

const tmp = (name: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `wisp-native-${name}-`));

function collect(pty: Pty): { text: () => string } {
  const chunks: Buffer[] = [];
  pty.onData((c) => chunks.push(c));
  return { text: () => Buffer.concat(chunks).toString('utf8') };
}

const isCode = (code: string) => (e: unknown) => e instanceof NativeError && e.code === code;

export function contract(b: Backend): void {
  const skip = b.skip || (win && 'these cases use sh');
  const it = (name: string, fn: (host: NativeHost) => Promise<void>, extra: string | false = false): void => {
    test(`${b.name}: ${name}`, { skip: skip || extra }, async (ctx) => {
      const host = await b.start();
      ctx.after(() => host.close()); // a failed wait leaves programs running; close ends them
      await fn(host);
    });
  };

  it('a terminal has its size from the first line, takes input and a new size, and ends with its code', async (host) => {
    const pty = await host.spawnPty({ cmd: 'sh', args: ['-c', 'stty size; read l; stty size; echo "got $l"; exit 7'], cwd: tmp('pty'), cols: 90, rows: 33 });
    assert.ok(pty.pid > 1);
    const out = collect(pty);
    await waitFor(() => out.text().includes('33 90'), 8000, 'the first size');
    assert.equal(pty.resize(120, 40), b.resizable);
    await new Promise((r) => setTimeout(r, 100));
    pty.write('hello\r');
    assert.deepEqual(await pty.exited, { code: 7, signal: null });
    assert.match(out.text(), b.resizable ? /40 120\r\ngot hello/ : /33 90\r\ngot hello/, 'all output comes before the exit');
    let late: unknown;
    pty.onExit((e) => (late = e));
    assert.deepEqual(late, { code: 7, signal: null }, 'a late onExit is called at once');
    assert.equal(pty.resize(80, 24), false, 'an ended terminal takes no size');
  });

  it('output that came before anyone listened is replayed to the first listener', async (host) => {
    const pty = await host.spawnPty({ cmd: 'sh', args: ['-c', 'echo early; sleep 0.3'] });
    await new Promise((r) => setTimeout(r, 200));
    const out = collect(pty);
    await pty.exited;
    assert.match(out.text(), /early/);
  });

  it('a big paste goes in whole while the program prints (no hang, nothing dropped)', async (host) => {
    const pty = await host.spawnPty({ cmd: 'cat' });
    const out = collect(pty);
    let text = '';
    for (let i = 0; i < 4000; i++) text += `pasted line ${i} ${'x'.repeat(40)}\r`;
    pty.write(text);
    await waitFor(() => out.text().includes('pasted line 3999'), 20_000, 'the last line');
    // Each line comes back twice (echo and cat) and the copies may interleave: one whole copy counts.
    const whole = new Set([...out.text().matchAll(/pasted line (\d+) x{40}/g)].map((m) => m[1]));
    assert.equal(whole.size, 4000);
    pty.signal('SIGHUP');
    assert.equal((await pty.exited).signal, 'SIGHUP');
  });

  it('a terminal gets the environment it is given', async (host) => {
    const pty = await host.spawnPty({ cmd: '/usr/bin/env', env: { ONLY: 'this', TERM: 'xterm-256color' } });
    const out = collect(pty);
    await pty.exited;
    assert.match(out.text(), /ONLY=this/);
    assert.doesNotMatch(out.text(), /\bHOME=/, 'nothing of the server leaks in');
  });

  it('a tree keeps stdout and stderr apart, and closing stdin ends what reads it', async (host) => {
    const p = await host.spawnTree({ cmd: 'sh', args: ['-c', 'cat; echo bye >&2'], env: { PATH: '/usr/bin:/bin' } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.stdin.write('one\ntwo\n');
    p.stdin.end();
    assert.deepEqual(await p.exited, { code: 0, signal: null });
    assert.equal(out, 'one\ntwo\n');
    assert.equal(err, 'bye\n');
  });

  it('killing a tree leaves no process behind, even one that left its group', async (host) => {
    const p = await host.spawnTree({ cmd: 'sh', args: ['-c', treeScript()] });
    let out = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    await waitFor(() => out.includes('ready'), 8000, 'the tree');
    const pids = [p.pid, ...pidsIn(out)];
    assert.ok(pids.length >= 4, String(pids));
    const report = await p.kill();
    assert.equal(report.survivors, 0);
    assert.ok(report.signalled >= 4, JSON.stringify(report));
    assert.deepEqual(await p.exited, { code: null, signal: 'SIGTERM' });
    assert.deepEqual(await survivors(pids), []);
  });

  it('a terminal and everything in it is killed as one tree', async (host) => {
    const pty = await host.spawnPty({ cmd: 'sh', args: ['-c', treeScript()] });
    const out = collect(pty);
    await waitFor(() => out.text().includes('ready'), 8000, 'the tree');
    const pids = [pty.pid, ...pidsIn(out.text())];
    assert.equal((await host.killTree(pty.pid, { graceMs: 500 })).survivors, 0);
    await pty.exited;
    assert.deepEqual(await survivors(pids), []);
  });

  it('what an exited program left behind can still be killed', async (host) => {
    const p = await host.spawnTree({ cmd: 'sh', args: ['-c', 'sleep 60 >/dev/null 2>&1 & echo $!'] });
    let out = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    await p.exited;
    const left = pidsIn(out);
    assert.equal(left.length, 1);
    assert.equal((await host.killTree(p.pid, { graceMs: 100 })).survivors, 0);
    assert.deepEqual(await survivors(left), []);
  });

  it('a program or folder that is not there fails the spawn, the same way everywhere', async (host) => {
    await assert.rejects(host.spawnTree({ cmd: 'definitely-not-a-cli-wisp' }), isCode('spawn_failed'));
    await assert.rejects(host.spawnPty({ cmd: 'definitely-not-a-cli-wisp' }), isCode('spawn_failed'));
    await assert.rejects(host.spawnTree({ cmd: 'sh', cwd: '/definitely/not/here' }), isCode('spawn_failed'));
    await assert.rejects(host.spawnPty({ cmd: 'sh', cwd: '/definitely/not/here' }), isCode('spawn_failed'));
    await assert.rejects(host.killTree(1), isCode('unknown_id'));
  });

  it('list shows what runs and what has exited', async (host) => {
    const a = await host.spawnTree({ cmd: 'sleep', args: ['30'] });
    const b2 = await host.spawnTree({ cmd: 'true' });
    await b2.exited;
    const items = await host.list();
    assert.deepEqual(items.map((i) => [i.pid, i.pty, i.exited]), [[a.pid, false, false], [b2.pid, false, true]]);
  });

  test(`${b.name}: close ends every tree it started`, { skip }, async () => {
    const host = await b.start();
    const p = await host.spawnTree({ cmd: 'sh', args: ['-c', treeScript()] });
    const pty = await host.spawnPty({ cmd: 'sh', args: ['-c', treeScript()] });
    let out = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    const term = collect(pty);
    await waitFor(() => out.includes('ready') && term.text().includes('ready'), 8000, 'both trees');
    const pids = [p.pid, pty.pid, ...pidsIn(out), ...pidsIn(term.text())];
    await host.close();
    assert.deepEqual(await survivors(pids), []);
    await assert.rejects(host.spawnTree({ cmd: 'true' }), (e: unknown) => e instanceof NativeError);
  });
}
