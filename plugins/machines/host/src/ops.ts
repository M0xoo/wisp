// What the commands do (v1 Machines add/update/remove/view/stopRemote/letIn/recheckAgents), over the
// registry, the manager and the transports. Routes and commands both call these.

import type { Json, SecretsService } from '@wisp/kernel';
import { PeerHttpError, secretKey, type AddArgs, type PeerRow, type PeerView, type Transport, type UpdateArgs } from '@wisp-plugin/machines-api';
import { getJson, remoteAgent, sleep, type Manager } from './manager.ts';
import { newMachineId } from './registry.ts';
import type { LinkStore, StatusStore } from './state.ts';

export interface OpsOptions {
  manager: Manager;
  secrets: SecretsService;
  status: StatusStore;
  links: LinkStore;
  /** this wisp's version: an older one there is offered an update to it */
  version: string;
  emit(type: string, data: { [k: string]: Json }): void;
}

/** "a is newer than b" in semver, prereleases before their release (v1 update.js newer). */
export function newer(a: string, b: string): boolean {
  const parse = (v: string): [number[], string[]] => {
    const [core = '', ...pre] = String(v || '').replace(/^v/, '').split('+')[0]?.split('-') ?? [];
    return [core.split('.').map(Number), pre.length ? pre.join('-').split('.') : []];
  };
  const [[x, xp], [y, yp]] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  if (!xp.length || !yp.length) return !xp.length && !!yp.length; // a release beats its prereleases
  for (let i = 0; i < Math.max(xp.length, yp.length); i++) {
    const [s, t] = [xp[i], yp[i]];
    if (s === t) continue;
    if (s === undefined || t === undefined) return t === undefined;
    const [m, n] = [/^\d+$/.test(s), /^\d+$/.test(t)];
    if (m && n) return Number(s) > Number(t);
    if (m !== n) return n; // numbers sort before words
    return s > t;
  }
  return false;
}

/** The version an older wisp there would become on Restart: this one, unless a custom command decides. */
export const updateTo = (local: string, remote: string | undefined, command: string): string | null => (!command && remote && newer(local, remote) ? local : null);

