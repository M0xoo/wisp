// Ported from v1 test/proc.test.js: npm .cmd shim parsing and cmd.exe escaping everywhere; on
// Windows, real resolution of .cmd/.bat/.ps1 launchers with arguments that must arrive byte-for-byte.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { escapeCmdArgument, parseCmdShim, resolveCommand } from '../src/resolve-command.ts';
import { startNative } from '../src/index.ts';

const win = process.platform === 'win32';
const npmCmdShim = (target: string): string =>
  `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target.replace(/\//g, '\\')}" %*\r\n`;

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

function echoer(dir: string): string {
  const js = path.join(dir, 'node_modules', 'echo', 'echo.js');
  fs.mkdirSync(path.dirname(js), { recursive: true });
  fs.writeFileSync(js, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  return js;
}

async function argvThrough(bin: string, args: string[], env: Record<string, string>): Promise<unknown> {
  const host = await startNative();
  try {
    const p = await host.spawnTree({ cmd: bin, args, env });
    let out = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    await p.exited;
    return JSON.parse(out);
  } finally {
    await host.close();
  }
}

const winEnv = (dir: string): Record<string, string> => ({ ...(process.env as Record<string, string>), PATH: `${dir};${process.env['PATH'] ?? ''}` });

test('Windows: npm .cmd shims are unwrapped to node <script>, arguments intact', { skip: !win && 'Windows only' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-'));
  echoer(dir);
  fs.writeFileSync(path.join(dir, 'echoer.cmd'), npmCmdShim('node_modules/echo/echo.js'));
  const r = resolveCommand('echoer', NASTY, { env: winEnv(dir) });
  assert.match(r.command, /node(\.exe)?$/i);
  assert.equal(r.verbatim, false);
  assert.deepEqual(await argvThrough('echoer', NASTY, winEnv(dir)), NASTY);
});

test('Windows: unknown .bat files go through cmd.exe with escaping, arguments intact', { skip: !win && 'Windows only' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bat-'));
  const js = echoer(dir);
  fs.writeFileSync(path.join(dir, 'plainbat.bat'), `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`);
  assert.equal(resolveCommand('plainbat', [], { env: winEnv(dir) }).verbatim, true);
  assert.deepEqual(await argvThrough('plainbat', NASTY, winEnv(dir)), NASTY);
});

test('Windows: .ps1-only installs run through PowerShell', { skip: !win && 'Windows only' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps1-'));
  const js = echoer(dir);
  fs.writeFileSync(path.join(dir, 'psonly.ps1'), `& "${process.execPath}" "${js}" @args\r\n`);
  const args = ['--resume', 'abc-123', 'two words'];
  assert.deepEqual(await argvThrough('psonly', args, winEnv(dir)), args);
});

test('git is available (diff baselines depend on it)', () => {
  assert.match(execFileSync('git', ['--version']).toString(), /git version/);
});
