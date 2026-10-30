// Take over in wisp: the terminal the server runs for the page (server/pty.js), the take over and
// /term routes around it, and the page's screen (web/js/term-emu.js).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, makeRepo, tmp, isolateAgentConfigs } from './helpers.js';
import { ptyCommand, python, Terms } from '../server/pty.js';
import { defaultTerminal, inWisp, terminalsFor } from '../server/terminal.js';
import { keyBytes, Screen } from '../web/js/term-emu.js';

const win = process.platform === 'win32';
const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('inWisp: asked for, or auto where there is no desktop (a wisp Grid, a headless Linux)', () => {
  assert.equal(inWisp('wisp', { platform: 'darwin', env: {} }), true);
  assert.equal(inWisp('auto', { platform: 'darwin', env: {} }), false);
  assert.equal(inWisp('auto', { platform: 'linux', env: { DISPLAY: ':0' } }), false);
  assert.equal(inWisp('auto', { platform: 'linux', env: {} }), true);
  assert.equal(inWisp('auto', { platform: 'linux', env: { DISPLAY: ':0', WISP_GRID_URL: 'https://grid.example' } }), true);
  assert.equal(inWisp('iterm', { platform: 'linux', env: {} }), false);
  assert.equal(inWisp('wisp', { platform: 'win32', env: {} }), false, 'no pty on Windows');
  assert.ok(terminalsFor('linux').some((t) => t.id === 'wisp') && !terminalsFor('win32').some((t) => t.id === 'wisp'));
});

test('defaultTerminal: in wisp unless the computer has no pty (Windows)', () => {
  assert.equal(defaultTerminal('darwin'), 'wisp');
  assert.equal(defaultTerminal('linux'), 'wisp');
  assert.equal(defaultTerminal('win32'), 'auto');
  assert.equal(inWisp(defaultTerminal('darwin'), { platform: 'darwin', env: {} }), true);
});

test('ptyCommand: the Python helper when there is one, else script(1) at a fixed size', () => {
  const [cmd, args, resizable] = ptyCommand(['claude', '--resume', 'a b'], { cols: 90, rows: 30, py: 'python3' });
  assert.equal(cmd, 'python3');
  assert.deepEqual(args.slice(2), ['30', '90', 'claude', '--resume', 'a b']);
  assert.equal(resizable, true);
  const [lc, la, lr] = ptyCommand(['claude', '--resume', 'a b'], { cols: 90, rows: 30, py: null, platform: 'linux' });
  assert.equal(lc, 'script');
  assert.equal(lr, false);
  assert.match(la[1], /stty rows 30 cols 90 2>\/dev\/null; 'claude' '--resume' 'a b'/);
  const [, ma] = ptyCommand(['x'], { py: null, platform: 'darwin' });
  assert.deepEqual(ma.slice(0, 4), ['-q', '/dev/null', 'sh', '-c']);
  assert.equal(python({ platform: 'linux', env: {}, has: () => false }), null);
});

