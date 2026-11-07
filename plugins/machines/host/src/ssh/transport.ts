// The ssh transport (machines.transport@1): system OpenSSH, so ~/.ssh/config, agents, ProxyJump and
// FIDO keys all keep working (plan §7.2.2). One `ssh -L <free port>:127.0.0.1:<port> <host> sh -s`
// per machine; the bootstrap script on stdin finds Node, starts wisp there if nothing answers on
// <port>, reports each step as an `@@wisp …` line, then holds the session (and the tunnel) open.
//
// Nothing new listens on the network: the remote wisp stays on its own loopback, and keeps running
// (agents too) when this computer sleeps. Auth is whatever your SSH setup does.

import net from 'node:net';
import type { Child, ProcService, Scope } from '@wisp/kernel';
import { PeerHttpError, TransportError, type AddArgs, type Channel, type ChannelEnd, type ConnectIO, type Hint, type PeerRow, type Transport } from '@wisp-plugin/machines-api';
import { bootstrapScript, STEPS } from '../bootstrap.js';
import { loopbackChannel } from '../http-channel.ts';
import { shq } from '../shq.js';
import { letIn } from './letin.ts';
import { sshHint, TARGET } from './hosts.ts';

export const DEFAULT_PORT = 4477;
export const READY_TIMEOUT_MS = 6 * 60_000; // the first `npx` download can take a while

export interface SshOptions {
  proc: ProcService;
  /** the plugin's scope: each connect's ready timer lives in a child of it */
  scope: Scope;
  /** this wisp's version: `npx -y wisp-agents@<version>` is what starts there by default */
  version: string;
  /** `ssh` (WISP_SSH in tests) */
  ssh: string;
  /** this computer's ~/.ssh, for Let me in */
  sshDir: string;
  env?: Record<string, string | undefined>;
  readyTimeoutMs?: number;
  /** bind-and-release a free loopback port (a test may pin it) */
  freePort?: () => Promise<number>;
}

/** A free loopback port for the -L forward: bound, read and closed at once, never accepting. */
export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer().once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (typeof a === 'object' && a !== null ? resolve(a.port) : reject(new Error('no port'))));
    });
  });

const SSH_OPTS = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ExitOnForwardFailure=yes'];

/** Splits a byte stream into lines, as readline did. */
function lines(onLine: (l: string) => void): (chunk: Uint8Array) => void {
  const dec = new TextDecoder();
  let buf = '';
  return (chunk) => {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i).replace(/\r$/, ''));
      buf = buf.slice(i + 1);
    }
  };
}

