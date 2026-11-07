// The fallback's pure parts: how a terminal is started, what the helper reports, the ps walk.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HELPER, parseNote, ptyCommand, python } from '../src/fallback/pty-helper.ts';
import { members, parsePs } from '../src/fallback/tree.ts';

test('ptyCommand: the Python helper when there is one, else script(1) at a fixed size', () => {
  const py = ptyCommand(['claude', '--resume', 'a b'], { cols: 90, rows: 30, py: 'python3' });
  assert.equal(py.command, 'python3');
  assert.deepEqual(py.args.slice(2), ['30', '90', 'claude', '--resume', 'a b']);
  assert.equal(py.helper, true);
  const linux = ptyCommand(['claude', '--resume', 'a b'], { cols: 90, rows: 30, py: null, platform: 'linux' });
  assert.equal(linux.command, 'script');
  assert.equal(linux.helper, false);
  assert.match(linux.args[1] ?? '', /stty rows 30 cols 90 2>\/dev\/null; exec claude --resume 'a b'/);
  const mac = ptyCommand(['x'], { cols: 80, rows: 24, py: null, platform: 'darwin' });
  assert.equal(mac.command, 'sh');
  assert.match(mac.args[1] ?? '', /\| \{ script -q \/dev\/null sh -c "\$1"/, 'fed through a real pipe: macOS script(1) refuses a socket');
  assert.equal(python({ platform: 'linux', env: {} }), null, 'no python3 on PATH');
  assert.equal(python({ platform: 'darwin', env: { PATH: '/usr/bin' }, run: (cmd) => ({ status: cmd === '/usr/bin/xcode-select' ? 2 : 0 }) }), null, 'the developer-tools stub does not count');
});

test('the helper sets the size before the program starts and reports pid and exit on fd 3', () => {
  const child = HELPER.slice(HELPER.indexOf('if pid == 0:'), HELPER.indexOf('os.execvp'));
  assert.match(child, /size\(0, rows, cols\)/);
  assert.deepEqual(parseNote('pid 42'), { pid: 42 });
  assert.deepEqual(parseNote('exit 3 -'), { code: 3, signal: null });
  assert.deepEqual(parseNote('exit - SIGHUP'), { code: null, signal: 'SIGHUP' });
  assert.equal(parseNote('exit x y'), null);
});

test('the ps walk follows the group and parent links, and trusts no exited root pid', () => {
  const rows = parsePs('  100    50   100 S\n  101   100   100 S+\n  102   101   102 Ss\n  103   102   103 S\n  200    50   200 S\n  104   100   100 Z\n garbage\n');
  assert.deepEqual([...members(100, true, rows)].sort(), [100, 101, 102, 103]);
  // 100 was reused by a stranger in another group; 101 is our group's survivor.
  assert.deepEqual([...members(100, false, parsePs('100 1 9999 S\n101 1 100 S\n'))], [101]);
  assert.deepEqual([...members(process.pid, true, parsePs(`${process.pid} 1 ${process.pid} S\n`))], [], 'never ourselves');
});
