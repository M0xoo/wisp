// Machines: run agents on your other computers over SSH. wisp starts itself on the machine (or
// uses the one already running there), reaches it through an SSH tunnel and shows its sessions
// here, so worktrees, diffs, rollback, ask_user and Ship it work over there unchanged.
//
//   connect   one `ssh -L <free port>:127.0.0.1:<port> <host> sh -s` per machine. The script on
//             stdin finds Node, starts `npx -y wisp-agents@<this version>` detached if nothing
//             answers on <port>, reports each step as an `@@wisp …` line, then holds the session.
//   requests  go to the forwarded local port with the Host header the remote server insists on.
//   sessions  are <id>@<machine> here. Summaries, sessions and events are rewritten on the way.
//
// Nothing new listens on the network: the remote wisp stays on its own loopback, and it keeps
// running (agents too) when this computer sleeps. Auth is whatever your SSH setup does.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import { spawn, execFile, killTree } from './proc.js';
import { newer } from './update.js';

export const DEFAULT_PORT = 4477;
const READY_TIMEOUT_MS = 6 * 60_000; // the first `npx` download can take a while
const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
const LIST_TIMEOUT_MS = 5_000;
const MAX_LOG = 80;
export const STEPS = [
  ['ssh', 'Connect over SSH'],
  ['node', 'Find Node.js 20+'],
  ['wisp', 'Start wisp there'],
  ['tunnel', 'Open the tunnel'],
  ['agents', 'Find harnesses'],
];

const sshBin = () => process.env.WISP_SSH || 'ssh';
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Session ids: <remote id>@<machine id> here. Local ids never contain '@'.
export const qualify = (id, mid) => (id ? `${id}@${mid}` : id);
export function splitId(id) {
  const i = String(id || '').lastIndexOf('@');
  return i > 0 ? { id: id.slice(0, i), machine: id.slice(i + 1) } : null;
}

// The version an older wisp on the machine would become on Restart wisp there: this one, unless a
// custom start command decides what runs there.
export const updateTo = (local, remote, command) => (!command && remote && newer(local, remote) ? local : null);

