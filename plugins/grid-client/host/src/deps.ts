// What every part of this plugin shares: the peers (machines rows), their tokens, machines commands,
// notices and usage stats, and the grids this wisp may publish, share and make sandboxes on.

import type { Json, PluginContext } from '@wisp/kernel';
import { COMMANDS as MACHINES, MACHINES_SERVICE, secretKey } from '@wisp-plugin/machines-api';
import type { AddArgs, MachinesService, PeerRow, PeerView, UpdateArgs } from '@wisp-plugin/machines-api';
import type { GridData, PublishTarget } from '@wisp-plugin/grid-client-api';
import type { NotifyService, SecretsService } from './kernel.ts';

export type Env = Readonly<Record<string, string | undefined>>;

export interface Deps {
  readonly ctx: PluginContext;
  readonly env: Env;
  peers(): readonly PeerRow[];
  machines(): MachinesService;
  /** a peer's token (secrets: machines.<id>) */
  token(id: string): Promise<string | undefined>;
  addPeer(a: AddArgs): Promise<PeerView>;
  updatePeer(a: UpdateArgs): Promise<PeerView>;
  removePeer(id: string): Promise<void>;
  view(): Promise<PeerView[]>;
  notice(kind: string, data: Json): void;
  /** v1 telemetry.track: fixed values only */
  track(event: string, props: Record<string, Json>): void;
}

interface Telemetry {
  track(event: string, props?: Record<string, Json | undefined>): void;
}
// wisp.telemetry's telemetry.service@1 (its api package has no package.json yet, so the ref is here)
const TELEMETRY = { id: 'telemetry.service', major: 1, permissions: { track: 'telemetry:track' } } as const;

export function makeDeps(ctx: PluginContext, env: Env): Deps {
  const machines = (): MachinesService => ctx.use(MACHINES_SERVICE);
  const run = <R>(cmd: string, args: unknown): Promise<R> => ctx.run<R>(cmd, args);
  return {
    ctx,
    env,
    machines,
    peers: () => machines().peers(),
    token: (id) => ctx.service<SecretsService>('secrets').get(secretKey(id)),
    addPeer: (a) => run<PeerView>(MACHINES.add, a),
    updatePeer: (a) => run<PeerView>(MACHINES.update, a),
    removePeer: async (id) => void (await run(MACHINES.remove, { id })),
    view: () => run<PeerView[]>(MACHINES.list, {}),
    notice: (kind, data) => ctx.service<NotifyService>('notify').notice(kind, data),
    track: (event, props) => {
      try {
        ctx.tryUse<Telemetry>(TELEMETRY)?.track(event, props);
      } catch {
        // usage stats never break what they count
      }
    },
  };
}

// ---------- grid peers ----------

export const isGridPeer = (p: PeerRow): boolean => p.transport === 'grid' || p.transport === 'grid-tunnel';

/** A grid peer's own fields (v1's machine fields for kind 'grid'). */
export function dataOf(p: PeerRow): GridData {
  const d = p.data;
  const s = (k: string): string => (typeof d[k] === 'string' ? (d[k] as string) : '');
  const out: GridData = { grid: s('grid'), handle: s('handle'), user: d['user'] ?? null };
  if (s('computer')) out.computer = s('computer');
  if (s('sandbox')) out.sandbox = s('sandbox');
  if (d['owner'] && typeof d['owner'] === 'object' && !Array.isArray(d['owner'])) out.owner = d['owner'] as GridData['owner'] & object;
  if (d['dropping'] === true) out.dropping = true;
  if (d['setup'] !== undefined) out.setup = d['setup'];
  if (d['seeded'] && typeof d['seeded'] === 'object' && !Array.isArray(d['seeded'])) out.seeded = d['seeded'] as Record<string, string>;
  return out;
}

/** The peer's https origin (v1 m.url). */
export const originOf = (p: PeerRow): string => p.address;

/** Each sign-in on a grid (a cloud computer and its device token) is an account. */
export const accounts = (peers: readonly PeerRow[]): PeerRow[] =>
  peers.filter((p) => p.transport === 'grid' && !dataOf(p).computer && !dataOf(p).sandbox);

export const sameAccount = (a: PeerRow, b: PeerRow): boolean => dataOf(a).grid === dataOf(b).grid && dataOf(a).handle === dataOf(b).handle;

// ---------- where this wisp publishes, shares and makes sandboxes ----------

export interface GridTarget extends PublishTarget {
  grid: string;
  auth: string;
}

/**
 * Each wisp Grid this wisp is signed in to (v1 publish.js gridTargets). In a cloud wisp, its own grid
 * (hostd gave it the address and a secret); elsewhere, a grid you signed in to: its cloud computer's
 * device token. A sandbox is one task's box: it publishes and shares nothing as its owner.
 */
export async function gridTargets(d: Deps): Promise<GridTarget[]> {
  const out: Omit<GridTarget, 'host'>[] = [];
  const grid = String(d.env['WISP_GRID_URL'] ?? '').replace(/\/+$/, '');
  const secret = d.env['WISP_TRUSTED_PROXY_SECRET'];
  const pub = d.env['WISP_PUBLIC_URL'];
  if (grid && secret && pub && d.env['WISP_SANDBOX'] !== '1') {
    const handle = new URL(pub).hostname.split('.')[0] ?? '';
    out.push({ id: 'box', grid, handle, auth: `Box ${handle} ${secret}` });
  }
  for (const m of accounts(d.peers())) {
    const g = dataOf(m);
    if (!g.grid) continue;
    const token = await d.token(m.id);
    if (token && !out.some((t) => t.grid === g.grid && t.handle === g.handle)) out.push({ id: m.id, grid: g.grid, handle: g.handle, auth: `Bearer ${token}` });
  }
  return out.map((t) => ({ ...t, host: new URL(t.grid).host }));
}

export const targetView = (t: GridTarget): PublishTarget => ({ id: t.id, host: t.host, handle: t.handle });
