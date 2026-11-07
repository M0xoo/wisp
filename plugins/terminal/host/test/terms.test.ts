// The terminal registry (v1 server/pty.js Terms) on a driven child: output kept and replayed, the
// event stream as v1 wrote it, numbered input, the flow's states, the environment it starts with.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { termEnv } from '../src/env.ts';
import { Terms } from '../src/terms.ts';
import { manualTime } from './fixtures/clock.ts';
import { fakeProc, sink, tick } from './fixtures/fake-pty.ts';

const make = (kind: 'takeover' | 'shell' = 'takeover', env: Record<string, string> = {}) => {
  const clock = manualTime();
  const proc = fakeProc();
  const changes: string[] = [];
  const terms = new Terms({ kind, proc, env, later: clock.later, now: clock.now, onChange: (i) => changes.push(`${i.id}:${i.state}`) });
  return { clock, proc, terms, changes };
};

test('Terms: numbered input goes in in order, a gap is skipped, and output is kept to its limit', () => {
  const { clock, proc, terms } = make('shell');
  terms.open('s', { argv: ['x'], cwd: '/' });
  const child = proc.children[0];
  assert.ok(child);
  terms.input('s', 'b', { seq: 1, from: 'p1' });
  terms.input('s', 'Z', { seq: 0, from: 'p2' });
  assert.deepEqual(child.typed, ['Z'], 'b waits for 0');
  terms.input('s', 'a', { seq: 0, from: 'p1' });
  terms.input('s', 'a', { seq: 0, from: 'p1' });
  assert.deepEqual(child.typed, ['Z', 'a', 'b'], 'in order, a resend once');
  terms.input('s', 'plain');
  assert.equal(child.typed.at(-1), 'plain', 'unnumbered (an older page) goes straight in');
  terms.input('s', 'd', { seq: 3, from: 'p1' });
  clock.advance(999);
  assert.equal(child.typed.at(-1), 'plain');
  clock.advance(2);
  assert.equal(child.typed.at(-1), 'd', 'seq 2 never came: d goes in after a second');
  // Output past the limit is cut at an escape sequence or a line, not in the middle of one.
  child.print('38;5;1mtext');
  child.print(`\x1b[31mzz\r\n${'x'.repeat((1 << 20) - 12)}`);
  assert.ok(terms.screen('s')?.startsWith('\x1b[31mzz\r\nxx'));
  for (let i = 0; i < 3000; i++) child.print(`${'y'.repeat(999)}\n`);
  const out = terms.screen('s') ?? '';
  assert.ok(out.length <= 1 << 20 && out.startsWith('y') && out.endsWith('y\n'));
  terms.closeAll();
});

test('Terms: nine pages typing: the oldest page’s numbering is forgotten, the rest keep theirs', () => {
  const { proc, terms } = make('shell');
  terms.open('s', { argv: ['x'], cwd: '/' });
  for (let p = 0; p < 9; p++) terms.input('s', `p${p}`, { seq: 0, from: `page${p}` });
  terms.input('s', 'again', { seq: 0, from: 'page0' }); // forgotten: its 0 counts as new
  terms.input('s', 'dup', { seq: 0, from: 'page8' }); // remembered: a resend
  assert.deepEqual(proc.children[0]?.typed.slice(-2), ['p8', 'again']);
});

