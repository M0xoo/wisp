// What Machines shows of a machine, as plain functions (v1 machines.js card, kind, where, found, steps, trouble):
// no Solid, no client, so the tests read them without the components.
import type { Step as KitStep } from '@wisp/ui';

export const DEFAULT_PORT = 4477;

export interface PeerLike {
  readonly id: string;
  readonly name: string;
  readonly transport: string;
  readonly address: string;
  readonly port: number;
  readonly command?: string;
  readonly autoConnect?: boolean;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface StepLike {
  readonly id: string;
  readonly label: string;
  /** pending | run | done | warn | fail */
  readonly status: string;
  readonly detail: string;
}

export interface HintLike {
  readonly title?: string;
  readonly text: string;
  readonly command?: string;
  readonly url?: string;
  readonly letIn?: boolean;
  readonly tailscale?: boolean;
}

export interface StatusLike {
  readonly state: string;
  readonly error: string;
  readonly steps?: readonly StepLike[];
  readonly hint?: HintLike | null;
  readonly attempt?: number;
  readonly stale?: number | null;
  readonly remote?: { readonly version?: string; readonly agents?: readonly { readonly id: string; readonly name: string; readonly available: boolean }[] } | null;
}

export interface Found {
  readonly target: string;
  readonly name: string;
  /** ssh-config | tailscale | known-hosts */
  readonly source: string;
  readonly detail: string;
  readonly online?: boolean;
}

type Say = (key: string, vars?: Readonly<Record<string, string | number>>) => string;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Where a machine comes from, said on its card: over SSH, one of your computers through a grid, or a cloud computer. */
export function kindOf(m: PeerLike): 'ssh' | 'grid' | 'cloud' {
  if (m.transport !== 'grid' && m.transport !== 'grid-tunnel') return 'ssh';
  return m.data?.['computer'] ? 'grid' : 'cloud';
}

const gridHost = (m: PeerLike): string => (str(m.data?.['grid']) || m.address).replace(/^https?:\/\//, '').replace(/\/$/, '');

/** The line under its name: `me@box · port 4500`, or `on grid.trywisp.dev` / `through grid.trywisp.dev`. */
export function whereOf(m: PeerLike, say: Say): string {
  if (kindOf(m) === 'ssh') return m.port && m.port !== DEFAULT_PORT ? say('machines.where.port', { target: m.address, port: m.port }) : m.address;
  return say(kindOf(m) === 'grid' ? 'machines.where.through' : 'machines.where.on', { grid: gridHost(m) });
}

/** The card's one button (v1): Connect, Try again, Wake / Check again; Disconnect online; Cancel while connecting. */
export function primaryOf(m: PeerLike, state: string): { readonly act: 'connect' | 'disconnect'; readonly label: string; readonly primary: boolean } {
  if (state === 'online') return { act: 'disconnect', label: 'machines.disconnect', primary: false };
  if (state === 'connecting' || state === 'reconnecting') return { act: 'disconnect', label: 'machines.cancel', primary: false };
  if (state === 'error') return { act: 'connect', label: 'machines.tryAgain', primary: true };
  if (state === 'asleep') return { act: 'connect', label: kindOf(m) === 'grid' ? 'machines.checkAgain' : 'machines.wake', primary: true };
  return { act: 'connect', label: 'machines.connect', primary: true };
}

/** The ⋯ menu (v1): Edit (not a grid one), Restart / Stop wisp there while online (not someone's computer), Remove. */
export function menuOf(m: PeerLike, state: string): readonly ('edit' | 'restart' | 'stop' | 'remove')[] {
  const k = kindOf(m);
  return [...(k === 'ssh' ? (['edit'] as const) : []), ...(state === 'online' && k !== 'grid' ? (['restart', 'stop'] as const) : []), 'remove'];
}

/** What Remove is called (v1): a computer leaves the grid, a cloud one signs out, an SSH one is removed. */
export function removeLabel(m: PeerLike): string {
  const k = kindOf(m);
  return k === 'grid' ? 'machines.remove.grid' : k === 'cloud' ? 'machines.remove.cloud' : 'machines.remove';
}

/** The connection's steps for the kit's Steps: a running step is current, a warning still went through. */
export function stepsOf(steps: readonly StepLike[] | undefined): KitStep[] {
  const map: Readonly<Record<string, KitStep['status']>> = { done: 'done', warn: 'done', fail: 'failed', run: 'current', pending: 'pending' };
  return (steps ?? []).map((s) => ({ title: s.label, status: map[s.status] ?? 'pending', ...(s.detail && { detail: s.detail }) }));
}

/** The trouble box's headline (v1 trouble): a lost link says it's trying again (and how often), else the hint's title. */
export function troubleTitle(s: StatusLike, say: Say): string {
  if (s.state === 'reconnecting') {
    const lost = s.error || say('machines.lost');
    return (s.attempt ?? 0) > 1 ? say('machines.retrying.n', { error: lost, attempt: s.attempt ?? 0 }) : say('machines.retrying', { error: lost });
  }
  return s.hint?.title || s.error;
}

/** The password box shows for a refused key, not while it's only retrying (v1 `h.letIn && !lost`). */
export const offersLetIn = (s: StatusLike): boolean => !!s.hint?.letIn && s.state !== 'reconnecting';

/** Hosts wisp found here that aren't added yet, at most 12 (v1 found). */
export function foundOf(hosts: readonly Found[], added: readonly PeerLike[]): Found[] {
  const have = new Set(added.map((m) => m.address));
  return hosts.filter((h) => !have.has(h.target)).slice(0, 12);
}

/** The name follows the host until one is typed (v1 input listener): a found host's name, else what's after @. */
export function nameFor(target: string, hosts: readonly Found[]): string {
  const t = target.trim();
  return (hosts.find((h) => h.target === t)?.name ?? t.replace(/^.*@/, '')).slice(0, 40) || 'devbox';
}

/** A found host's tooltip: where wisp saw it, its target and what else it knows. */
export function foundTitle(h: Found, say: Say): string {
  const src: Readonly<Record<string, string>> = { 'ssh-config': '~/.ssh/config', tailscale: 'Tailscale', 'known-hosts': say('machines.found.known') };
  return [src[h.source], h.target, h.detail].filter(Boolean).join(' · ');
}

/** The port as typed: a number in range, else wisp's own. */
export function portOf(typed: string): number {
  const n = Number(typed);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

/** Restart / Update / Stop first ask when agents are working there (v1 act): the question, or none. */
export function stopAsk(o: { readonly name: string; readonly working: number; readonly verb: 'restart' | 'update' | 'stop'; readonly version?: string }, say: Say): { title: string; body: string; ok: string; danger: boolean } | null {
  if (o.verb === 'stop') {
    const body = (o.working ? say('machines.stop.working', { count: o.working }) + ' ' : '') + say('machines.stop.body');
    return { title: say('machines.stop.ask', { name: o.name }), body, ok: say('machines.stop.ok'), danger: o.working > 0 };
  }
  if (!o.working) return null;
  const doing = o.verb === 'update' ? say('machines.update.doing', { version: o.version ?? '' }) : say('machines.restart.doing');
  return {
    title: say('machines.busy.ask', { count: o.working, name: o.name }),
    body: say('machines.busy.body', { doing, count: o.working }),
    ok: say(o.verb === 'update' ? 'machines.update.ok' : 'machines.restart.ok'),
    danger: true,
  };
}

/** Remove asks first (v1): what goes and what stays, for each kind. */
export function removeAsk(m: PeerLike, say: Say): { title: string; body: string; ok: string } {
  const k = kindOf(m);
  const vars = { name: m.name, grid: gridHost(m) };
  return { title: say(`machines.remove.${k}.ask`, vars), body: say(`machines.remove.${k}.body`, vars), ok: say(removeLabel(m)) };
}

/** The top bar's Machines (v1 paintMachinesBtn): how many, how many online, and whether one is in trouble. */
export function barOf(peers: readonly PeerLike[], statuses: readonly (StatusLike & { readonly id: string })[]): { count: number; online: number; trouble: boolean } {
  const st = (id: string): string => statuses.find((s) => s.id === id)?.state ?? 'off';
  return {
    count: peers.length,
    online: peers.filter((m) => st(m.id) === 'online').length,
    trouble: peers.some((m) => st(m.id) === 'error' || st(m.id) === 'reconnecting'),
  };
}

export interface CloudRow<P extends PeerLike> {
  readonly m: P;
  readonly state: string;
  readonly who: string;
  readonly error: string;
  readonly open: string | undefined;
  readonly wakeLine: boolean;
}

/** Settings → Cloud's cloud computers (v1 cloudPane): the grid's boxes, not your computers through it, not sandboxes. */
export function cloudBoxes<P extends PeerLike>(peers: readonly P[]): P[] {
  return peers.filter((m) => kindOf(m) === 'cloud' && !m.data?.['sandbox']).sort((a, b) => a.name.localeCompare(b.name));
}

/** The first asleep box: the only one that says to wake it first. */
export function firstAsleep(boxes: readonly PeerLike[], statuses: readonly (StatusLike & { readonly id: string })[]): string | undefined {
  return boxes.find((m) => statuses.find((s) => s.id === m.id)?.state === 'asleep')?.id;
}

/** One box's card: who and where, its error, Open's address, and whether it says wake first. */
export function cloudRow<P extends PeerLike>(m: P, s: StatusLike | undefined, asleepFirst: string | undefined): CloudRow<P> {
  const grid = str(m.data?.['grid']);
  const handle = str(m.data?.['handle']);
  const host = gridHost(m);
  return {
    m,
    state: s?.state ?? 'off',
    who: handle && !m.name.endsWith(`(${handle})`) ? `${handle} · ${host}` : host,
    error: s?.hint?.title ? `${s.hint.title}${s.hint.text ? ` · ${s.hint.text}` : ''}` : (s?.error ?? ''),
    open: grid ? `${grid.replace(/\/$/, '')}/go` : undefined,
    wakeLine: m.id === asleepFirst,
  };
}

export function cloudOf<P extends PeerLike>(peers: readonly P[], statuses: readonly (StatusLike & { readonly id: string })[]): CloudRow<P>[] {
  const boxes = cloudBoxes(peers);
  const first = firstAsleep(boxes, statuses);
  return boxes.map((m) => cloudRow(m, statuses.find((s) => s.id === m.id), first));
}
