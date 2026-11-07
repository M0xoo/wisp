// What a pane may use, and where it's pinned (v1 pane-bridge.js): the grant rules and the `panes`
// setting ("<app>@task,<app>@home"), pure.

import type { Item, PanePin, PaneWhere } from '../types.ts';
import { MAX_PANES, PANE_WHERE, WRITE_USES } from './bridge.ts';

/** What a grant may hold: only what the app asks for, each once, in the order asked. */
export const grantOf = (uses: readonly string[] = [], want: unknown = []): string[] =>
  Array.isArray(want) ? (want as unknown[]).filter((x, i, a): x is string => typeof x === 'string' && uses.includes(x) && a.indexOf(x) === i) : [];

/** What the app asks for that you haven't allowed yet. */
export const missingOf = (it: Pick<Item, 'uses' | 'allowed'> | null | undefined): string[] =>
  (it?.uses ?? []).filter((x) => !(it?.allowed ?? []).includes(x));

/**
 * What a stored grant is worth now. A write scope holds only for the code you allowed: while the
 * app's hash differs (or there's none) the write scopes are off and `changed` says so.
 */
export function effectiveGrant(allowed: readonly string[] | undefined = [], grantHash = '', hashNow = ''): { allowed: string[]; changed: boolean } {
  const list = [...(allowed ?? [])];
  const tied = list.some((x) => (WRITE_USES as readonly string[]).includes(x));
  if (!tied || (grantHash && grantHash === hashNow)) return { allowed: list, changed: false };
  return { allowed: list.filter((x) => !(WRITE_USES as readonly string[]).includes(x)), changed: true };
}

/** A task a pane may not gain a scope under: it's running in Full auto, nobody reads cards. */
export const runsFullAuto = (s: { mode?: string; state?: string; status?: string; turns?: readonly { status?: string }[] } | null | undefined): boolean =>
  !!s && s.mode === 'auto' && (s.state === 'running' || s.status === 'running' || s.turns?.at(-1)?.status === 'running');

/** Has the app moved on from what its pane loaded? rev goes up on every update and restore. */
export const paneStale = (seen: number | undefined, it: Pick<Item, 'rev'> | null | undefined): boolean =>
  seen !== undefined && !!it && (it.rev ?? 1) !== seen;

/** The i18n key of the bar's words for what the app still asks for, or '' when it has it all. */
export function paneNeed(it: Pick<Item, 'uses' | 'allowed' | 'changed'>): string {
  if (!missingOf(it).length) return '';
  return it.changed ? 'stuff.pane.need.changed' : it.allowed?.length ? 'stuff.pane.need.some' : 'stuff.pane.need.none';
}

export interface LaunchDefaults {
  agent?: string;
  mode?: string;
  model?: string;
  effort?: string;
  account?: string;
  worktree?: string;
}

/** The task a pane starts: as New task sends it, on your defaults (never the server's Full auto fallback). */
export function launchBody(d: LaunchDefaults, prompt: string, project: { path: string } | null): Record<string, unknown> {
  return { prompt, ...(project ? { cwd: project.path } : { scratch: true }), agent: d.agent, mode: d.mode, model: d.model, effort: d.effort, account: d.account || undefined, worktree: d.worktree === 'off' ? false : undefined };
}

// --- the pins -------------------------------------------------------------------------------------

export function parsePanes(v: unknown): PanePin[] {
  if (typeof v !== 'string' || !v.trim()) return [];
  return v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const i = x.lastIndexOf('@');
      return i > 0 ? { app: x.slice(0, i).trim(), where: x.slice(i + 1).trim() as PaneWhere } : { app: x, where: 'task' };
    });
}

export const panesString = (pins: readonly PanePin[]): string => pins.map((p) => `${p.app}@${p.where}`).join(',');

/** Why a `panes` value can't be kept, or ''. */
export function panesProblem(v: unknown): string {
  if (typeof v !== 'string') return 'panes is a string like "kanban@home,pr-notes@task".';
  if (v.length > 1000) return 'panes is too long.';
  const pins = parsePanes(v);
  if (pins.length > MAX_PANES) return `At most ${MAX_PANES} panes.`;
  const bad = pins.find((p) => !(PANE_WHERE as readonly string[]).includes(p.where) || !p.app || /[,@<>"]/.test(p.app));
  return bad ? `panes: "${bad.app}@${bad.where}" should be <app id or name>@task or @home.` : '';
}

/** Which of My Stuff's apps a pin means: its id, else its name or title (any case). */
export function appFor<T extends Pick<Item, 'id' | 'kind' | 'name' | 'title' | 'pending'>>(pin: PanePin, items: readonly T[]): T | null {
  const apps = items.filter((x) => x.kind === 'app' && !x.pending);
  const k = pin.app.toLowerCase();
  return apps.find((x) => x.id === pin.app) ?? apps.find((x) => x.name.toLowerCase() === k || x.title.toLowerCase() === k) ?? null;
}

/** The apps pinned at a place, in their order, each once; a pin naming nothing in My Stuff is left out. */
export function panesAt<T extends Pick<Item, 'id' | 'kind' | 'name' | 'title' | 'pending'>>(setting: unknown, where: PaneWhere, items: readonly T[]): T[] {
  const out: T[] = [];
  for (const pin of parsePanes(setting)) {
    if (pin.where !== where) continue;
    const it = appFor(pin, items);
    if (it && !out.some((x) => x.id === it.id)) out.push(it);
  }
  return out;
}

/** The setting with this app pinned (or unpinned) at `where`: other pins keep their order. */
export function withPin<T extends Pick<Item, 'id' | 'kind' | 'name' | 'title' | 'pending'>>(setting: unknown, it: T, where: PaneWhere, on: boolean, items: readonly T[]): string {
  const rest = parsePanes(setting).filter((p) => !(p.where === where && appFor(p, items)?.id === it.id));
  return panesString(on ? [...rest, { app: it.id, where }] : rest);
}
