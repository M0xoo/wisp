// The goal UI's own state. The launcher's Goal (on or off) and its judges survive a reload (v1 kept
// them in defaults.goalJudges / goalVote and the home-goal draft); which reply boxes have their
// Done when line open is UI state for this run only. The Done when texts are drafts (the drafts
// store), keyed by the box they belong to.

import type { Json, PluginClient, PluginStore, Scope } from '@wisp/client';
import { VOTES, type Judge, type Vote } from './types.ts';

export interface LauncherGoal {
  on: boolean;
  judges: Judge[];
  vote: Vote;
}

interface Stores {
  readonly launcher: PluginStore<Json>;
  readonly lines: PluginStore<Json>;
}

const isJudge = (j: unknown): j is Judge => {
  if (!j || typeof j !== 'object') return false;
  const o = j as Record<string, unknown>;
  return typeof o['crew'] === 'string' || (typeof o['agent'] === 'string' && typeof o['model'] === 'string' && typeof o['effort'] === 'string');
};

export function checkLauncher(v: unknown): LauncherGoal | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o['on'] !== 'boolean' || !Array.isArray(o['judges']) || !VOTES.includes(o['vote'] as Vote)) return undefined;
  return { on: o['on'], judges: o['judges'].filter(isJudge), vote: o['vote'] as Vote };
}

const LAUNCHER_DEFAULTS: LauncherGoal = { on: false, judges: [], vote: 'majority' };

// one set per plugin scope: every component of this plugin shares them
const stores = new WeakMap<Scope, Stores>();

function storesOf(client: PluginClient): Stores {
  let s = stores.get(client.scope);
  if (!s) {
    s = {
      launcher: client.defineStore<Json>({
        id: 'wisp.goal.launcher',
        version: 1,
        defaults: LAUNCHER_DEFAULTS as unknown as Json,
        check: (v) => checkLauncher(v) as unknown as Json | undefined,
        persist: true,
      }),
      lines: client.defineStore<Json>({
        id: 'wisp.goal.lines',
        version: 1,
        defaults: [],
        check: (v) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : undefined),
      }),
    };
    stores.set(client.scope, s);
  }
  return s;
}

export function launcherGoal(client: PluginClient): { get(): LauncherGoal; set(next: Partial<LauncherGoal>): void } {
  const s = storesOf(client).launcher;
  return {
    get: () => (checkLauncher(s.value()) ?? LAUNCHER_DEFAULTS),
    set: (next) => s.set((cur) => ({ ...(checkLauncher(cur) ?? LAUNCHER_DEFAULTS), ...next }) as unknown as Json),
  };
}

/** Which reply boxes (by task key) have their Done when line open. */
export function replyLines(client: PluginClient): { open(key: string): boolean; set(key: string, on: boolean): void } {
  const s = storesOf(client).lines;
  const list = (): readonly string[] => (Array.isArray(s.value()) ? (s.value() as readonly string[]) : []);
  return {
    open: (key) => list().includes(key),
    set: (key, on) => s.set(() => (on ? [...list().filter((k) => k !== key), key] : list().filter((k) => k !== key))),
  };
}

/** The drafts the Done when lines write to: the launcher's, and one per reply box. */
export const DRAFT = { launcher: ['launcher', 'goal'], reply: (key: string) => [key, 'goal'] } as const;
