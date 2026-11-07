// "Take over" command lines for every terminal app on every platform, built without launching
// anything (v1 test/terminal.test.js), and when the page's own terminal is the one (v1 pty.test.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultTerminal, detectTerminal, inWisp, openInTerminal, type Step, terminalPlan, terminalsFor } from '../src/apps.ts';
import { manualTime } from './fixtures/clock.ts';

const argv = ['codex', 'resume', "it's-1"];
const cwd = '/home/me/my project';
const plan = (terminal: string, platform: string, extra: Partial<Parameters<typeof terminalPlan>[0]> = {}): Step[] => terminalPlan({ cwd, argv, terminal, platform, env: {}, has: () => false, exists: () => false, ...extra });
const run = (s: Step | undefined): { command: string; args: string[]; options?: Record<string, unknown> } => {
  assert.ok(s && 'command' in s, 'a command step');
  return s as { command: string; args: string[]; options?: Record<string, unknown> };
};
const osa = (s: Step | undefined): string => {
  assert.ok(s && 'osa' in s, 'an AppleScript step');
  return s.osa;
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

test('each platform only lists terminals it can run', () => {
  const ids = (p: string): string[] => terminalsFor(p).map((t) => t.id);
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

test('cmux: detected inside cmux (before Ghostty) and opens a workspace, with a fallback', () => {
  const env = { TERM_PROGRAM: 'ghostty', CMUX_WORKSPACE_ID: 'abc' };
  assert.equal(detectTerminal({ platform: 'darwin', env, exists: () => true }), 'cmux');
  assert.equal(detectTerminal({ platform: 'darwin', env, exists: (p) => p !== '/Applications/cmux.app' }), 'ghostty');
  assert.ok(terminalsFor('darwin').some((t) => t.id === 'cmux') && !terminalsFor('linux').some((t) => t.id === 'cmux'));
  const step = run(plan('cmux', 'darwin')[0]);
  assert.equal(step.command, '/bin/sh');
  const [, script, , cli, dir, cmd, typeIt] = step.args;
  assert.equal(cli, '/Applications/cmux.app/Contents/Resources/bin/cmux', 'falls back to the bundled CLI');
  assert.match(script ?? '', /"\$1" new-workspace --cwd "\$2" --command "\$3"/);
  assert.match(script ?? '', /\|\| \{ open -a cmux "\$2"/);
  assert.equal(dir, cwd);
  assert.equal(cmd, `'codex' 'resume' 'it'\\''s-1'`);
  assert.match(typeIt ?? '', /keystroke ".*" & return/);
  assert.equal(run(plan('cmux', 'darwin', { has: (b) => b === 'cmux' })[0]).args[3], 'cmux');
});

test('macOS Terminal.app gets a quoted cd && command', () => {
  assert.match(osa(plan('terminal', 'darwin')[0]), /do script "cd '\/home\/me\/my project' && 'codex' 'resume' 'it'\\\\''s-1'"/);
});

test('Warp: open the folder, wait, then type the command', () => {
  const steps = plan('warp', 'darwin');
  assert.deepEqual(run(steps[0]).args, ['-a', 'Warp', cwd]);
  assert.deepEqual(steps[1], { delay: 1200 });
  assert.match(osa(steps[2]), /keystroke/);
});

test('Linux terminals open in the project and keep a shell afterwards', () => {
  for (const t of ['gnome-terminal', 'konsole', 'xfce4-terminal', 'alacritty', 'kitty', 'ghostty', 'xterm', 'x-terminal-emulator']) {
    const step = run(plan(t, 'linux')[0]);
    assert.equal(step.command, t);
    const joined = step.args.join(' ');
    assert.ok(joined.includes(cwd) || t === 'xterm' || t === 'x-terminal-emulator', `${t} gets the cwd`);
    assert.deepEqual(step.args.slice(-3, -1), ['sh', '-c']);
    assert.equal(step.args.at(-1), `'codex' 'resume' 'it'\\''s-1'; exec "\${SHELL:-sh}"`);
  }
});

test('Windows Terminal / PowerShell / cmd', () => {
  const wcwd = 'C:\\Users\\me\\my project';
  const wt = run(terminalPlan({ cwd: wcwd, argv, terminal: 'wt', platform: 'win32', env: {} })[0]);
  assert.deepEqual(wt.args.slice(0, 5), ['-d', wcwd, 'powershell.exe', '-NoExit', '-Command']);
  assert.equal(wt.args[5], "& 'codex' 'resume' 'it''s-1'");
  assert.equal(wt.options?.['cwd'], wcwd);
  const ps = run(terminalPlan({ cwd: wcwd, argv, terminal: 'powershell', platform: 'win32', env: {} })[0]);
  assert.deepEqual([ps.command, ...ps.args], ['powershell.exe', '-NoExit', '-Command', "& 'codex' 'resume' 'it''s-1'"]);
  assert.equal(ps.options?.['detached'], true, 'detached = its own console window');
  const cmd = run(terminalPlan({ cwd: wcwd, argv, terminal: 'cmd', platform: 'win32', env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' } })[0]);
  assert.equal(cmd.command, 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(cmd.options?.['windowsVerbatimArguments'], true);
  assert.deepEqual(cmd.args.slice(0, 3), ['/d', '/s', '/k']);
});

test('wt: semicolons are escaped so they do not split wt subcommands', () => {
  const step = run(terminalPlan({ cwd: 'C:\\p', argv: ['x', 'a;b'], terminal: 'wt', platform: 'win32', env: {} })[0]);
  assert.equal(step.args.at(-1), "& 'x' 'a\\;b'");
});

test('custom command fills placeholders per platform', () => {
  const posix = run(terminalPlan({ cwd, argv, terminal: 'custom', custom: 'foot -D {cwd} {cmd}', platform: 'linux', env: {} })[0]);
  assert.deepEqual([posix.command, posix.args[0]], ['sh', '-c']);
  assert.equal(posix.args[1], `foot -D '/home/me/my project' 'codex' 'resume' 'it'\\''s-1'`);
  const w = run(terminalPlan({ cwd: 'C:\\p', argv, terminal: 'custom', custom: 'alacritty --working-directory {cwd} -e {cmd}', platform: 'win32', env: {} })[0]);
  assert.equal(w.options?.['windowsVerbatimArguments'], true);
  assert.throws(() => terminalPlan({ cwd, argv, terminal: 'custom', custom: '', platform: 'linux', env: {} }), /custom terminal command/);
  assert.throws(() => terminalPlan({ cwd, argv, terminal: 'wisp', platform: 'linux', env: {} }), /In wisp/);
});

test('openInTerminal: steps run in order through proc, delays wait, a missing app is swallowed', () => {
  const clock = manualTime();
  const ran: string[] = [];
  const proc = {
    spawn(bin: string, args: readonly string[], o: { cwd: string; detached: true; tree: false; verbatim?: boolean }) {
      ran.push(`${bin} ${args[0] ?? ''} ${o.cwd} ${o.detached} ${o.tree} ${o.verbatim ?? false}`);
      if (bin === 'missing') throw new Error('ENOENT');
      return { exited: Promise.reject(new Error('exit 1')) };
    },
  };
  openInTerminal([{ command: 'open', args: ['-a'] }, { delay: 1200 }, { osa: 'tell' }, { command: 'missing', args: [] }], '/p', proc, clock.later);
  assert.deepEqual(ran, ['open -a /p true false false']);
  clock.advance(1200);
  assert.deepEqual(ran.slice(1), ['osascript -e /p true false false', 'missing  /p true false false']);
  openInTerminal(plan('cmd', 'win32'), 'C:\\', proc, clock.later);
  assert.match(ran.at(-1) ?? '', / true$/, 'cmd.exe gets its line verbatim');
});
