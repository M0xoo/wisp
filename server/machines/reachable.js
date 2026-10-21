// Can other devices reach this computer over SSH? What Settings → Machines → This computer shows:
// the SSH server, Tailscale, authorized keys and the address to connect with. Pure reads: it only
// knocks on its own SSH port and asks the local tailscale CLI.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from '../proc.js';

const TAILSCALE_BINS = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

// An SSH server says `SSH-2.0-…` first; anything else on the port isn't one.
export function sshBanner({ host = '127.0.0.1', port = 22, timeout = 1_500 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let buf = '';
    const done = (v) => (sock.destroy(), resolve(v));
    sock.setTimeout(timeout, () => done(null));
    sock.on('error', () => done(null));
    sock.on('data', (d) => {
      buf += d;
      if (buf.includes('\n') || buf.length > 255) done(/^SSH-/.test(buf) ? buf.split(/\r?\n/)[0].trim() : null);
    });
  });
}

function run(bin, args, timeout) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 8 << 20 }, (err, stdout) => resolve(err ? { err } : { out: stdout }));
  });
}

// This computer on the tailnet: { installed, running, name, ip, ssh } (ssh: Tailscale SSH is on).
export async function tailscaleSelf({ bin = process.env.WISP_TAILSCALE, timeout = 3_000 } = {}) {
  for (const b of bin ? [bin] : TAILSCALE_BINS) {
    const st = await run(b, ['status', '--json'], timeout);
    if (st.err?.code === 'ENOENT') continue;
    let j = null;
    try {
      j = JSON.parse(st.out || st.err?.stdout || '');
    } catch {}
    if (!j) return { installed: true, running: false };
    const self = j.Self || {};
    const prefs = await run(b, ['debug', 'prefs'], timeout);
    let ssh = null;
    try {
      ssh = !!JSON.parse(prefs.out).RunSSH;
    } catch {}
    return {
      installed: true,
      running: j.BackendState === 'Running',
      name: String(self.DNSName || '').replace(/\.$/, ''),
      ip: self.TailscaleIPs?.find((x) => !x.includes(':')) || '',
      ssh,
    };
  }
  return { installed: false, running: false };
}

// Keys in ~/.ssh/authorized_keys (comments and blank lines aside).
export function authorizedKeys(home = os.homedir()) {
  try {
    return fs
      .readFileSync(path.join(home, '.ssh', 'authorized_keys'), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith('#')).length;
  } catch {
    return 0;
  }
}

export async function reachable({ sshPort = 22, home = os.homedir(), tailscale } = {}) {
  const [banner, ts] = await Promise.all([sshBanner({ port: sshPort }), tailscaleSelf(tailscale)]);
  const user = os.userInfo().username;
  const host = ts.running && ts.name ? ts.name : os.hostname();
  return {
    os: process.platform,
    user,
    hostname: os.hostname(),
    ssh: { running: !!banner, banner: banner || '', port: sshPort },
    tailscale: ts,
    keys: authorizedKeys(home),
    node: process.versions.node,
    // How another device would connect: the tailnet name when there is one.
    target: `${user}@${host}`,
    // Machines run wisp's bootstrap script with `sh`: Windows needs WSL for that.
    supported: process.platform !== 'win32',
  };
}
