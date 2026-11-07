// "Let me in": the first time, a machine doesn't know this computer's SSH key. Instead of sending
// people to a terminal for ssh-copy-id, they type their password on that machine once and wisp adds
// this computer's key there (making one first if there is none). The password goes to ssh through
// SSH_ASKPASS for that one call and is never stored. (v1 server/machines/letin.js)

import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProcService } from '@wisp/kernel';
import { PeerHttpError } from '@wisp-plugin/machines-api';
import { shq } from '../shq.js';

const KEYS = ['id_ed25519', 'id_ecdsa', 'id_rsa'];

const exists = (f: string): Promise<boolean> =>
  access(f).then(
    () => true,
    () => false,
  );

const out = (r: { stdout: string; stderr: string }): string => `${r.stdout}${r.stderr}`;

/** This computer's public key: the usual one, or a new ed25519 key with no passphrase. */
export async function publicKey(proc: ProcService, { dir, keygen = 'ssh-keygen' }: { dir: string; keygen?: string }): Promise<{ file: string; key: string; made: boolean }> {
  for (const k of KEYS) {
    const f = path.join(dir, `${k}.pub`);
    if (await exists(f)) return { file: f, key: (await readFile(f, 'utf8')).trim(), made: false };
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'id_ed25519');
  const r = await proc.exec(keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', `wisp@${os.hostname()}`, '-f', file]).catch((e: unknown) => ({ code: -1, stdout: '', stderr: e instanceof Error ? e.message : String(e), timedOut: false }));
  if (r.code !== 0 || !(await exists(`${file}.pub`))) throw new PeerHttpError(`Couldn’t make an SSH key on this computer: ${out(r).trim() || 'ssh-keygen failed'}`, 500);
  return { file: `${file}.pub`, key: (await readFile(`${file}.pub`, 'utf8')).trim(), made: true };
}

/** Adds the key on stdin to ~/.ssh/authorized_keys there, once. Runs under sh whatever the login shell is. */
export const ADD_KEY = `sh -c ${shq('umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && read -r k && { grep -qxF "$k" ~/.ssh/authorized_keys || printf "%s\\n" "$k" >> ~/.ssh/authorized_keys; }')}`;

export interface LetInOptions {
  target: string;
  password: string;
  ssh: string;
  /** this computer's ~/.ssh */
  dir: string;
  /** the environment ssh runs with (DISPLAY is kept from it) */
  env?: Record<string, string | undefined>;
}

export async function letIn(proc: ProcService, o: LetInOptions): Promise<{ ok: true; madeKey: boolean }> {
  if (!o.password) throw new PeerHttpError('Type your password on that computer.', 400);
  const { key, made } = await publicKey(proc, { dir: o.dir });
  // ssh reads the password from SSH_ASKPASS; the script prints it from the environment, so it never
  // touches the disk. SSH_ASKPASS_REQUIRE=force: even when wisp has a terminal.
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wisp-askpass-'));
  const win = process.platform === 'win32';
  const askpass = path.join(tmp, win ? 'askpass.cmd' : 'askpass.sh');
  await writeFile(askpass, win ? '@echo off\r\necho %WISP_ASKPASS%\r\n' : '#!/bin/sh\nprintf "%s\\n" "$WISP_ASKPASS"\n', { mode: 0o700 });
  try {
    return await tryPassword(proc, o, askpass, key, made);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function tryPassword(proc: ProcService, o: LetInOptions, askpass: string, key: string, made: boolean): Promise<{ ok: true; madeKey: boolean }> {
  const base = ['-T', '-o', 'BatchMode=no', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=1', '-o', 'ConnectTimeout=15'];
  const env = { ...o.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: o.env?.['DISPLAY'] ?? ':0', WISP_ASKPASS: o.password };
  // One method per try: after a wrong password some servers (macOS) fall through to
  // keyboard-interactive and wait forever. That one only when the server offers nothing else.
  const attempt = async (method: string): Promise<{ code: number; text: string }> => {
    const r = await proc.exec(o.ssh, [...base, '-o', `PreferredAuthentications=${method}`, o.target, ADD_KEY], { input: `${key}\n`, env, timeoutMs: 40_000 }).catch((e: unknown) => ({ code: -1, stdout: '', stderr: e instanceof Error ? e.message : String(e), timedOut: false }));
    return { code: r.timedOut ? -2 : (r.code ?? -1), text: out(r) };
  };
  let r = await attempt('password');
  const offered = (): string => /Permission denied \(([^)]*)\)/i.exec(r.text)?.[1] ?? '';
  if (r.code !== 0 && /keyboard-interactive/.test(offered()) && !/password/.test(offered())) r = await attempt('keyboard-interactive');
  if (r.code === -2) throw new PeerHttpError('That computer didn’t answer in time. Check the password and the address, then try again.', 504);
  if (r.code === 0) return { ok: true, madeKey: made };
  if (/Permission denied|Authentication failed|Too many authentication failures/i.test(r.text)) {
    // "Permission denied (publickey)." lists what the server accepts: no password in it, no point retrying.
    const passwordsOff = !!offered() && !/password|keyboard-interactive/i.test(offered());
    throw new PeerHttpError(passwordsOff ? 'That computer doesn’t accept passwords over SSH (common on cloud servers). Add this computer’s key there by hand.' : 'Wrong password. Use the one you sign in to that computer with.', 400);
  }
  throw new PeerHttpError(r.text.trim().split('\n').filter(Boolean).at(-1) ?? `ssh exited (${r.code}).`, 502);
}