/** A transport with no clean() of its own: only the name and auto-connect change (a grid peer). */
function cleanGeneric(body: AddArgs, prev: PeerRow | undefined): Partial<PeerRow> {
  const name = String(body.name ?? prev?.name ?? '').trim().slice(0, 40) || prev?.name || String(body.address ?? '').replace(/^https?:\/\//, '').slice(0, 40);
  const out: Partial<PeerRow> = { name, autoConnect: (body.autoConnect ?? prev?.autoConnect ?? true) !== false };
  if (!prev) Object.assign(out, { address: String(body.address ?? body.target ?? ''), port: Number(body.port ?? 443), command: '' });
  return out;
}

export class Ops {
  readonly #o: OpsOptions;
  constructor(o: OpsOptions) {
    this.#o = o;
  }

  get #m(): Manager {
    return this.#o.manager;
  }

  #transport(kind: string): Transport {
    const t = this.#m.o.transport(kind);
    if (!t) throw new PeerHttpError(`Nothing here reaches a “${kind}” machine (its plugin is off or missing).`, 400);
    return t;
  }

  defaultCommand(): string {
    return `npx -y wisp-agents@${this.#o.version}`;
  }

  async add(body: AddArgs): Promise<PeerView> {
    const kind = body.transport ?? 'ssh';
    const t = this.#transport(kind);
    const f = { ...cleanGeneric(body, undefined), ...t.clean?.(body, undefined) };
    const row: PeerRow = { id: newMachineId(), peer: null, name: f.name ?? '', transport: kind, address: f.address ?? '', port: f.port ?? 0, command: f.command ?? '', autoConnect: f.autoConnect ?? true, addedAt: this.#m.o.clock.now(), data: body.data ?? {} };
    if (kind === 'ssh' && this.#m.o.registry.all().some((x) => x.transport === 'ssh' && x.address === row.address && x.port === row.port)) throw new PeerHttpError(`${row.address} is already added.`, 409);
    if (body.token) await this.#o.secrets.set(secretKey(row.id), body.token);
    this.#m.o.registry.put(row);
    this.#o.emit('machines.changed', { id: row.id });
    if (body.connect !== false) await this.#m.connect(row.id);
    return this.view(row.id);
  }

  async update(body: UpdateArgs): Promise<PeerView> {
    const prev = this.#m.o.registry.get(body.id);
    const t = this.#transport(prev.transport);
    const next: PeerRow = { ...prev, ...cleanGeneric(body, prev), ...t.clean?.(body, prev), ...(body.data !== undefined && { data: { ...prev.data, ...body.data } }) };
    const c = this.#m.conns.get(prev.id);
    const reconnect = (['address', 'port', 'command'] as const).some((k) => next[k] !== prev[k]) && c !== undefined && c.state !== 'off';
    if (body.token !== undefined && body.token !== (await this.#o.secrets.get(secretKey(prev.id)))) await this.#o.secrets.set(secretKey(prev.id), body.token);
    this.#m.o.registry.put(next);
    if (reconnect) {
      this.#m.disconnect(prev.id);
      await this.#m.connect(prev.id);
    }
    this.#o.emit('machines.changed', { id: prev.id });
    return this.view(prev.id);
  }

  /** v1 remove + computer.removing: the transport tidies up over there and names who goes with it. */
  async remove(id: string): Promise<{ ok: true; removed: string[] }> {
    const peer = this.#m.o.registry.get(id);
    const t = this.#m.transportOf(peer);
    const extra = (await t?.forget?.(peer, this.#m.o.registry.all()).catch(() => ({ also: [] })))?.also ?? [];
    const ids = [id, ...extra.filter((x) => x !== id && this.#m.o.registry.find(x))];
    const rows = ids.map((x) => this.#m.o.registry.get(x));
    for (const x of ids) {
      this.#m.disconnect(x);
      this.#m.forget(x);
      this.#m.o.mirror.reset(x);
      await this.#o.secrets.delete(secretKey(x));
    }
    this.#m.o.mirror.flush();
    this.#o.status.delete(ids);
    this.#o.links.delete(ids);
    this.#m.o.registry.remove(ids);
    for (const row of rows) this.#o.emit('machines.removed', { id: row.id, row: row as unknown as Json });
    return { ok: true, removed: ids };
  }

  /** Stop wisp over there (its agents too); restart connects again, which starts this version. */
  async stop(id: string, restart = false): Promise<{ ok: true }> {
    const peer = this.#m.o.registry.get(id);
    const t = this.#transport(peer.transport);
    if (!t.stopRemote) throw new PeerHttpError(`wisp on ${peer.name} can’t be stopped from here.`, 400);
    const c = this.#m.conns.get(id);
    const pid = c?.remote?.pid ?? c?.stale ?? null;
    const secret = (): Promise<string | undefined> => this.#o.secrets.get(secretKey(id));
    if (t.probe) {
      // the grid stops it, and starts it again on the next request
      await t.stopRemote(peer, { pid, secret });
      if (c) this.#m.asleep(peer, t, c);
      if (restart) await this.#m.connect(id, { retry: true });
      return { ok: true };
    }
    if (!pid) throw new PeerHttpError('wisp isn’t known to be running there.', 409);
    this.#m.disconnect(id);
    await t.stopRemote(peer, { pid, secret });
    this.#m.o.mirror.reset(id);
    if (c) Object.assign(c, { remote: null, stale: null });
    if (restart) {
      await sleep(this.#m.o.scope, 1_500);
      await this.#m.connect(id);
    }
    this.#o.emit('machines.changed', { id });
    return { ok: true };
  }

  /** The machine refused this computer's key: the password once adds it, then it connects. */
  async letIn(id: string, password: string): Promise<{ ok: true; madeKey: boolean; machine: PeerView }> {
    const peer = this.#m.o.registry.get(id);
    const t = this.#transport(peer.transport);
    if (!t.letIn) throw new PeerHttpError('A cloud computer signs in through its grid: Settings → Cloud.', 400);
    const r = await t.letIn(peer, password);
    await this.#m.connect(id);
    return { ...r, machine: this.view(id) };
  }

  /** Harnesses looked up again on every online machine (after a sign-in there); only: one of them. */
  async recheckAgents(only: [string, string] | null = null): Promise<void> {
    const online = [...this.#m.conns.values()].filter((c) => c.state === 'online' && c.channel && (!only || c.id === only[0]));
    await Promise.all(
      online.map(async (c) => {
        if (!c.channel) return;
        const agents = await getJson(c.channel, `/agents?fresh=${only ? encodeURIComponent(only[1]) : 1}`);
        if (!Array.isArray(agents) || this.#m.conns.get(c.id) !== c) return;
        c.remote = { ...c.remote, agents: agents.filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null).map(remoteAgent) };
        this.#m.changed(c);
      }),
    );
  }

  terminalArgv(id: string, command: string): string[] {
    const peer = this.#m.o.registry.get(id);
    const argv = this.#m.transportOf(peer)?.terminalArgv?.(peer, command) ?? null;
    if (!argv) throw new PeerHttpError('Take over needs a terminal on that computer; a cloud computer doesn’t offer one yet.', 400);
    return argv;
  }

  /** A peer as GET /api/machines shows it: v1's view, field for field. */
  view(id: string): PeerView {
    const m = this.#m.o.registry.get(id);
    const c = this.#m.conns.get(id);
    const status = c ? this.#m.status(c) : undefined;
    const working = this.#m.o.mirror.rows(id).filter((s) => s.v['state'] === 'running').length;
    const grid = m.transport !== 'ssh';
    return {
      ...m.data,
      id: m.id,
      peer: m.peer,
      name: m.name,
      transport: m.transport,
      address: m.address,
      port: m.port,
      command: m.command,
      autoConnect: m.autoConnect,
      addedAt: m.addedAt,
      kind: grid ? 'grid' : 'ssh',
      target: grid ? hostOf(m.address) : m.address,
      ...(grid && { url: m.address }),
      defaultCommand: this.defaultCommand(),
      state: status?.state ?? 'off',
      steps: status?.steps ?? [],
      error: status?.error ?? '',
      hint: status?.hint ?? null,
      stale: !!status?.stale,
      attempt: status?.attempt ?? 0,
      since: status?.since ?? null,
      remote: c?.remote ?? null,
      outdated: updateTo(this.#o.version, c?.remote?.version, m.command),
      log: c?.log.slice(-30) ?? [],
      working,
    };
  }

  views(): PeerView[] {
    return this.#m.o.registry.all().map((m) => this.view(m.id));
  }
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
