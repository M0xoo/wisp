// Can other devices reach this computer over SSH? What Settings → Machines → This computer shows:
// the SSH server, Tailscale, authorized keys and the address to connect with. Pure reads: it only
// knocks on its own SSH port and asks the local tailscale CLI. (v1 server/machines/reachable.js)

import { readFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ProcService } from '@wisp/kernel';
import { tailscaleStatus, type TailscaleOpts } from './ssh/hosts.ts';

/** An SSH server says `SSH-2.0-…` first; anything else on the port isn't one. A client socket, no server. */
export function sshBanner({ host = '127.0.0.1', port = 22, timeoutMs = 1_500 } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let buf = '';
    const done = (v: string | null): void => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => done(null));
    sock.on('error', () => done(null));
    sock.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      if (buf.includes('\n') || buf.length > 255) done(/^SSH-/.test(buf) ? (buf.split(/\r?\n/)[0] ?? '').trim() : null);
    });
  });
}

export interface TailscaleSelf {
  installed: boolean;
  running: boolean;
  name?: string;
  ip?: string;
  /** Tailscale SSH is on */
  ssh?: boolean | null;
}

const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});

/** This computer on the tailnet. */
export async function tailscaleSelf(proc: ProcService, o: TailscaleOpts = {}): Promise<TailscaleSelf> {
  const st = await tailscaleStatus(proc, o);
  if (!st.installed) return { installed: false, running: false };
  if (st.json === null || st.bin === undefined) return { installed: true, running: false };
  const j = rec(st.json);
  const self = rec(j['Self']);
  const prefs = await proc.exec(st.bin, ['debug', 'prefs'], { timeoutMs: o.timeoutMs ?? 3_000 }).catch(() => null);
  let ssh: boolean | null = null;
  try {
    ssh = prefs ? rec(JSON.parse(prefs.stdout))['RunSSH'] === true : null;
  } catch {
    ssh = null;
  }
  const ips = Array.isArray(self['TailscaleIPs']) ? self['TailscaleIPs'].filter((x): x is string => typeof x === 'string') : [];
  return {
    installed: true,
    running: j['BackendState'] === 'Running',
    name: String(self['DNSName'] ?? '').replace(/\.$/, ''),
    ip: ips.find((x) => !x.includes(':')) ?? '',
    ssh,
  };
}

/** Keys in ~/.ssh/authorized_keys (comments and blank lines aside). */
export async function authorizedKeys(home = os.homedir()): Promise<number> {
  const text = await readFile(path.join(home, '.ssh', 'authorized_keys'), 'utf8').catch(() => '');
  return text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).length;
}

export interface Reachability {
  os: string;
  user: string;
  hostname: string;
  ssh: { running: boolean; banner: string; port: number };
  tailscale: TailscaleSelf;
  keys: number;
  node: string;
  target: string;
  supported: boolean;
}

export async function reachable(proc: ProcService, { sshPort = 22, home = os.homedir(), tailscale = {} as TailscaleOpts } = {}): Promise<Reachability> {
  const [banner, ts, keys] = await Promise.all([sshBanner({ port: sshPort }), tailscaleSelf(proc, tailscale), authorizedKeys(home)]);
  const user = os.userInfo().username;
  const host = ts.running && ts.name ? ts.name : os.hostname();
  return {
    os: process.platform,
    user,
    hostname: os.hostname(),
    ssh: { running: banner !== null, banner: banner ?? '', port: sshPort },
    tailscale: ts,
    keys,
    node: process.versions.node,
    // How another device would connect: the tailnet name when there is one.
    target: `${user}@${host}`,
    // Machines run wisp's bootstrap script with `sh`: Windows needs WSL for that.
    supported: process.platform !== 'win32',
  };
}
