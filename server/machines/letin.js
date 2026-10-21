// "Let me in": the first time, a machine doesn't know this computer's SSH key. Instead of sending
// people to a terminal for ssh-copy-id, they type their password on that machine once and wisp
// adds this computer's key there (making one first if there is none). The password goes to ssh
// through SSH_ASKPASS for that one call and is never stored.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from '../proc.js';
import { shq } from '../shq.js';

const KEYS = ['id_ed25519', 'id_ecdsa', 'id_rsa'];
const sshDir = () => process.env.WISP_SSH_DIR || path.join(os.homedir(), '.ssh');

function run(bin, args, { input, env, timeout = 0 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let out = '';
    const timer = timeout && setTimeout(() => (child.kill('SIGKILL'), resolve({ code: -2, out: 'timed out' })), timeout);
    child.on('close', () => clearTimeout(timer));
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
    child.on('error', (err) => resolve({ code: -1, out: err.message }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

// This computer's public key: the usual one, or a new ed25519 key with no passphrase.
export async function publicKey({ dir = sshDir(), keygen = 'ssh-keygen' } = {}) {
  for (const k of KEYS) {
    const f = path.join(dir, `${k}.pub`);
    if (fs.existsSync(f)) return { file: f, key: fs.readFileSync(f, 'utf8').trim(), made: false };
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'id_ed25519');
  const r = await run(keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', `wisp@${os.hostname()}`, '-f', file]);
  if (r.code !== 0 || !fs.existsSync(`${file}.pub`)) throw new Error(`Couldn’t make an SSH key on this computer: ${r.out.trim() || 'ssh-keygen failed'}`);
  return { file: `${file}.pub`, key: fs.readFileSync(`${file}.pub`, 'utf8').trim(), made: true };
}

// Adds the key on stdin to ~/.ssh/authorized_keys there, once. Runs under sh whatever the login shell is.
export const ADD_KEY = `sh -c ${shq('umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && read -r k && { grep -qxF "$k" ~/.ssh/authorized_keys || printf "%s\\n" "$k" >> ~/.ssh/authorized_keys; }')}`;

export async function letIn({ target, password, ssh = 'ssh', dir } = {}) {
  if (!password) throw Object.assign(new Error('Type your password on that computer.'), { status: 400 });
  const { key, made } = await publicKey({ dir });
  // ssh reads the password from SSH_ASKPASS; the script prints it from the environment, so it
  // never touches the disk. SSH_ASKPASS_REQUIRE=force: even when wisp has a terminal.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-askpass-'));
  const win = process.platform === 'win32';
  const askpass = path.join(tmp, win ? 'askpass.cmd' : 'askpass.sh');
  fs.writeFileSync(askpass, win ? '@echo off\r\necho %WISP_ASKPASS%\r\n' : '#!/bin/sh\nprintf "%s\\n" "$WISP_ASKPASS"\n', { mode: 0o700 });
  try {
    const base = ['-T', '-o', 'BatchMode=no', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=1', '-o', 'ConnectTimeout=15'];
    const env = { SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || ':0', WISP_ASKPASS: password };
    // One method per try: after a wrong password some servers (macOS) fall through to
    // keyboard-interactive and wait forever. That one only when the server offers nothing else.
    const attempt = (method) => run(ssh, [...base, '-o', `PreferredAuthentications=${method}`, target, ADD_KEY], { input: `${key}\n`, env, timeout: 40_000 });
    let r = await attempt('password');
    const offered = () => /Permission denied \(([^)]*)\)/i.exec(r.out)?.[1] || '';
    if (r.code !== 0 && /keyboard-interactive/.test(offered()) && !/password/.test(offered())) r = await attempt('keyboard-interactive');
    if (r.code === -2) throw Object.assign(new Error('That computer didn’t answer in time. Check the password and the address, then try again.'), { status: 504 });
    if (r.code === 0) return { ok: true, madeKey: made };
    if (/Permission denied|Authentication failed|Too many authentication failures/i.test(r.out)) {
      // "Permission denied (publickey)." lists what the server accepts: no password in it, no point retrying.
      const passwordsOff = !!offered() && !/password|keyboard-interactive/i.test(offered());
      throw Object.assign(
        new Error(passwordsOff ? 'That computer doesn’t accept passwords over SSH (common on cloud servers). Add this computer’s key there by hand.' : 'Wrong password. Use the one you sign in to that computer with.'),
        { status: 400, passwordsOff },
      );
    }
    throw Object.assign(new Error(r.out.trim().split('\n').filter(Boolean).at(-1) || `ssh exited (${r.code}).`), { status: 502 });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
