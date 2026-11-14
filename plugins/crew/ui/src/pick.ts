// The rail's pick (design/crew.md "The pick"): which member the list beside the rail shows, kept
// across reloads. Only with the rail: stacked, a saved pick waits unused. Until the crew is known
// it holds, so a reload doesn't flash the whole list; a removed member falls back to All.
// The list itself filters through the shell-list's filter point with `inPick` (rules/feed.ts).

import { computed, type PluginClient, type PluginStore, type Readable } from '@wisp/client';
import { crewData } from './data.ts';
import { navOf } from './host.ts';
import { crewPick, pickFace } from './rules/feed.ts';

export interface Pick {
  /** the saved pick (a member id) or null for All */
  readonly saved: PluginStore<{ id: string | null }>;
  /** the pick as it applies now: null without the rail, or once its member is gone */
  readonly current: Readable<string | null>;
  set(id: string | null): void;
  /** a face: picks its member, or back to All when it's the picked one */
  face(id: string): string | null;
}

const made = new WeakMap<PluginClient, Pick>();

export function pickOf(client: PluginClient): Pick {
  const had = made.get(client);
  if (had) return had;
  const saved = client.defineStore<{ id: string | null }>({
    id: 'wisp.crew.pick',
    version: 1,
    defaults: { id: null },
    persist: true,
    check: (v) => (v && typeof v === 'object' && 'id' in v && (typeof v.id === 'string' || v.id === null) ? { id: v.id } : undefined),
  });
  const data = crewData(client);
  const nav = navOf(client);
  const current = computed(() => crewPick(saved.value().id, { railOn: nav().layout === 'split', members: data.members().length ? data.members() : undefined }));
  const p: Pick = {
    saved,
    current,
    set: (id) => saved.set({ id }),
    face(id) {
      const next = pickFace(current(), id);
      saved.set({ id: next });
      return next;
    },
  };
  made.set(client, p);
  return p;
}