export function sshTransport(o: SshOptions): Transport {
  const defaultCommand = `npx -y wisp-agents@${o.version}`;
  return {
    kind: 'ssh',
    steps: STEPS,
    clean: (input, prev) => cleanSsh(input, prev),
    autoStart: () => true,
    connect: (peer, io, signal) => connectSsh(o, peer, io, signal, peer.command || defaultCommand),
    terminalArgv: (peer, command) => [o.ssh, '-t', peer.address, `sh -c ${shq('exec "${SHELL:-/bin/sh}" -lic "$0"')} ${shq(command)}`],
    letIn: (peer, password) => letIn(o.proc, { target: peer.address, password, ssh: o.ssh, dir: o.sshDir, ...(o.env !== undefined && { env: o.env }) }),
    async stopRemote(peer, { pid }) {
      if (!pid) throw new PeerHttpError('wisp isn’t known to be running there.', 409);
      const r = await o.proc.exec(o.ssh, ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', peer.address, `kill ${Number(pid)} 2>&1 || true`]).catch((e: unknown) => ({ code: -1, stdout: e instanceof Error ? e.message : String(e), stderr: '', timedOut: false }));
      if (r.code) throw new PeerHttpError(`Couldn’t stop it: ${`${r.stdout}${r.stderr}`.trim() || `ssh exited ${r.code}`}`, 502);
      return 'off';
    },
  };
}

/** v1 Machines#clean for an ssh machine: the target is never an option, the port a port. */
export function cleanSsh(body: AddArgs, prev: PeerRow | undefined): Partial<PeerRow> {
  const pick = <T>(v: T | undefined, p: T | undefined, d: T): T => (v !== undefined ? v : p !== undefined ? p : d);
  const address = String(pick(body.address ?? body.target, prev?.address, '')).trim();
  if (!TARGET.test(address)) throw new PeerHttpError('SSH host: user@host, a host name, or a Host from ~/.ssh/config.', 400);
  const port = Number(pick(body.port, prev?.port, DEFAULT_PORT));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new PeerHttpError('Port: a number from 1 to 65535.', 400);
  const command = String(pick(body.command, prev?.command, '') || '').trim();
  const name = String(pick(body.name, prev?.name, '') || '').trim().slice(0, 40) || address.replace(/^.*@/, '');
  return { name, address, port, command, autoConnect: pick(body.autoConnect, prev?.autoConnect, true) !== false };
}

interface Run {
  child: Child;
  stderr: string;
  ready: boolean;
  settled: boolean;
}

async function connectSsh(o: SshOptions, peer: PeerRow, io: ConnectIO, signal: AbortSignal, command: string): Promise<Channel> {
  const localPort = await (o.freePort ?? freePort)();
  const args = [...SSH_OPTS, '-L', `${localPort}:127.0.0.1:${peer.port}`, peer.address, 'sh -s'];
  let child: Child;
  try {
    child = o.proc.spawn(o.ssh, args, { stdin: 'pipe', signal, ...(o.env !== undefined && { env: o.env }) });
  } catch (err) {
    throw new TransportError({ message: `Could not run ssh: ${err instanceof Error ? err.message : String(err)}`, hint: { text: 'wisp needs the OpenSSH client (`ssh`) on this computer.' }, giveUp: true });
  }
  const run: Run = { child, stderr: '', ready: false, settled: false };
  child.write(bootstrapScript({ port: peer.port, command, apiVersion: 'any', installNode: true }));
  child.onStderr(
    lines((l) => {
      run.stderr = `${run.stderr}${l}\n`.slice(-4000);
      if (l.trim()) io.log(l);
    }),
  );
  const exited = child.exited.then(({ code }) => code);
  const closed: Promise<ChannelEnd> = exited.then((code) => lostEnd(run, peer, code));
  const channel = loopbackChannel({ port: localPort, host: `127.0.0.1:${peer.port}`, label: `localhost:${localPort} → ${peer.port}`, closed, close: () => hangUp(run) });
  const timers = o.scope.child(`ssh:${peer.id}`); // the ready timer, dropped once the connect settles
  return new Promise<Channel>((resolve, reject) => {
    const fail = (e: TransportError): void => {
      if (run.settled) return;
      run.settled = true;
      timers.dispose();
      hangUp(run);
      reject(e);
    };
    timers.timeout(o.readyTimeoutMs ?? READY_TIMEOUT_MS, () => fail(new TransportError({ message: 'It took too long to start wisp there.' })));
    signal.addEventListener('abort', () => fail(new TransportError({ message: 'Stopped.', giveUp: true })), { once: true });
    child.onStdout(
      lines((line) => {
        const r = onLine(line, io);
        if (r === 'ready' && !run.settled) {
          run.settled = run.ready = true;
          timers.dispose();
          resolve(channel);
        } else if (r instanceof TransportError) fail(r);
      }),
    );
    void exited.then((code) => fail(beforeReady(run, peer, code)));
  });
}

/** One line of the script's output: a step, a failure, ready, or something to log. */
function onLine(line: string, io: ConnectIO): 'ready' | TransportError | undefined {
  const hit = /^@@wisp (\w+)\s*(.*)$/.exec(line);
  if (!hit) {
    if (line.trim()) io.log(line);
    return undefined;
  }
  const kind = hit[1] ?? '';
  const rest = hit[2] ?? '';
  if (kind === 'step') {
    const [, sid = '', status = '', detail = ''] = /^(\w+) (\w+)\s*(.*)$/.exec(rest) ?? [];
    io.log(`${sid}: ${detail || status}`);
    if (status === 'run' || status === 'done' || status === 'warn' || status === 'fail') io.step(sid, status, detail);
    return undefined;
  }
  if (kind === 'stale') {
    io.stale(Number(rest) || null);
    return undefined;
  }
  if (kind === 'fail') {
    const [, sid = '', msg = ''] = /^(\w+)\s*(.*)$/.exec(rest) ?? [];
    io.step(sid, 'fail', msg);
    const hint: Hint | undefined = sid === 'node' ? { title: 'Node.js is missing there', text: 'wisp couldn’t install Node.js there by itself (see above). Install the LTS version from nodejs.org on that computer, then Try again.', url: 'https://nodejs.org/en/download' } : undefined;
    return new TransportError({ message: msg, ...(hint && { hint }), giveUp: true }); // retrying won't change the answer
  }
  if (kind === 'ready') {
    const [version = '', pid = ''] = rest.split(' ');
    io.log(`ready: wisp ${version} (pid ${pid})`);
    return 'ready';
  }
  return undefined;
}

/** ssh exited before wisp answered: its last stderr line, and what it most likely needs. */
function beforeReady(run: Run, peer: PeerRow, code: number | null): TransportError {
  const hint = sshHint(run.stderr, peer.address);
  const last = run.stderr.trim().split('\n').filter(Boolean).at(-1);
  return new TransportError({ message: last ?? `ssh exited (${code}).`, ...(hint && { hint }) });
}

function lostEnd(run: Run, peer: PeerRow, code: number | null): ChannelEnd {
  const hint = sshHint(run.stderr, peer.address);
  return { reason: 'lost', error: run.ready ? 'Connection lost.' : `ssh exited (${code}).`, ...(hint && { hint }) };
}

function hangUp(run: Run): void {
  run.child.closeStdin();
  run.child.kill('SIGTERM');
}
