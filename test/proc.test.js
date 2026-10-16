// Launching CLIs: npm .cmd shim parsing and cmd.exe escaping everywhere; on Windows, real
// resolution of .cmd/.bat/.ps1 launchers with arguments that must arrive byte-for-byte.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { escapeCmdArgument, execFile, parseCmdShim, resolveCommand, spawn } from '../server/proc.js';
import { npmCmdShim, tmp, win } from './helpers.js';

test('parseCmdShim understands npm, pnpm-style and native-binary shims', () => {
  assert.deepEqual(parseCmdShim(npmCmdShim('node_modules/@openai/codex/bin/codex.js')), { script: 'node_modules\\@openai\\codex\\bin\\codex.js' });
  assert.deepEqual(parseCmdShim('@"%~dp0\\node.exe"  "%~dp0\\..\\opencode-ai\\bin\\opencode" %*\r\n'), { script: '..\\opencode-ai\\bin\\opencode' });
  assert.deepEqual(parseCmdShim('@ECHO off\r\n"%dp0%\\node_modules\\tool\\bin\\tool.exe"   %*\r\n'), { exe: 'node_modules\\tool\\bin\\tool.exe' });
  assert.equal(parseCmdShim('@echo off\r\necho hello\r\n'), null);
  assert.equal(parseCmdShim('"C:\\elsewhere\\x.exe" %*'), null, 'only targets relative to the shim');
});

test('escapeCmdArgument matches cross-spawn', () => {
  // Expected values produced by cross-spawn@7 lib/util/escape.js.
  assert.equal(escapeCmdArgument('plain'), '^"plain^"');
  assert.equal(escapeCmdArgument('a "b" & c'), '^"a^ \\^"b\\^"^ ^&^ c^"');
  assert.equal(escapeCmdArgument('trail\\'), '^"trail\\\\^"');
  assert.equal(escapeCmdArgument('%PATH%!', true), '^^^"^^^%PATH^^^%^^^!^^^"');
});

test('resolveCommand is a pass-through off Windows', () => {
  assert.deepEqual(resolveCommand('codex', ['exec', '--json'], { platform: 'linux' }), { command: 'codex', args: ['exec', '--json'], verbatim: false });
});

// Arguments wisp really passes: JSON, TOML, Windows paths, spaces, quotes, cmd metacharacters.
const NASTY = ['exec', '-c', 'mcp_servers.wisp.env={WISP_URL="http://127.0.0.1:4477",X="a b"}', 'C:\\Program Files\\x\\', 'say "hi" & echo pwned | more', '100%', '^caret^', '(parens)', ''];

function echoer(dir) {
  const js = path.join(dir, 'node_modules', 'echo', 'echo.js');
  fs.mkdirSync(path.dirname(js), { recursive: true });
  fs.writeFileSync(js, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  return js;
}

test('Windows: npm .cmd shims are unwrapped to node <script>, arguments intact', { skip: !win && 'Windows only' }, async () => {
  const dir = tmp('shim');
  echoer(dir);
  fs.writeFileSync(path.join(dir, 'echoer.cmd'), npmCmdShim('node_modules/echo/echo.js'));
  const env = { ...process.env, PATH: `${dir};${process.env.PATH}` };
  const r = resolveCommand('echoer', NASTY, { env });
  assert.match(r.command, /node(\.exe)?$/i);
  assert.equal(r.verbatim, false);
  const out = await new Promise((res, rej) => execFile('echoer', NASTY, { env }, (e, so) => (e ? rej(e) : res(so))));
  assert.deepEqual(JSON.parse(out), NASTY);
});

test('Windows: unknown .bat files go through cmd.exe with escaping, arguments intact', { skip: !win && 'Windows only' }, async () => {
  const dir = tmp('bat');
  const js = echoer(dir);
  fs.writeFileSync(path.join(dir, 'plainbat.bat'), `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`);
  const env = { ...process.env, PATH: `${dir};${process.env.PATH}` };
  assert.equal(resolveCommand('plainbat', [], { env }).verbatim, true);
  const out = await new Promise((res, rej) => execFile('plainbat', NASTY, { env }, (e, so) => (e ? rej(e) : res(so))));
  assert.deepEqual(JSON.parse(out), NASTY);
});

test('Windows: .ps1-only installs run through PowerShell', { skip: !win && 'Windows only' }, async () => {
  const dir = tmp('ps1');
  const js = echoer(dir);
  fs.writeFileSync(path.join(dir, 'psonly.ps1'), `& "${process.execPath}" "${js}" @args\r\n`);
  const env = { ...process.env, PATH: `${dir};${process.env.PATH}` };
  const args = ['--resume', 'abc-123', 'two words'];
  const out = await new Promise((res, rej) => execFile('psonly', args, { env }, (e, so) => (e ? rej(e) : res(so))));
  assert.deepEqual(JSON.parse(out), args);
});

test('spawn() reports a missing CLI as an error event, not a throw', async () => {
  const child = spawn('definitely-not-a-real-cli-wisp', ['--version'], {});
  const err = await new Promise((res) => child.on('error', res));
  assert.equal(err.code, 'ENOENT');
});

test('git is available (diff baselines depend on it)', () => {
  assert.match(execFileSync('git', ['--version']).toString(), /git version/);
});
