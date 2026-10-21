// A stand-in for OpenSSH's `ssh`, for test/machines.test.js: "the machine" is this computer.
// It honours -L <local>:<host>:<port> with a TCP relay, then runs the command with sh, its stdin
// piped through, the way sshd would. Hosts named unknown-* and locked-* fail like real ssh does;
// a locked-* host takes the password FAKE_SSH_PASSWORD (from SSH_ASKPASS, as real ssh asks it)
// and lets keys in once its ~/.ssh/authorized_keys (under FAKE_SSH_HOME) has one.
// Env: FAKE_SSH_HOME = where each host's WISP_HOME goes; FAKE_SSH_LOG = file to append each argv to.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
if (process.env.FAKE_SSH_LOG) fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(args) + '\n');
const takesValue = new Set(['-o', '-L', '-R', '-D', '-p', '-i', '-l', '-F', '-J', '-E']);
let forward = null;
let target = null;
let i = 0;
for (; i < args.length; i++) {
  const a = args[i];
  if (takesValue.has(a)) {
    if (a === '-L') forward = args[i + 1];
    i++;
  } else if (!a.startsWith('-')) {
    target = a;
    i++;
    break;
  }
}
const command = args.slice(i).join(' ');

if (target.startsWith('unknown')) {
  console.error(`ssh: Could not resolve hostname ${target}: nodename nor servname provided, or not known`);
  process.exit(255);
}
const lockedHome = path.join(process.env.FAKE_SSH_HOME || os.tmpdir(), target.replace(/\W+/g, '_'));
const byPassword = args.some((a) => /^PreferredAuthentications=.*password/.test(a));
if (target.startsWith('locked') && byPassword) {
  const typed = execFileSync(process.env.SSH_ASKPASS, ['password:'], { encoding: 'utf8' }).trim();
  if (process.env.SSH_ASKPASS_REQUIRE !== 'force' || typed !== process.env.FAKE_SSH_PASSWORD) {
    console.error(`${target}: Permission denied (publickey,password).`);
    process.exit(255);
  }
} else if (target.startsWith('locked') && !fs.existsSync(path.join(lockedHome, '.ssh', 'authorized_keys'))) {
  console.error(`${target}: Permission denied (publickey).`);
  process.exit(255);
}

let relay = null;
if (forward) {
  const [lport, host, rport] = forward.split(':');
  relay = net
    .createServer((sock) => {
      const up = net.connect(Number(rport), host);
      sock.pipe(up).pipe(sock);
      up.on('error', () => sock.destroy());
      sock.on('error', () => up.destroy());
    })
    .listen(Number(lport), '127.0.0.1');
}

// SHELL=false: the login-shell PATH probe finds nothing, so only this PATH (with the fake
// harnesses on it) reaches wisp over there.
// Each host gets its own WISP_HOME under FAKE_SSH_HOME, so two fake machines are two wisps.
const there = process.env.FAKE_SSH_HOME ? path.join(process.env.FAKE_SSH_HOME, target.replace(/\W+/g, '_')) : process.env.WISP_HOME;
const env = { ...process.env, SHELL: '/usr/bin/false', WISP_HOME: there, ...(target.startsWith('locked') && { HOME: lockedHome }) };
const child = spawn('sh', ['-c', command], { stdio: ['pipe', 'inherit', 'inherit'], env, cwd: os.homedir() }); // sshd starts in $HOME
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
const bye = (code) => {
  relay?.close();
  process.exit(code ?? 1);
};
child.on('exit', bye);
process.on('SIGTERM', () => (child.kill('SIGTERM'), bye(0)));
