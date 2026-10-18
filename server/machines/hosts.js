// Hosts this computer already knows how to reach (~/.ssh/config, known_hosts, Tailscale), and
// what a failed `ssh` most likely needs. Pure reads: nothing here connects anywhere.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from '../proc.js';

// user@host, host, host:port-less alias, [v6]. Never an option: `-oProxyCommand=…` would run code.
export const TARGET = /^(?!-)[\w.%+-]+(@[\w.%:[\]-]+)?$/;

// What a failed `ssh` most likely needs, from its stderr.
export function sshHint(stderr, target) {
  const e = String(stderr || '');
  if (/Permission denied|Too many authentication failures|publickey/i.test(e))
    return { text: 'SSH asked for a password or a key wisp can’t use. wisp signs in with keys only: copy yours over once, or load it into ssh-agent.', command: `ssh-copy-id ${target}` };
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(e)) return { text: 'The machine’s host key changed since you last connected. Check it in a terminal before trusting it again.', command: `ssh ${target}` };
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(e)) return { text: 'That name doesn’t resolve. Use user@host, an IP address, or a Host from ~/.ssh/config.' };
  if (/Connection refused/i.test(e)) return { text: 'Nothing accepts SSH there. Turn on its SSH server (Remote Login on macOS, sshd on Linux).' };
  if (/timed out|No route to host|Network is unreachable|Connection closed|Broken pipe/i.test(e)) return { text: 'Can’t reach that machine right now. Check the network or VPN.' };
  if (/Address already in use|forwarding failed/i.test(e)) return { text: 'The local end of the tunnel was taken. Connect again to pick another port.' };
  return null;
}

// Hosts from ~/.ssh/config (and the files it Includes), for the "SSH host" suggestions.
export function sshHosts(file = path.join(os.homedir(), '.ssh', 'config'), seen = new Set()) {
  if (seen.has(file) || seen.size > 20) return [];
  seen.add(file);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const hosts = [];
  let current = []; // one Host line may name several hosts; what follows applies to each
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const [key, ...rest] = line.split(/\s+/);
    const value = rest.join(' ');
    if (/^include$/i.test(key)) {
      for (const pat of value.split(/\s+/)) {
        const abs = path.resolve(path.join(os.homedir(), '.ssh'), pat.replace(/^~(?=\/)/, os.homedir()));
        const dir = path.dirname(abs);
        const re = new RegExp(`^${path.basename(abs).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
        let names = [];
        try {
          names = fs.readdirSync(dir).filter((n) => re.test(n));
        } catch {}
        for (const n of names) hosts.push(...sshHosts(path.join(dir, n), seen));
      }
    } else if (/^host$/i.test(key)) {
      current = value
        .split(/\s+/)
        .filter((h) => h && !/[*?!]/.test(h))
        .map((host) => ({ host, hostname: '', user: '' }));
      hosts.push(...current);
    } else if (/^hostname$/i.test(key)) for (const h of current) h.hostname = value;
    else if (/^user$/i.test(key)) for (const h of current) h.user = value;
  }
  const uniq = new Map(hosts.map((h) => [h.host, h]));
  return [...uniq.values()];
}

// Code hosts you push to, not computers to run agents on.
const FORGE = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com|heroku\.com|codeberg\.org|sr\.ht)$/i;

// Hosts you've already SSHed to, from ~/.ssh/known_hosts. Hashed entries and ones on a
// non-default port ([host]:2222, which a bare target can't express) are skipped.
export function knownHosts(file = path.join(os.homedir(), '.ssh', 'known_hosts')) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('@') || line.startsWith('|')) continue;
    const names = line.split(/\s+/)[0].split(',').filter((n) => n && !n.startsWith('[') && !/[*?!]/.test(n));
    // "devbox,10.0.0.5": the name, with the address as a detail.
    const host = names.find((n) => !/^[\d.]+$|:/.test(n)) || names[0];
    if (!host || FORGE.test(host) || /^(localhost|127\.|::1$)/.test(host) || !TARGET.test(host)) continue;
    if (!out.has(host)) out.set(host, { host, hostname: names.find((n) => n !== host) || '' });
  }
  return [...out.values()];
}

const TAILSCALE_BINS = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

// Peers on your tailnet, from `tailscale status --json`. Phones and tablets don't run agents.
export function tailscalePeers({ bin = process.env.WISP_TAILSCALE, timeout = 3_000 } = {}) {
  const bins = bin ? [bin] : TAILSCALE_BINS;
  const run = (i) =>
    new Promise((resolve) => {
      if (i >= bins.length) return resolve([]);
      execFile(bins[i], ['status', '--json'], { timeout, maxBuffer: 8 << 20 }, (err, stdout) => {
        if (err) return resolve(err.code === 'ENOENT' ? run(i + 1) : []);
        try {
          const peers = Object.values(JSON.parse(stdout).Peer || {});
          resolve(
            peers
              .filter((p) => !/^(ios|android|tvos)$/i.test(p.OS || ''))
              .map((p) => ({ host: (p.DNSName || '').replace(/\.$/, '') || p.TailscaleIPs?.[0] || '', name: p.HostName || '', os: p.OS || '', online: !!p.Online }))
              .filter((p) => p.host && TARGET.test(p.host)),
          );
        } catch {
          resolve([]);
        }
      });
    });
  return run(0);
}

// Every host this computer already knows how to reach, for "Found on this computer" in Machines.
// One entry per target: ~/.ssh/config first (your own names), then the tailnet, then known_hosts.
export async function discoverHosts({ sshDir = path.join(os.homedir(), '.ssh'), tailscale } = {}) {
  const out = new Map();
  const put = (x) => {
    if (x.target && !out.has(x.target)) out.set(x.target, x);
  };
  for (const h of sshHosts(path.join(sshDir, 'config'))) put({ target: h.host, name: h.host, source: 'ssh-config', detail: [h.user, h.hostname].filter(Boolean).join('@') });
  for (const p of await tailscalePeers(tailscale)) put({ target: p.host, name: p.name || p.host.split('.')[0], source: 'tailscale', detail: [p.os, p.online ? 'online' : 'offline'].filter(Boolean).join(' · '), online: p.online });
  for (const h of knownHosts(path.join(sshDir, 'known_hosts'))) put({ target: h.host, name: /^[\d.]+$/.test(h.host) ? h.host : h.host.split('.')[0], source: 'known-hosts', detail: h.hostname });
  return [...out.values()].sort((a, b) => (b.online === false ? 0 : 1) - (a.online === false ? 0 : 1));
}
