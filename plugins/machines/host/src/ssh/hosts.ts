// Hosts this computer already knows how to reach (~/.ssh/config, known_hosts, Tailscale), and what a
// failed `ssh` most likely needs. Pure reads: nothing here connects anywhere. (v1 server/machines/hosts.js)

import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProcService } from '@wisp/kernel';
import type { Hint } from '@wisp-plugin/machines-api';

// user@host, host, host:port-less alias, [v6]. Never an option: `-oProxyCommand=…` would run code.
export const TARGET = /^(?!-)[\w.%+-]+(@[\w.%:[\]-]+)?$/;

/** What a failed `ssh` most likely needs, from its stderr. letIn: the page offers the password box. */
export function sshHint(stderr: string, target: string): Hint | null {
  const e = String(stderr || '');
  const host = String(target).replace(/^.*@/, '');
  if (/Permission denied|Too many authentication failures|publickey/i.test(e))
    return { title: 'This computer isn’t allowed in yet', text: `${host} doesn’t know this computer yet. Type your password on ${host} once and wisp sets up a key there, so it won’t ask again.`, command: `ssh-copy-id ${target}`, letIn: true };
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(e)) return { title: 'It looks different from last time', text: `${host} looks different from last time (its SSH identity changed). If you reinstalled it, that’s expected: check it once in a terminal, then connect again.`, command: `ssh ${target}` };
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(e)) return { title: 'Computer not found', text: `wisp can’t find a computer called ${host}. Check the spelling, or use its IP address. Not on the same network? Put both computers on Tailscale and use its Tailscale name.`, tailscale: true };
  if (/Connection refused/i.test(e)) return { title: 'SSH is off there', text: `${host} answered, but SSH is off there. On a Mac: System Settings → General → Sharing → Remote Login. On Linux: install openssh-server. Then connect again.` };
  if (/timed out|No route to host|Network is unreachable|Connection closed|Broken pipe/i.test(e)) return { title: 'No answer', text: `${host} doesn’t answer. Is it on and awake, and on the same network as this computer? From anywhere else, put both on Tailscale.`, tailscale: true };
  if (/Address already in use|forwarding failed/i.test(e)) return { text: 'The local end of the tunnel was taken. Connect again to pick another port.' };
  return null;
}

export interface SshHost {
  host: string;
  hostname: string;
  user: string;
}

const readText = (file: string): Promise<string | null> => readFile(file, 'utf8').catch(() => null);

/** Hosts from ~/.ssh/config (and the files it Includes), for the "SSH host" suggestions. */
export async function sshHosts(file = path.join(os.homedir(), '.ssh', 'config'), seen = new Set<string>()): Promise<SshHost[]> {
  if (seen.has(file) || seen.size > 20) return [];
  seen.add(file);
  const text = await readText(file);
  if (text === null) return [];
  const hosts: SshHost[] = [];
  let current: SshHost[] = []; // one Host line may name several hosts; what follows applies to each
  for (const raw of text.split(/\r?\n/)) {
    const [key = '', ...rest] = raw.trim().split(/\s+/);
    const value = rest.join(' ');
    if (/^include$/i.test(key)) {
      for (const pat of value.split(/\s+/)) hosts.push(...(await included(pat, seen)));
    } else if (/^host$/i.test(key)) {
      current = value
        .split(/\s+/)
        .filter((h) => h && !/[*?!]/.test(h))
        .map((host) => ({ host, hostname: '', user: '' }));
      hosts.push(...current);
    } else if (/^hostname$/i.test(key)) for (const h of current) h.hostname = value;
    else if (/^user$/i.test(key)) for (const h of current) h.user = value;
  }
  return [...new Map(hosts.map((h) => [h.host, h])).values()];
}