// What runs on the machine. Sent on stdin, so the login shell there (bash, zsh, fish…) only ever
// sees `sh -s`. Steps come back as `@@wisp step <id> <run|done> <detail>`, `@@wisp fail <id>
// <message>`, and finally `@@wisp ready <version> <pid>`; then `cat` holds the session (and the
// tunnel) open until this side lets go.
export function bootstrapScript({ port, command, apiVersion }) {
  return String.raw`say() { printf '@@wisp %s\n' "$*"; }
PORT=__PORT__
API=__API__
CMD=__CMD__
cd "$HOME" 2>/dev/null # npx would resolve wisp-agents from a package.json in the current folder
say step ssh done "$(uname -sn 2>/dev/null)"
# A non-interactive SSH shell skips the profile that puts node (Homebrew, nvm, Volta…) on PATH.
SH=$SHELL; [ -n "$SH" ] || SH=/bin/sh
LP=$("$SH" -lc 'printf "%s" "$PATH"' </dev/null 2>/dev/null) && [ -n "$LP" ] && PATH="$LP:$PATH"
NVM_BIN=
for d in "$HOME"/.nvm/versions/node/*/bin; do [ -x "$d/node" ] && NVM_BIN=$d; done
[ -n "$NVM_BIN" ] && PATH="$NVM_BIN:$PATH"
PATH="$PATH:$HOME/.local/bin:$HOME/.volta/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin"
export PATH
if ! command -v node >/dev/null 2>&1; then say fail node "Node.js isn't installed there (or isn't on PATH)."; exit 0; fi
NV=$(node -v 2>/dev/null)
if ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>/dev/null; then say fail node "Node $NV is too old: wisp needs 20 or newer."; exit 0; fi
say step node done "$NV"
health() { node -e 'fetch("http://127.0.0.1:" + process.argv[1] + "/api/health", { signal: AbortSignal.timeout(2500) }).then((r) => r.json().catch(() => ({ name: "other" }))).then((j) => console.log([j.name, j.version, j.apiVersion, j.pid].join(" ")), () => process.exit(1))' "$PORT" 2>/dev/null; }
H=$(health)
if [ -n "$H" ]; then
  set -- $H
  if [ "$1" != wisp ]; then say fail wisp "Port $PORT is used by another program there. Pick another port under Advanced."; exit 0; fi
  if [ "$3" != "$API" ]; then say stale "$4"; say fail wisp "wisp $2 is already running there and speaks an older API. Restart it to update."; exit 0; fi
  say step wisp done "already running · $2"
else
  LOG=$WISP_HOME; [ -n "$LOG" ] || LOG=$HOME/.wisp
  mkdir -p "$LOG"; LOG=$LOG/machine.log
  say step wisp run "starting $CMD"
  npm_config_omit=optional nohup sh -c "exec $CMD --no-open --port $PORT" >"$LOG" 2>&1 </dev/null &
  PID=$!
  i=0
  until H=$(health) && [ -n "$H" ]; do
    if ! kill -0 "$PID" 2>/dev/null; then say fail wisp "wisp stopped while starting: $(tail -n 4 "$LOG" | tr '\n' ' ')"; exit 0; fi
    i=$((i+1)); if [ "$i" -ge 330 ]; then say fail wisp "wisp didn't answer within 5 minutes: $(tail -n 4 "$LOG" | tr '\n' ' ')"; exit 0; fi
    sleep 1
  done
  set -- $H
  say step wisp done "started · $2"
fi
say ready "$2" "$4"
exec cat >/dev/null
`
    .replace('__PORT__', String(port))
    .replace('__API__', String(apiVersion))
    .replace('__CMD__', shq(command));
}

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

// What the UI needs of a machine's harness list.
const remoteAgent = ({ id, name, available, version, models, efforts, delegates }) => ({ id, name, available, version, models, efforts, delegates });

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

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer().once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const readAll = (res) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });

// user@host, host, host:port-less alias, [v6]. Never an option: `-oProxyCommand=…` would run code.
const TARGET = /^(?!-)[\w.%+-]+(@[\w.%:[\]-]+)?$/;

export class Machines extends EventEmitter {
  // onEvent(event, data): a session event from a machine, ids already rewritten.
  constructor({ store, version, apiVersion, onEvent = () => {}, onChange = () => {} }) {
    super();
    Object.assign(this, { store, version, apiVersion, onEvent, onChange });
    this.conns = new Map(); // machine id -> connection state
    this.cache = new Map(); // machine id -> Map(remote id -> remote summary): shown while it's offline
  }

  get list() {
    return (this.store.config.machines ||= []);
  }

  get defaultCommand() {
    return `npx -y wisp-agents@${this.version}`;
  }

  get(id) {
    const m = this.list.find((x) => x.id === id);
    if (!m) throw bad('No such machine.', 404);
    return m;
  }

  // The harnesses the machine reported when it came online (Auto routes with these), or null.
  agentsOf(id) {
    return this.conns.get(id)?.remote?.agents || null;
  }

  isOnline(id) {
    return this.conns.get(id)?.state === 'online';
  }

  start() {
    for (const m of this.list) if (m.autoConnect !== false) this.connect(m.id).catch(() => {});
  }

  stop() {
    for (const c of this.conns.values()) this.#hangUp(c);
  }

  // --- config ------------------------------------------------------------------------------