test('Terms: runs on a terminal, takes input and a new size, replays its output to a late page', { skip: win || !python() }, async () => {
  const terms = new Terms();
  const t = terms.open('s1', { argv: ['sh', '-c', 'stty size; read l; stty size; echo "got $l"'], cwd: tmp('pty'), cols: 90, rows: 33 });
  assert.equal(terms.open('s1', { argv: ['false'], cwd: '/' }), t, 'one terminal per session');
  await waitFor(() => t.out.includes('33 90'));
  assert.ok(terms.resize('s1', 120, 40));
  await new Promise((r) => setTimeout(r, 100));
  terms.input('s1', 'hello\r');
  await waitFor(() => t.code !== null);
  assert.equal(t.code, 0);
  assert.match(t.out, /40 120\r\ngot hello/);
  assert.equal(terms.active(), 0, 'an ended terminal keeps nothing awake');
  // A page that attaches now gets hello, everything so far, and the exit.
  let body = '';
  const res = { writeHead() {}, write: (s) => (body += s), end: (s = '') => (body += s) };
  terms.attach('s1', { on() {} }, res);
  assert.match(body, /^event: hello\n/);
  assert.match(body, /event: data\ndata: ".*got hello/);
  assert.match(body, /event: exit\ndata: \{"code":0\}/);
  assert.equal(terms.input('s1', 'x'), false);
  assert.ok(terms.close('s1'));
  assert.equal(terms.get('s1'), null);
});

test('Terms: a Claude Code session that started wisp does not leak into its terminals', { skip: win || !python() }, async () => {
  const terms = new Terms({ env: { ...process.env, CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_USE_BEDROCK: '1' } });
  const t = terms.open('env', { argv: ['sh', '-c', 'echo "[$CLAUDECODE][$CLAUDE_CODE_CHILD_SESSION][$CLAUDE_CODE_SESSION_ID][$CLAUDE_CODE_USE_BEDROCK]"'], cwd: tmp('pty-env') });
  await waitFor(() => t.code !== null);
  assert.match(t.out, /\[\]\[\]\[\]\[1\]/, 'its markers go; the user\'s own settings stay');
  terms.close('env');
});

// --- the routes ------------------------------------------------------------------------------

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let srv;
let base;
const api = async (p, { method, body } = {}) => {
  const r = await fetch(`${base}/api${p}`, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const out = await r.json();
  if (!r.ok) throw Object.assign(new Error(out.error), { status: r.status });
  return out;
};
before(async () => {
  if (win) return;
  process.env.WISP_HOME = tmp('pty-home');
  process.env.WISP_UPDATE_CHECK = '0';
  installFakeBins();
  isolateAgentConfigs();
  const { startServer } = await import('../server/index.js');
  const port = await freePort();
  srv = await startServer({ port, handleSignals: false });
  base = `http://127.0.0.1:${port}`;
});
after(() => {
  srv?.shutdown();
  srv?.server.closeAllConnections?.(); // a failed take over leaves its event stream open
  srv?.server.close();
});

test('take over in wisp: the agent on a terminal the page streams, types into and ends', { skip: win || !python() }, async () => {
  const repo = makeRepo();
  const s = await api('/sessions', { body: { prompt: 'fix it', cwd: repo, agent: 'claude', worktree: false } });
  await waitFor(async () => (await api(`/sessions/${s.id}`)).state !== 'running');
  const out = await api(`/sessions/${s.id}/takeover`, { body: { inline: true, cols: 100, rows: 20 } });
  assert.equal(out.inline, true);
  assert.match(out.command, /claude' '--resume'/);
  assert.equal((await api('/sessions')).find((x) => x.id === s.id).term, true, 'the card says it is in a terminal');
  // The output, as server-sent events.
  const ctl = new AbortController();
  const r = await fetch(`${base}/api/sessions/${s.id}/term`, { signal: ctl.signal });
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const reader = r.body.getReader();
  let text = '';
  // Fails rather than waits forever: a stream that ends or goes quiet is the test's failure.
  const until = async (re) => {
    const end = Date.now() + 15_000;
    while (!re.test(text)) {
      let timer;
      const quiet = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`no ${re} in: ${JSON.stringify(text)}`)), end - Date.now())));
      const { value, done } = await Promise.race([reader.read(), quiet]).finally(() => clearTimeout(timer));
      if (done) throw new Error(`the stream ended without ${re}: ${JSON.stringify(text)}`);
      text += new TextDecoder().decode(value);
    }
  };
  await until(/fake claude.*interactive · session claude-session-1 · 100x20/);
  await api(`/sessions/${s.id}/term`, { body: { data: 'hi there\r' } });
  await until(/you said: .*hi there/);
  await api(`/sessions/${s.id}/term`, { body: { cols: 120, rows: 30 } });
  await until(/resized 120x30/);
  // Taking over again shows the same terminal; a follow-up waits for it to end.
  assert.equal((await api(`/sessions/${s.id}/takeover`, { body: { inline: true } })).inline, true);
  await assert.rejects(api(`/sessions/${s.id}/reply`, { body: { text: 'more' } }), (e) => e.status === 409 && /open in a terminal/.test(e.message));
  // /exit ends it, and the task is free again.
  await api(`/sessions/${s.id}/term`, { body: { data: '/exit\r' } });
  await until(/event: exit\ndata: \{"code":0\}/);
  ctl.abort();
  assert.equal((await api('/sessions')).find((x) => x.id === s.id).term, undefined);
  await assert.rejects(api(`/sessions/${s.id}/term`, { body: { data: 'x' } }), (e) => e.status === 404);
  assert.equal((await api(`/sessions/${s.id}/term`, { method: 'DELETE' })).ok, true);
  assert.equal((await api('/status')).terms, 0);
});

