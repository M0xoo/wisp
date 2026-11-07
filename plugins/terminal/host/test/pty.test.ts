// Terminals on a real PTY (v1 test/pty.test.js): the program sees its size, takes input and a new
// size, a late page gets the screen, a big paste goes in whole, and the environment is clean.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Terms } from '../src/terms.ts';
import { hasPython, realPty, waitFor } from './fixtures/real-pty.ts';
import { sink } from './fixtures/fake-pty.ts';

const skip = !hasPython() && 'needs python3 with pty (the PTY fallback)';
const tmp = (p: string): string => mkdtempSync(join(tmpdir(), `wisp-${p}-`));
const realLater = (ms: number, fn: () => void): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};
const make = (kind: 'takeover' | 'shell', env: Record<string, string | undefined> = process.env) => {
  const proc = realPty();
  return { proc, terms: new Terms({ kind, proc, env, later: realLater }) };
};

test('Terms: runs on a terminal, takes input and a new size, replays its output to a late page', { skip }, async (ctx) => {
  const { proc, terms } = make('takeover');
  ctx.after(() => (terms.closeAll(), proc.killAll()));
  terms.open('s1', { argv: ['sh', '-c', 'stty size; read l; stty size; echo "got $l"'], cwd: tmp('pty'), cols: 90, rows: 33 });
  await waitFor(() => terms.screen('s1')?.includes('33 90'));
  assert.equal(terms.info('s1')?.state, 'running');
  assert.ok(terms.resize('s1', 120, 40));
  await new Promise((r) => setTimeout(r, 100));
  terms.input('s1', 'hello\r');
  await waitFor(() => terms.info('s1')?.code !== null);
  assert.equal(terms.info('s1')?.code, 0);
  assert.match(terms.screen('s1') ?? '', /40 120\r\ngot hello/);
  assert.equal(terms.active(), 0, 'an ended terminal keeps nothing awake');
  const page = sink();
  terms.attach('s1', page);
  assert.match(page.text, /^event: hello\n/);
  assert.match(page.text, /event: data\ndata: ".*got hello/);
  assert.match(page.text, /event: exit\ndata: \{"code":0\}/);
  assert.equal(terms.input('s1', 'x'), false);
  assert.ok(terms.close('s1'));
  assert.equal(terms.info('s1'), null);
});

test('Terms: a big paste goes in whole while the program prints (no hang)', { skip }, async (ctx) => {
  const { proc, terms } = make('shell');
  ctx.after(() => (terms.closeAll(), proc.killAll()));
  terms.open('paste', { argv: ['cat'], cwd: tmp('pty-paste') });
  let text = '';
  for (let i = 0; i < 4000; i++) text += `pasted line ${i} ${'x'.repeat(40)}\r`;
  terms.input('paste', text);
  await waitFor(() => terms.screen('paste')?.includes('pasted line 3999'), 15000);
});

test('Terms: a Claude Code session that started wisp does not leak into its terminals', { skip }, async (ctx) => {
  const { proc, terms } = make('takeover', { ...process.env, CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_USE_BEDROCK: '1' });
  ctx.after(() => (terms.closeAll(), proc.killAll()));
  terms.open('env', { argv: ['sh', '-c', 'echo "[$CLAUDECODE][$CLAUDE_CODE_CHILD_SESSION][$CLAUDE_CODE_SESSION_ID][$CLAUDE_CODE_USE_BEDROCK]"'], cwd: tmp('pty-env') });
  await waitFor(() => terms.info('env')?.code !== null);
  assert.match(terms.screen('env') ?? '', /\[\]\[\]\[\]\[1\]/, 'its markers go; the user’s own settings stay');
});

test('Terms: a take over drops settings that cost extra calls; a shell beside the task keeps them', { skip }, async (ctx) => {
  const env = { ...process.env, CLAUDE_CODE_AGENT_PROGRESS_SUMMARIES: '1' };
  const a = make('takeover', env);
  const b = make('shell', env);
  ctx.after(() => (a.terms.closeAll(), b.terms.closeAll(), a.proc.killAll(), b.proc.killAll()));
  const argv = ['sh', '-c', 'echo "[$CLAUDE_CODE_AGENT_PROGRESS_SUMMARIES]"'];
  a.terms.open('a', { argv, cwd: tmp('pty-costly-a') });
  b.terms.open('b', { argv, cwd: tmp('pty-costly-b') });
  await waitFor(() => a.terms.info('a')?.code !== null && b.terms.info('b')?.code !== null);
  assert.match(a.terms.screen('a') ?? '', /\[\]/, 'take over: gone');
  assert.match(b.terms.screen('b') ?? '', /\[1\]/, 'shell: the user’s own');
});

test('Terms: closing a running shell hangs it up; it ends on its own, off the registry', { skip }, async (ctx) => {
  const { proc, terms } = make('shell');
  ctx.after(() => (terms.closeAll(), proc.killAll()));
  terms.open('sh', { argv: ['sh', '-i'], cwd: tmp('pty-close') });
  await waitFor(() => terms.info('sh')?.state === 'running');
  assert.ok(terms.close('sh'));
  assert.equal(terms.info('sh'), null);
  terms.open('sh', { argv: ['sh', '-c', 'echo again'], cwd: tmp('pty-close2') });
  await waitFor(() => terms.screen('sh')?.includes('again'));
});
