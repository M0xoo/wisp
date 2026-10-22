// Take over in wisp: the terminal the server runs for the page (server/pty.js), the take over and
// /term routes around it, and the page's screen (web/js/term-emu.js).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { installFakeBins, makeRepo, tmp } from './helpers.js';
import { ptyCommand, python, Terms } from '../server/pty.js';
import { inWisp, terminalsFor } from '../server/terminal.js';
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
  const { startServer } = await import('../server/index.js');
  const port = await freePort();
  srv = await startServer({ port, handleSignals: false });
  base = `http://127.0.0.1:${port}`;
});
after(() => {
  srv?.shutdown();
  srv?.server.close();
});

test('take over in wisp: the agent on a terminal the page streams, types into and ends', { skip: win || !python() }, async () => {
  const repo = makeRepo();
  const s = await api('/sessions', { body: { prompt: 'fix it', cwd: repo.dir, agent: 'claude', worktree: false } });
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
  const until = async (re) => {
    while (!re.test(text)) text += new TextDecoder().decode((await reader.read()).value);
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
