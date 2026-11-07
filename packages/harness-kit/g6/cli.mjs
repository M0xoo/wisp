#!/usr/bin/env node
// The CLI every harness runs in a G6 test, in one of two modes.
//
// Record (WISP_TEE_TARGET set): run that node script (a fake CLI named like the harness) with this
// process's argv and stdin, pass its output through untouched, and save its stdout, stderr, exit
// and argv to WISP_TEE_OUT.{jsonl,meta.json}.
//
// Replay (otherwise): print WISP_REPLAY_FILE's bytes as they were, with @CWD@ as this process's
// folder, then WISP_REPLAY_STDERR on stderr, then exit with WISP_REPLAY_EXIT. WISP_REPLAY_HANG=1
// waits to be killed instead.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const env = process.env;
if (env.WISP_TEE_TARGET) record();
else replay();

function record() {
  const base = env.WISP_TEE_OUT;
  const child = spawn(process.execPath, [env.WISP_TEE_TARGET, ...process.argv.slice(2)], { stdio: ['pipe', 'pipe', 'pipe'] });
  const out = [];
  const err = [];
  process.stdin.pipe(child.stdin);
  child.stdin.on('error', () => {});
  child.stdout.on('data', (d) => (out.push(d), process.stdout.write(d)));
  child.stderr.on('data', (d) => (err.push(d), process.stderr.write(d)));
  const save = (code, signal) => {
    fs.writeFileSync(`${base}.jsonl`, Buffer.concat(out));
    fs.writeFileSync(`${base}.raw-meta.json`, `${JSON.stringify({ argv: process.argv.slice(2), exit: { code, signal, stderr: Buffer.concat(err).toString('utf8') } }, null, 2)}\n`);
  };
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => (child.kill(s), save(null, s), process.exit(143)));
  child.on('close', (code, signal) => {
    save(code, signal);
    process.exitCode = code ?? 1;
  });
}

function replay() {
  process.stdin.resume();
  process.stdin.on('data', () => {});
  const cwd = process.cwd();
  const out = fs.readFileSync(env.WISP_REPLAY_FILE, 'utf8').replaceAll('@CWD@', JSON.stringify(cwd).slice(1, -1));
  const err = env.WISP_REPLAY_STDERR || '';
  process.stdout.write(out, () => {
    if (err) process.stderr.write(err);
    if (env.WISP_REPLAY_HANG === '1') return void setInterval(() => {}, 1 << 30);
    process.exitCode = Number(env.WISP_REPLAY_EXIT || 0);
    process.stdin.destroy();
  });
}