test('/terminal: one task in its terminal with Babysitting mode off, the command left out of its prompt', { skip: win || !python() }, async () => {
  const repo = makeRepo();
  assert.notEqual((await api('/config')).defaults.terminalSessions, 'on');
  const s = await api('/sessions', { body: { prompt: '/terminal fix the login bug', cwd: repo, agent: 'claude', worktree: false } });
  assert.equal(s.tui, true);
  assert.equal(s.term, true);
  const full = await api(`/sessions/${s.id}`);
  assert.equal(full.turns[0].prompt, 'fix the login bug');
  const t = await stream(s.id);
  await t.until(/you said: .*fix the login bug/);
  t.close();
  assert.equal((await api(`/sessions/${s.id}/term`, { method: 'DELETE' })).ok, true);
  // It can't be one with what wisp has to drive itself: refused, before any worktree is made.
  await assert.rejects(api('/sessions', { body: { prompt: '/terminal ship it', cwd: repo, agent: 'claude', goal: { text: 'tests pass' } } }), (e) => e.status === 400 && /\/terminal starts one task/.test(e.message));
});

// Reads a task's terminal stream until re matches; fails rather than waits for ever.
async function stream(id) {
  const ctl = new AbortController();
  const reader = (await fetch(`${base}/api/sessions/${id}/term`, { signal: ctl.signal })).body.getReader();
  const out = { text: '', close: () => ctl.abort() };
  out.until = async (re) => {
    const end = Date.now() + 15_000;
    while (!re.test(out.text)) {
      let timer;
      const quiet = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`no ${re} in: ${JSON.stringify(out.text)}`)), end - Date.now())));
      const { value, done } = await Promise.race([reader.read(), quiet]).finally(() => clearTimeout(timer));
      if (done) throw new Error(`the stream ended without ${re}: ${JSON.stringify(out.text)}`);
      out.text += new TextDecoder().decode(value);
    }
  };
  return out;
}

test('terminal sessions: a task starts as the agent on a terminal, follow-ups are typed into it, and it resumes once ended', { skip: win || !python() }, async () => {
  await api('/config', { method: 'PATCH', body: { defaults: { terminalSessions: 'on' } } });
  try {
    const repo = makeRepo();
    const s = await api('/sessions', { body: { prompt: 'fix the login bug', cwd: repo, agent: 'claude', worktree: false } });
    assert.equal(s.tui, true);
    assert.equal(s.term, true, 'its terminal is open from the start');
    assert.equal(s.state, 'review', 'wisp runs nothing itself');
    const full = await api(`/sessions/${s.id}`);
    assert.match(full.agentSessionId, /^[0-9a-f-]{36}$/, 'wisp names the conversation, to resume it later');
    assert.equal(full.turns.length, 1);
    assert.equal(full.turns[0].prompt, 'fix the login bug');
    let t = await stream(s.id);
    await t.until(new RegExp(`fake claude.*interactive · session ${full.agentSessionId}[\\s\\S]*you said: .*fix the login bug`));
    // A follow-up from wisp's box is typed into the terminal, not run beside it.
    assert.equal((await api(`/sessions/${s.id}/reply`, { body: { text: 'and add a test' } })).terminal, true);
    await t.until(/you said: .*and add a test/);
    assert.equal((await api(`/sessions/${s.id}`)).turns.length, 1);
    await api(`/sessions/${s.id}/term`, { body: { data: '/exit\r' } });
    await t.until(/event: exit/);
    t.close();
    // claude never kept the conversation (the fake saves none, as a real one quitting at a start-up
    // question): it starts again under the same id. Once it has it, it's resumed.
    assert.match((await api(`/sessions/${s.id}/takeover`)).command, new RegExp(`'--session-id' '${full.agentSessionId}'[\\s\\S]*'fix the login bug'`));
    const kept = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'somewhere');
    fs.mkdirSync(kept, { recursive: true });
    fs.writeFileSync(path.join(kept, `${full.agentSessionId}.jsonl`), '{}\n');
    assert.match((await api(`/sessions/${s.id}/takeover`)).command, new RegExp(`'--resume' '${full.agentSessionId}'`));
    // Ended: a follow-up opens it again on the same conversation, and so does opening the task (take over).
    await api(`/sessions/${s.id}/reply`, { body: { text: 'one more thing' } });
    t = await stream(s.id);
    await t.until(new RegExp(`session ${full.agentSessionId}[\\s\\S]*you said: .*one more thing`));
    await api(`/sessions/${s.id}/term`, { body: { data: '/exit\r' } });
    await t.until(/event: exit/);
    t.close();
    assert.equal((await api(`/sessions/${s.id}/takeover`, { body: {} })).inline, true, 'always in the page, whatever Take over in says');
    t = await stream(s.id);
    await t.until(new RegExp(`session ${full.agentSessionId}`));
    t.close();
    assert.equal((await api(`/sessions/${s.id}/term`, { method: 'DELETE' })).ok, true);
    // Schedules, crew jobs and the like still run in wisp.
    const planned = await api('/sessions', { body: { prompt: 'plan it', cwd: repo, agent: 'claude', worktree: false, tui: false } });
    assert.equal(planned.tui, undefined);
    await waitFor(async () => (await api(`/sessions/${planned.id}`)).state !== 'running');
  } finally {
    await api('/config', { method: 'PATCH', body: { defaults: { terminalSessions: 'off' } } });
  }
});