test('Terms: one terminal per task; a late page gets hello, the screen so far, and the exit', async () => {
  const { proc, terms, changes } = make();
  const t = terms.open('s1', { argv: ['sh', '-c', 'x'], cwd: '/tmp', cols: 90, rows: 33 });
  assert.equal(t.state, 'starting');
  assert.deepEqual([proc.calls[0]?.pty.cols, proc.calls[0]?.pty.rows], [90, 33]);
  assert.equal(terms.open('s1', { argv: ['false'], cwd: '/' }).startedAt, t.startedAt, 'the one still running');
  assert.equal(proc.calls.length, 1);
  const live = sink();
  terms.attach('s1', live);
  const child = proc.children[0];
  assert.ok(child);
  child.print('hello ');
  child.printErr('oops\n');
  assert.equal(terms.info('s1')?.state, 'running', 'its first output makes it ready');
  assert.match(live.text, /^event: hello\ndata: \{"cols":90,"rows":33,"resizable":true,"ordered":true,"state":"starting"\}\n\nevent: data\ndata: ""\n\n/);
  assert.match(live.text, /event: data\ndata: "hello "\n\nevent: data\ndata: "oops\\r\\n"\n\n$/);
  child.exit(0);
  await tick();
  assert.match(live.text, /event: exit\ndata: \{"code":0\}\n\n$/);
  assert.equal(terms.info('s1')?.state, 'ended');
  assert.equal(terms.active(), 0, 'an ended terminal keeps nothing awake');
  const late = sink();
  terms.attach('s1', late);
  assert.match(late.text, /^event: hello\n/);
  assert.match(late.text, /event: data\ndata: "hello oops\\r\\n"/);
  assert.match(late.text, /event: exit\ndata: \{"code":0\}/);
  assert.ok(late.ended);
  assert.equal(terms.input('s1', 'x'), false);
  assert.ok(terms.close('s1'));
  assert.equal(terms.info('s1'), null);
  assert.equal(terms.close('s1'), false);
  const gone = sink();
  terms.attach('s1', gone);
  assert.equal(gone.text, 'event: gone\ndata: {}\n\n');
  assert.deepEqual(changes, ['s1:starting', 's1:running', 's1:ended', 's1:gone']);
});

test('Terms: an ended terminal is started fresh, never reopened with its dead screen', async () => {
  const { proc, terms } = make();
  terms.open('s', { argv: ['a'], cwd: '/' });
  proc.children[0]?.print('old screen');
  proc.children[0]?.exit(1);
  await tick();
  const t = terms.open('s', { argv: ['a'], cwd: '/' });
  assert.equal(t.state, 'starting');
  assert.equal(t.code, null);
  assert.equal(terms.screen('s'), '', 'nothing of the old one');
  assert.equal(proc.calls.length, 2);
});

test('Terms: a STOP while starting cancels the start; a restart doesn’t wait for the dying one', async () => {
  const { proc, terms, changes } = make('shell');
  terms.open('s', { argv: ['sh'], cwd: '/' });
  const page = sink();
  terms.attach('s', page);
  assert.ok(terms.close('s'));
  assert.deepEqual(proc.children[0]?.killed, ['SIGHUP']);
  assert.equal(terms.info('s'), null, 'gone from the registry at once (v1)');
  assert.match(page.text, /event: gone\ndata: \{\}\n\n$/);
  assert.ok(page.ended);
  // The cancelled start prints late and dies: none of it reaches the new terminal.
  const fresh = terms.open('s', { argv: ['sh'], cwd: '/' });
  proc.children[0]?.print('late prompt');
  proc.children[0]?.exit(null, 'SIGHUP');
  await tick();
  assert.equal(terms.info('s')?.state, 'starting');
  assert.equal(terms.screen('s'), '');
  assert.equal(fresh.state, 'starting');
  assert.deepEqual(changes, ['s:starting', 's:stopping', 's:gone', 's:starting']);
});

test('Terms: a slow start says so after 8 s, and comes good when it prints', () => {
  const { clock, proc, terms } = make();
  terms.open('s', { argv: ['claude'], cwd: '/' });
  clock.advance(7999);
  assert.equal(terms.info('s')?.state, 'starting');
  clock.advance(1);
  assert.equal(terms.info('s')?.state, 'slow');
  assert.ok(terms.live('s'), 'slow is still live: input goes in');
  proc.children[0]?.print('ready');
  assert.equal(terms.info('s')?.state, 'running');
  terms.closeAll();
});

