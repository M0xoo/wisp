// "Take over" command lines for every terminal on every platform, built without launching anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTerminal, terminalPlan, terminalsFor } from '../server/terminal.js';

const argv = ['codex', 'resume', "it's-1"];
const cwd = '/home/me/my project';
const plan = (terminal, platform, extra = {}) => terminalPlan({ cwd, argv, terminal, platform, env: {}, has: () => false, exists: () => false, ...extra });

test('each platform only lists terminals it can run', () => {
  const ids = (p) => terminalsFor(p).map((t) => t.id);
  assert.ok(ids('darwin').includes('iterm') && !ids('darwin').includes('wt'));
  assert.ok(ids('win32').includes('wt') && ids('win32').includes('powershell') && !ids('win32').includes('terminal'));
  assert.ok(ids('linux').includes('gnome-terminal') && !ids('linux').includes('iterm') && !ids('linux').includes('wt'));
  for (const p of ['darwin', 'win32', 'linux']) assert.deepEqual([ids(p)[0], ids(p).at(-1)], ['auto', 'custom']);
});

test('auto-detect', () => {
  assert.equal(detectTerminal({ platform: 'darwin', env: {}, exists: () => false }), 'terminal');
  assert.equal(detectTerminal({ platform: 'darwin', env: { TERM_PROGRAM: 'iTerm.app' }, exists: () => true }), 'iterm');
  assert.equal(detectTerminal({ platform: 'win32', env: {}, has: (b) => b === 'wt' }), 'wt');
  assert.equal(detectTerminal({ platform: 'win32', env: {}, has: () => false }), 'powershell');
  assert.equal(detectTerminal({ platform: 'linux', env: {}, has: (b) => b === 'konsole' || b === 'xterm' }), 'konsole');
  assert.equal(detectTerminal({ platform: 'linux', env: {}, has: () => false }), 'xterm');
});

test('macOS Terminal.app gets a quoted cd && command', () => {
  const [step] = plan('terminal', 'darwin');
  assert.match(step.osa, /do script "cd '\/home\/me\/my project' && 'codex' 'resume' 'it'\\\\''s-1'"/);
});

test('Linux terminals open in the project and keep a shell afterwards', () => {
  for (const t of ['gnome-terminal', 'konsole', 'xfce4-terminal', 'alacritty', 'kitty', 'ghostty', 'xterm', 'x-terminal-emulator']) {
    const [step] = plan(t, 'linux');
    assert.equal(step.command, t);
    const joined = step.args.join(' ');
    assert.ok(joined.includes(cwd) || t === 'xterm' || t === 'x-terminal-emulator', `${t} gets the cwd`);
    assert.deepEqual(step.args.slice(-3, -1), ['sh', '-c']);
    assert.equal(step.args.at(-1), `'codex' 'resume' 'it'\\''s-1'; exec "\${SHELL:-sh}"`);
  }
});

test('Windows Terminal / PowerShell / cmd', () => {
  const wcwd = 'C:\\Users\\me\\my project';
  const wt = terminalPlan({ cwd: wcwd, argv, terminal: 'wt', platform: 'win32', env: {} })[0];
  assert.deepEqual(wt.args.slice(0, 5), ['-d', wcwd, 'powershell.exe', '-NoExit', '-Command']);
  assert.equal(wt.args[5], "& 'codex' 'resume' 'it''s-1'");
  assert.equal(wt.options.cwd, wcwd);

  const ps = terminalPlan({ cwd: wcwd, argv, terminal: 'powershell', platform: 'win32', env: {} })[0];
  assert.deepEqual([ps.command, ...ps.args], ['powershell.exe', '-NoExit', '-Command', "& 'codex' 'resume' 'it''s-1'"]);
  assert.equal(ps.options.detached, true, 'detached = its own console window');

  const cmd = terminalPlan({ cwd: wcwd, argv, terminal: 'cmd', platform: 'win32', env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' } })[0];
  assert.equal(cmd.command, 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(cmd.options.windowsVerbatimArguments, true);
  assert.deepEqual(cmd.args.slice(0, 3), ['/d', '/s', '/k']);
});

test('wt: semicolons are escaped so they do not split wt subcommands', () => {
  const [step] = terminalPlan({ cwd: 'C:\\p', argv: ['x', 'a;b'], terminal: 'wt', platform: 'win32', env: {} });
  assert.equal(step.args.at(-1), "& 'x' 'a\\;b'");
});

test('custom command fills placeholders per platform', () => {
  const [posix] = terminalPlan({ cwd, argv, terminal: 'custom', custom: 'foot -D {cwd} {cmd}', platform: 'linux', env: {} });
  assert.deepEqual([posix.command, posix.args[0]], ['sh', '-c']);
  assert.equal(posix.args[1], `foot -D '/home/me/my project' 'codex' 'resume' 'it'\\''s-1'`);
  const [w] = terminalPlan({ cwd: 'C:\\p', argv, terminal: 'custom', custom: 'alacritty --working-directory {cwd} -e {cmd}', platform: 'win32', env: {} });
  assert.equal(w.options.windowsVerbatimArguments, true);
  assert.throws(() => terminalPlan({ cwd, argv, terminal: 'custom', custom: '', platform: 'linux' }), /custom terminal command/);
});