  #clean(body, prev = {}) {
    const v = (k, d) => (body[k] !== undefined ? body[k] : prev[k] !== undefined ? prev[k] : d);
    const target = String(v('target', '')).trim();
    if (!TARGET.test(target)) throw bad('SSH host: user@host, a host name, or a Host from ~/.ssh/config.');
    const port = Number(v('port', DEFAULT_PORT));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad('Port: a number from 1 to 65535.');
    const command = String(v('command', '') || '').trim();
    const name = String(v('name', '') || '').trim().slice(0, 40) || target.replace(/^.*@/, '');
    return { name, target, port, command, autoConnect: v('autoConnect', true) !== false };
  }

  add(body = {}) {
    const m = { id: randomBytes(3).toString('hex'), ...this.#clean(body), addedAt: Date.now() };
    if (this.list.some((x) => x.target === m.target && x.port === m.port)) throw bad(`${m.target} is already added.`, 409);
    this.list.push(m);
    this.store.saveConfig();
    this.onChange();
    return m;
  }

  async update(id, body = {}) {
    const m = this.get(id);
    const next = this.#clean(body, m);
    const reconnect = ['target', 'port', 'command'].some((k) => next[k] !== m[k]) && this.conns.get(id)?.state !== 'off';
    Object.assign(m, next);
    this.store.saveConfig();
    if (reconnect && this.conns.has(id)) {
      this.disconnect(id);
      this.connect(id).catch(() => {});
    }
    this.onChange();
    return m;
  }

  remove(id) {
    this.get(id);
    this.disconnect(id);
    this.conns.delete(id);
    this.cache.delete(id);
    this.store.config.machines = this.list.filter((x) => x.id !== id);
    this.store.config.projects = this.store.config.projects.filter((p) => p.machine !== id);
    this.store.saveConfig();
    this.onChange();
  }

  view() {
    return this.list.map((m) => {
      const c = this.conns.get(m.id);
      const cached = [...(this.cache.get(m.id)?.values() || [])];
      return {
        ...m,
        defaultCommand: this.defaultCommand,
        state: c?.state || 'off',
        steps: c?.steps || [],
        error: c?.error || '',
        hint: c?.hint || null,
        stale: !!c?.stalePid,
        attempt: c?.attempt || 0,
        since: c?.since || null,
        remote: c?.remote || null,
        outdated: updateTo(this.version, c?.remote?.version, m.command),
        log: c?.log.slice(-30) || [],
        projects: this.store.config.projects.filter((p) => p.machine === m.id).length,
        working: cached.filter((s) => s.state === 'running').length,
      };
    });
  }

  // --- the connection ----------------------------------------------------------------------

  #step(c, id, status, detail) {
    const i = c.steps.findIndex((s) => s.id === id);
    if (i < 0) return;
    Object.assign(c.steps[i], { status, ...(detail !== undefined && { detail }) });
    if (status === 'done' && c.steps[i + 1]?.status === 'pending') c.steps[i + 1].status = 'run';
    this.onChange();
  }

  #log(c, line) {
    c.log.push(line);
    if (c.log.length > MAX_LOG) c.log.splice(0, c.log.length - MAX_LOG);
  }

  async connect(id, { retry = false } = {}) {
    const m = this.get(id);
    const prev = this.conns.get(id);
    if (prev?.child || prev?.state === 'online') return this.view().find((x) => x.id === id);
    clearTimeout(prev?.retryTimer);
    const c = {
      id,
      state: retry ? 'reconnecting' : 'connecting',
      steps: STEPS.map(([sid, label], i) => ({ id: sid, label, status: i ? 'pending' : 'run', detail: '' })),
      error: '',
      hint: null,
      log: [],
      stderr: '',
      attempt: retry ? prev?.attempt || 0 : 0,
      wasOnline: retry ? prev?.wasOnline : false,
      remote: prev?.remote || null,
    };
    this.conns.set(id, c);
    this.onChange();
    c.localPort = await freePort();
    const args = [
      ...['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15'],
      ...['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ExitOnForwardFailure=yes'],
      ...['-L', `${c.localPort}:127.0.0.1:${m.port}`, m.target, 'sh -s'],
    ];
    const child = spawn(sshBin(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    c.child = child;
    child.stdin.on('error', () => {});
    child.stdin.write(bootstrapScript({ port: m.port, command: m.command || this.defaultCommand, apiVersion: this.apiVersion }));
    child.stderr.on('data', (d) => {
      c.stderr = (c.stderr + d).slice(-4000);
      for (const l of String(d).split(/\r?\n/)) if (l.trim()) this.#log(c, l);
    });
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.#line(m, c, line));
    c.readyTimer = setTimeout(() => this.#fail(c, 'It took too long to start wisp there.'), READY_TIMEOUT_MS);
    child.on('error', (err) => this.#fail(c, `Could not run ssh: ${err.message}`, { text: 'wisp needs the OpenSSH client (`ssh`) on this computer.' }));
    child.on('close', (code) => this.#closed(m, c, code));
    return this.view().find((x) => x.id === id);
  }

  #line(m, c, line) {
    const hit = /^@@wisp (\w+)\s*(.*)$/.exec(line);
    if (!hit) return line.trim() && this.#log(c, line);
    const [, kind, rest] = hit;
    if (kind === 'step') {
      const [, sid, status, detail = ''] = /^(\w+) (\w+)\s*(.*)$/.exec(rest) || [];
      this.#log(c, `${sid}: ${detail || status}`);
      return this.#step(c, sid, status, detail);
    }
    if (kind === 'stale') return (c.stalePid = Number(rest) || null);
    if (kind === 'fail') {
      const [, sid, msg = ''] = /^(\w+)\s*(.*)$/.exec(rest) || [];
      this.#step(c, sid, 'fail', msg);
      const hint = sid === 'node' ? { text: 'Install Node.js 20 or newer there (nodejs.org, nvm, or the package manager), then connect again.' } : null;
      c.giveUp = true; // retrying won't change the answer
      return this.#fail(c, msg, hint, { keep: true });
    }
    if (kind === 'ready') {
      const [version, pid] = rest.split(' ');
      c.remote = { ...c.remote, version, pid: Number(pid) || null };
      this.#ready(m, c).catch((err) => this.#fail(c, err.message));
    }
  }

  // The script says wisp answers over there; check it through the tunnel, then go live.
  async #ready(m, c) {
    this.#step(c, 'tunnel', 'run');
    let health;
    for (let i = 0; i < 40 && !health; i++) {
      health = await this.#raw(m, c, 'GET', '/health').catch(() => null);
      if (!health) await new Promise((r) => setTimeout(r, 250));
    }
    if (!health) throw new Error('The tunnel opened, but wisp doesn’t answer through it.');
    if (this.conns.get(m.id) !== c) return;
    this.#step(c, 'tunnel', 'done', `localhost:${c.localPort} → ${m.port}`);
    const [agents, config] = await Promise.all([this.#raw(m, c, 'GET', '/agents').catch(() => []), this.#raw(m, c, 'GET', '/config').catch(() => ({}))]);
    const ready = agents.filter((a) => a.available);
    c.remote = { ...c.remote, version: health.version, pid: health.pid, home: config.home || '', agents: agents.map(remoteAgent) };
    this.#step(c, 'agents', ready.length ? 'done' : 'warn', ready.length ? ready.map((a) => a.name).join(', ') : 'None found. Install a harness CLI there (claude, codex, opencode…) and sign in.');
    clearTimeout(c.readyTimer);
    Object.assign(c, { state: 'online', error: '', hint: null, attempt: 0, wasOnline: true, since: Date.now() });
    this.#listen(m, c);
    await this.sessions({}, { only: m.id }).catch(() => {});
    this.onChange();
    this.emit('online', m);
  }

  // Detect harnesses and models again on every online machine (after installing or signing in
  // to something there). A machine that doesn't answer keeps what it had.
  async recheckAgents() {
    const online = this.list.map((m) => [m, this.conns.get(m.id)]).filter(([, c]) => c?.state === 'online');
    await Promise.all(
      online.map(async ([m, c]) => {
        const agents = await this.#raw(m, c, 'GET', '/agents?fresh=1').catch(() => null);
        if (!Array.isArray(agents) || this.conns.get(m.id) !== c) return;
        c.remote = { ...c.remote, agents: agents.map(remoteAgent) };
      }),
    );
    if (online.length) this.onChange();
  }

  #fail(c, msg, hint, { keep = false } = {}) {
    if (this.conns.get(c.id) !== c) return;
    if (c.error && !keep) return;
    c.error = msg;
    c.hint = hint || c.hint;
    const running = c.steps.find((s) => s.status === 'run');
    if (running) Object.assign(running, { status: 'fail', detail: running.detail || msg });
    this.onChange();
    this.#hangUp(c);
  }

  #closed(m, c, code) {
    clearTimeout(c.readyTimer);
    c.child = null;
    c.events?.destroy();
    if (this.conns.get(m.id) !== c) return;
    if (c.stopped) {
      c.state = 'off';
      return this.onChange();
    }
    const lost = c.state === 'online' || c.wasOnline;
    if (!c.error) {
      c.error = lost ? 'Connection lost.' : String(c.stderr).trim().split('\n').filter(Boolean).at(-1) || `ssh exited (${code}).`;
      c.hint = sshHint(c.stderr, m.target);
      const running = c.steps.find((s) => s.status === 'run');
      if (running) Object.assign(running, { status: 'fail', detail: c.error });
    }
    // Once it has worked, keep trying (laptop lid, Wi-Fi, VPN). A first connect that fails stops.
    if (lost && !c.giveUp) {
      c.state = 'reconnecting';
      const wait = RETRY_MS[Math.min(c.attempt, RETRY_MS.length - 1)];
      c.attempt += 1;
      c.retryTimer = setTimeout(() => this.connect(m.id, { retry: true }).catch(() => {}), wait);
      c.retryTimer.unref?.();
    } else c.state = 'error';
    this.onChange();
    this.emit('offline', m);
  }

  #hangUp(c) {
    clearTimeout(c.retryTimer);
    clearTimeout(c.readyTimer);
    c.events?.destroy();
    if (c.child) {
      c.child.stdin.end();
      killTree(c.child);
    }
  }

  disconnect(id) {
    const c = this.conns.get(id);
    if (!c) return;
    c.stopped = true;
    c.giveUp = true;
    this.#hangUp(c);
    if (!c.child) c.state = 'off';
    this.onChange();
  }

  // Run one command on the machine (stop / restart its wisp). Resolves { code, out }.
  #ssh(m, command) {
    return new Promise((resolve) => {
      const child = spawn(sshBin(), ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', m.target, command], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('error', (err) => resolve({ code: -1, out: err.message }));
      child.on('close', (code) => resolve({ code, out }));
    });
  }

  // Stop wisp on the machine: its agents stop too. restart: connect again right after, which
  // starts this version there.
  async stopRemote(id, { restart = false } = {}) {
    const m = this.get(id);
    const c = this.conns.get(id);
    const pid = c?.remote?.pid || c?.stalePid;
    if (!pid) throw bad('wisp isn’t known to be running there.', 409);
    this.disconnect(id);
    const r = await this.#ssh(m, `kill ${Number(pid)} 2>&1 || true`);
    if (r.code) throw bad(`Couldn’t stop it: ${r.out.trim() || `ssh exited ${r.code}`}`, 502);
    this.cache.delete(id);
    if (c) Object.assign(c, { remote: null, stalePid: null });
    if (restart) {
      await new Promise((res) => setTimeout(res, 1500));
      await this.connect(id);
    }
    this.onChange();
    return { ok: true };
  }

  // --- requests through the tunnel ---------------------------------------------------------

  #online(id) {
    const m = this.get(id);
    const c = this.conns.get(id);
    if (c?.state !== 'online') throw bad(`${m.name} is offline. Connect it from Machines.`, 503);
    return { m, c };
  }

  #request(m, c, method, p, { body, headers = {}, timeout = 120_000 } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: c.localPort, path: `/api${p}`, method, headers: { ...headers, host: `127.0.0.1:${m.port}` }, timeout }, resolve);
      req.on('timeout', () => req.destroy(Object.assign(new Error(`${m.name} didn’t answer in time.`), { status: 504 })));
      req.on('error', (err) => reject(Object.assign(err, { status: err.status || 502 })));
      if (body && typeof body.pipe === 'function') body.pipe(req);
      else req.end(body);
    });
  }

  async #raw(m, c, method, p, body, opts = {}) {
    const json = method !== 'GET';
    const res = await this.#request(m, c, method, p, { body: json ? JSON.stringify(body ?? {}) : undefined, headers: json ? { 'content-type': 'application/json' } : {}, ...opts });
    const text = await readAll(res);
    let j;
    try {
      j = text ? JSON.parse(text) : {};
    } catch {
      j = { error: text.slice(0, 200) };
    }
    if (res.statusCode >= 400) throw bad(j.error || `${m.name}: HTTP ${res.statusCode}`, res.statusCode);
    return j;
  }

  // JSON call to the machine's API: p is the path under /api.
  json(id, method, p, body, opts) {
    const { m, c } = this.#online(id);
    return this.#raw(m, c, method, p, body, opts);
  }

  // A raw request (files, uploads): resolves with the http.IncomingMessage.
  stream(id, method, p, opts) {
    const { m, c } = this.#online(id);
    return this.#request(m, c, method, p, opts);
  }

  // --- the machine's event stream, relayed with ids rewritten ------------------------------

  #listen(m, c) {
    const req = http.get({ host: '127.0.0.1', port: c.localPort, path: '/api/events', headers: { host: `127.0.0.1:${m.port}`, accept: 'text/event-stream' } }, (res) => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (!event || !data) continue;
          try {
            this.#relay(m, event, JSON.parse(data));
          } catch {}
        }
      });
      res.on('end', () => this.#streamLost(m, c));
    });
    req.on('error', () => this.#streamLost(m, c));
    c.events = req;
  }

  // The stream only ends when wisp over there stopped or the tunnel broke: start over.
  #streamLost(m, c) {
    if (this.conns.get(m.id) !== c || c.state !== 'online' || c.stopped) return;
    c.error = 'wisp stopped answering there.';
    this.#hangUp(c);
  }

  #relay(m, event, d) {
    const q = (id) => qualify(id, m.id);
    const cache = this.#cacheOf(m.id);
    if (event === 'summary') {
      if (d.agent === 'wisp') return; // its own welcome tour
      cache.set(d.id, d);
      return this.onEvent('summary', this.summary(m.id, d));
    }
    if (event === 'activity' || event === 'turn') return this.onEvent(event, { ...d, sessionId: q(d.sessionId) });
    if (event === 'finished') {
      if (d.session?.agent === 'wisp') return;
      cache.set(d.session.id, d.session);
      return this.onEvent('finished', { ...d, session: this.summary(m.id, d.session) });
    }
    if (event === 'removed') {
      cache.delete(d.id);
      return this.onEvent('removed', { id: q(d.id) });
    }
  }

  #cacheOf(mid) {
    if (!this.cache.has(mid)) this.cache.set(mid, new Map());
    return this.cache.get(mid);
  }

  // --- rewriting: remote shapes → local ones -----------------------------------------------

  #tag(m) {
    return { id: m.id, name: m.name, target: m.target };
  }

  summary(mid, s) {
    const m = this.get(mid);
    const q = (id) => qualify(id, mid);
    const p = this.store.projectFor(s.cwd || '', mid);
    return {
      ...s,
      id: q(s.id),
      groupId: s.groupId || null, // random, and shared across machines when one launch fans out
      ...(s.parentId && { parentId: q(s.parentId) }),
      ...(s.group && { group: s.group.map((x) => this.summary(mid, x)) }),
      projectId: p?.id || null,
      project: p?.name || s.project,
      color: p?.color || s.color,
      machine: this.#tag(m),
    };
  }

  session(mid, s) {
    const m = this.get(mid);
    const q = (id) => qualify(id, mid);
    return {
      ...s,
      id: q(s.id),
      groupId: s.groupId || null, // random, and shared across machines when one launch fans out
      ...(s.parentId && { parentId: q(s.parentId) }),
      ...(s.children && { children: Object.fromEntries(Object.entries(s.children).map(([k, v]) => [k, q(v)])) }),
      ...(s.childSessions && { childSessions: Object.fromEntries(Object.entries(s.childSessions).map(([k, v]) => [q(k), this.session(mid, v)])) }),
      turns: (s.turns || []).map((t) => ({
        ...t,
        ...(t.delegations && { delegations: t.delegations.map((d) => ({ ...d, sessionId: q(d.sessionId) })) }),
        ...(t.attachments && { attachments: t.attachments.map((a) => ({ ...a, id: q(a.id) })) }),
      })),
      machine: this.#tag(m),
    };
  }

  // Every machine's sessions (fresh when online, the last seen ones when not), for GET /sessions.
  async sessions(q = {}, { only } = {}) {
    const qs = new URLSearchParams(Object.entries(q).filter(([k]) => k === 'children' || k === 'archived')).toString();
    const lists = await Promise.all(
      this.list
        .filter((m) => !only || m.id === only)
        .map(async (m) => {
          const cache = this.#cacheOf(m.id);
          if (this.isOnline(m.id)) {
            try {
              const list = await this.json(m.id, 'GET', `/sessions${qs ? `?${qs}` : ''}`, undefined, { timeout: LIST_TIMEOUT_MS });
              cache.clear();
              for (const s of list) if (s.agent !== 'wisp') cache.set(s.id, s);
            } catch {}
          }
          return [...cache.values()].map((s) => this.summary(m.id, s));
        }),
    );
    return lists.flat();
  }

  // --- launching and projects ----------------------------------------------------------------

  // Resolves with the machine's own summary (ids not rewritten yet): the caller may add the project first.
  async launch(mid, body) {
    const { machine, ...rest } = body;
    const out = await this.json(mid, 'POST', '/sessions', rest);
    for (const x of out.group || [out]) this.#cacheOf(mid).set(x.id, x);
    return out;
  }

  // Copy one of this computer's uploads to the machine; resolves with its upload record there.
  async upload(mid, u) {
    const res = await this.stream(mid, 'POST', `/uploads?name=${encodeURIComponent(u.name)}&type=${encodeURIComponent(u.mime)}`, {
      body: fs.createReadStream(u.path),
      headers: { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(u.path).size },
      timeout: 10 * 60_000,
    });
    const text = await readAll(res);
    const j = JSON.parse(text || '{}');
    if (res.statusCode >= 400) throw bad(j.error || `Upload failed (${res.statusCode})`, res.statusCode);
    return j;
  }

  async addProject(mid, dir, name) {
    const p = await this.json(mid, 'POST', '/projects', { path: dir });
    const local = this.store.addProject(p.path, { name: name || p.name, machine: mid });
    return local;
  }

  // A terminal on the machine running `command` (Take over), in the user's own interactive login
  // shell so its PATH has the harness. Wrapped in sh, so a fish or nu login shell parses it too.
  terminalArgv(mid, command) {
    const m = this.get(mid);
    return [sshBin(), '-t', m.target, `sh -c ${shq('exec "${SHELL:-/bin/sh}" -lic "$0"')} ${shq(command)}`];
  }
}