// --- the page's screen -----------------------------------------------------------------------

const rows = (s) => s.screen.map((r) => s.text(r));

test('Screen: text, cursor moves, erase, colours and the queries agents send', () => {
  const replies = [];
  const s = new Screen(20, 4, { onReply: (r) => replies.push(r) });
  s.write('hello\r\nworld\x1b[31mred\x1b[0m\x1b[2;3Hx\x1b[K');
  assert.deepEqual(rows(s), ['hello', 'wox', '', '']);
  s.write('\x1b[1;1H\x1b[2K\x1b[38;2;255;0;10mT\x1b[48;5;196mU\x1b[1;4mV');
  const r = s.screen[0];
  assert.equal(r.p[0].fg, '#ff000a');
  assert.equal(r.p[1].bg, 196);
  assert.ok(r.p[2].f & 1 && r.p[2].f & 8);
  s.write('\x1b[6n\x1b[c\x1b]11;?\x07');
  assert.deepEqual(replies, ['\x1b[1;4R', '\x1b[?62;22c', '\x1b]11;rgb:1414/1414/1414\x1b\\']);
});

test('Screen: wrapping, scrollback, scroll regions, the alternate screen and wide characters', () => {
  const s = new Screen(5, 3);
  s.write('abcdefg');
  assert.deepEqual(rows(s), ['abcde', 'fg', '']);
  s.write('\r\n1\r\n2\r\n3');
  assert.deepEqual(s.back.map((r) => s.text(r)), ['abcde', 'fg']);
  assert.deepEqual(rows(s), ['1', '2', '3']);
  // A region: lines leaving it are gone, not scrollback.
  s.write('\x1b[1;2r\x1b[2;1H\n');
  assert.deepEqual(rows(s), ['2', '', '3']);
  assert.equal(s.back.length, 2);
  s.write('\x1b[r\x1b[?1049h\x1b[Halt');
  assert.deepEqual(rows(s), ['alt', '', '']);
  s.write('\x1b[?1049l');
  assert.deepEqual(rows(s), ['2', '', '3']);
  s.write('\x1b[3J\x1b[2J\x1b[H界x');
  assert.equal(s.back.length, 0);
  assert.deepEqual([s.screen[0].w[0], s.screen[0].w[1], s.screen[0].c[2]], [2, 0, 'x']);
  // DEC line drawing.
  s.write('\x1b[2;1H\x1b(0lqk\x1b(Bq');
  assert.equal(s.text(s.screen[1]), '┌─┐q');
});

test('Screen: a resize keeps what is on screen and the cursor on it', () => {
  const s = new Screen(10, 4);
  s.write('a\r\nb\r\nc\r\nd');
  s.resize(6, 2);
  assert.deepEqual(rows(s), ['c', 'd']);
  assert.equal(s.y, 1);
  s.resize(6, 4);
  assert.deepEqual(rows(s), ['a', 'b', 'c', 'd'], 'the scrollback comes back down');
});

test('keyBytes: what keys send', () => {
  const k = (key, mods = {}) => keyBytes({ key, ...mods });
  assert.equal(k('Enter'), '\r');
  assert.equal(k('Enter', { shiftKey: true }), '\x1b\r');
  assert.equal(k('Backspace'), '\x7f');
  assert.equal(k('Tab', { shiftKey: true }), '\x1b[Z');
  assert.equal(k('ArrowUp'), '\x1b[A');
  assert.equal(keyBytes({ key: 'ArrowUp' }, { appCursor: true }), '\x1bOA');
  assert.equal(k('ArrowLeft', { altKey: true }), '\x1b[1;3D');
  assert.equal(k('c', { ctrlKey: true }), '\x03');
  assert.equal(k('b', { altKey: true }), '\x1bb');
  assert.equal(keyBytes({ key: 'å', altKey: true }, { mac: true }), null, 'Option types characters on a Mac');
  assert.equal(k('a'), null, 'text comes through the input event');
  assert.equal(k('v', { metaKey: true }), null);
  assert.equal(k('F5'), '\x1b[15~');
});