// Include paths resolve under ~/.ssh (as ssh does), with * and ? in the file name.
async function included(pat: string, seen: Set<string>): Promise<SshHost[]> {
  const abs = path.resolve(path.join(os.homedir(), '.ssh'), pat.replace(/^~(?=\/)/, os.homedir()));
  const dir = path.dirname(abs);
  const re = new RegExp(`^${path.basename(abs).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: SshHost[] = [];
  for (const n of names.filter((x) => re.test(x))) out.push(...(await sshHosts(path.join(dir, n), seen)));
  return out;
}

// Code hosts you push to, not computers to run agents on.
const FORGE = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com|heroku\.com|codeberg\.org|sr\.ht)$/i;

/** Hosts you've SSHed to, from known_hosts. Hashed entries and [host]:port ones are skipped. */
export async function knownHosts(file = path.join(os.homedir(), '.ssh', 'known_hosts')): Promise<{ host: string; hostname: string }[]> {
  const text = await readText(file);
  if (text === null) return [];
  const out = new Map<string, { host: string; hostname: string }>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('@') || line.startsWith('|')) continue;
    const names = (line.split(/\s+/)[0] ?? '').split(',').filter((n) => n && !n.startsWith('[') && !/[*?!]/.test(n));
    // "devbox,10.0.0.5": the name, with the address as a detail.
    const host = names.find((n) => !/^[\d.]+$|:/.test(n)) ?? names[0];
    if (!host || FORGE.test(host) || /^(localhost|127\.|::1$)/.test(host) || !TARGET.test(host)) continue;
    if (!out.has(host)) out.set(host, { host, hostname: names.find((n) => n !== host) ?? '' });
  }
  return [...out.values()];
}

export const TAILSCALE_BINS = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

export interface TailscaleOpts {
  bin?: string;
  timeoutMs?: number;
}

/** `tailscale status --json` from the first binary that exists: its parsed output, or null. */
export async function tailscaleStatus(proc: ProcService, o: TailscaleOpts = {}): Promise<{ installed: boolean; json: unknown; bin?: string }> {
  for (const bin of o.bin ? [o.bin] : TAILSCALE_BINS) {
    const r = await proc.exec(bin, ['status', '--json'], { timeoutMs: o.timeoutMs ?? 3_000, maxBuffer: 8 << 20 }).catch((e: unknown) => ({ missing: isMissing(e) }));
    if ('missing' in r) {
      if (r.missing) continue;
      return { installed: true, json: null, bin };
    }
    try {
      return { installed: true, json: JSON.parse(r.stdout) as unknown, bin };
    } catch {
      return { installed: true, json: null, bin };
    }
  }
  return { installed: false, json: null };
}

const isMissing = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT';
const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Peers on your tailnet. Phones and tablets don't run agents. */
export async function tailscalePeers(proc: ProcService, o: TailscaleOpts = {}): Promise<{ host: string; name: string; os: string; online: boolean }[]> {
  const st = await tailscaleStatus(proc, o);
  const peers = Object.values(rec(rec(st.json)['Peer'])).map(rec);
  return peers
    .filter((p) => !/^(ios|android|tvos)$/i.test(str(p['OS'])))
    .map((p) => {
      const ips = Array.isArray(p['TailscaleIPs']) ? p['TailscaleIPs'].map(str) : [];
      return { host: str(p['DNSName']).replace(/\.$/, '') || ips[0] || '', name: str(p['HostName']), os: str(p['OS']), online: p['Online'] === true };
    })
    .filter((p) => p.host && TARGET.test(p.host));
}

export interface FoundHost {
  target: string;
  name: string;
  source: 'ssh-config' | 'tailscale' | 'known-hosts';
  detail: string;
  online?: boolean;
}

/** Every host this computer knows how to reach, one entry per target: ssh config, tailnet, known_hosts. */
export async function discoverHosts(proc: ProcService, o: { sshDir?: string; tailscale?: TailscaleOpts } = {}): Promise<FoundHost[]> {
  const sshDir = o.sshDir ?? path.join(os.homedir(), '.ssh');
  const [config, peers, known] = await Promise.all([sshHosts(path.join(sshDir, 'config')), tailscalePeers(proc, o.tailscale), knownHosts(path.join(sshDir, 'known_hosts'))]);
  const out = new Map<string, FoundHost>();
  const put = (x: FoundHost): void => {
    if (x.target && !out.has(x.target)) out.set(x.target, x);
  };
  for (const h of config) put({ target: h.host, name: h.host, source: 'ssh-config', detail: [h.user, h.hostname].filter(Boolean).join('@') });
  for (const p of peers) put({ target: p.host, name: p.name || (p.host.split('.')[0] ?? p.host), source: 'tailscale', detail: [p.os, p.online ? 'online' : 'offline'].filter(Boolean).join(' · '), online: p.online });
  for (const h of known) put({ target: h.host, name: /^[\d.]+$/.test(h.host) ? h.host : (h.host.split('.')[0] ?? h.host), source: 'known-hosts', detail: h.hostname });
  // offline tailnet peers last; the sort is stable, so each source keeps its order
  return [...out.values()].sort((a, b) => (b.online === false ? 0 : 1) - (a.online === false ? 0 : 1));
}