test('Terms: a program that can’t start fails, with wisp’s line on its screen', async () => {
  const { proc, terms } = make();
  proc.fail = new Error('spawn sh ENOENT');
  const t = terms.open('s', { argv: ['sh'], cwd: '/' });
  assert.equal(t.state, 'failed');
  assert.equal(t.code, 127);
  assert.match(terms.screen('s') ?? '', /couldn’t start a terminal \(spawn sh ENOENT\)/);
  delete proc.fail;
  proc.spawn = (() => {
    const c = fakeProc().spawn('x', [], { cwd: '/', env: {}, pty: { cols: 1, rows: 1 }, tree: true });
    queueMicrotask(() => (c as unknown as { exit(n: number): void }).exit(127));
    return c;
  }) as typeof proc.spawn;
  terms.open('s', { argv: ['nope'], cwd: '/' });
  await tick();
  assert.equal(terms.info('s')?.state, 'failed', 'exit 127 before any output: it never ran');
  assert.equal(terms.open('s', { argv: [], cwd: '/' }).state, 'failed', 'nothing to run');
});

test('Terms: sizes are clamped, resize goes to the PTY, a dead one refuses both', async () => {
  const { proc, terms } = make();
  const t = terms.open('s', { argv: ['x'], cwd: '/', cols: 9999, rows: 1 });
  assert.deepEqual([t.cols, t.rows], [500, 5]);
  assert.ok(terms.resize('s', 120, 40));
  assert.ok(terms.resize('s', 'wide', 'tall'), 'nonsense keeps the size');
  assert.deepEqual(proc.children[0]?.sizes, [[120, 40], [120, 40]]);
  proc.children[0]?.exit(0);
  await tick();
  assert.equal(terms.resize('s', 80, 24), false);
  assert.equal(terms.open('t', { argv: ['x'], cwd: '/', cols: null, rows: '' }).cols, 100, 'no size: 100 × 30');
  terms.closeAll();
});

test('Terms: active() counts running terminals a page watches or someone used in the last 15 minutes', () => {
  const { clock, proc, terms } = make();
  terms.open('a', { argv: ['x'], cwd: '/' });
  terms.open('b', { argv: ['x'], cwd: '/' });
  const page = sink();
  terms.attach('b', page);
  assert.equal(terms.active(), 2);
  clock.advance(15 * 60_000 + 1);
  assert.equal(terms.active(), 1, 'b has a page on it');
  page.close();
  assert.equal(terms.active(), 0);
  proc.children[0]?.print('x');
  assert.equal(terms.active(), 1, 'output counts as use');
  terms.closeAll();
});

test('Terms: an exited terminal is forgotten after 10 minutes; a page streaming it gets a ping every 25 s', async () => {
  const { clock, proc, terms } = make();
  terms.open('s', { argv: ['x'], cwd: '/' });
  const page = sink();
  terms.attach('s', page);
  clock.advance(50_000);
  assert.equal((page.text.match(/: ping\n\n/g) ?? []).length, 2);
  page.close();
  clock.advance(50_000);
  assert.equal((page.text.match(/: ping\n\n/g) ?? []).length, 2, 'a closed page gets no more');
  proc.children[0]?.exit(0);
  await tick();
  clock.advance(10 * 60_000);
  assert.equal(terms.info('s'), null);
  assert.equal(clock.pending(), 0, 'no timer left behind');
});

test('termEnv: a Claude Code session that started wisp does not leak; a take over drops costly settings, a shell keeps them', () => {
  const env = { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_AGENT_PROGRESS_SUMMARIES: '1', NO_COLOR: '1' };
  const take = termEnv(env, true);
  assert.deepEqual([take['CLAUDECODE'], take['CLAUDE_CODE_CHILD_SESSION'], take['CLAUDE_CODE_SESSION_ID'], take['CLAUDE_CODE_USE_BEDROCK']], [undefined, undefined, undefined, '1']);
  assert.equal(take['CLAUDE_CODE_AGENT_PROGRESS_SUMMARIES'], undefined, 'take over: gone');
  assert.equal(termEnv(env, false)['CLAUDE_CODE_AGENT_PROGRESS_SUMMARIES'], '1', 'shell: the user’s own');
  assert.deepEqual([take['TERM'], take['COLORTERM'], take['TERM_PROGRAM'], take['NO_COLOR']], ['xterm-256color', 'truecolor', 'wisp', undefined]);
  const { proc, terms } = make('takeover', env);
  terms.open('e', { argv: ['x'], cwd: '/' });
  assert.equal(proc.calls[0]?.env['CLAUDECODE'], undefined, 'what the registry spawns with');
  terms.closeAll();
});
