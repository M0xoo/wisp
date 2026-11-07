// The crew as the screens read it: members from the entity store (topic `crew`), their jobs from
// the task list (topic `list`), and what each is up to. Selectors only: one per plugin client,
// incremental where it matters (filterBy patches in place when a token updates one of 5,000 tasks,
// so the crew's own work stays proportional to its few dozen jobs).

import { computed, filterBy, groupBy, ownerOf, type EntityKey, type PeerId, type PluginClient, type Readable } from '@wisp/client';
import { rankCrew } from './model.ts';
import { memberState, type MemberState } from './rules/feed.ts';
import { KIND, type MemberView, type SessionRow } from './types.ts';

/** A member row with the key the store holds it under (its peer is the key's prefix). */
export type CrewMember = MemberView & { readonly key: EntityKey; readonly peer: PeerId };

export interface CrewData {
  readonly members: Readable<readonly CrewMember[]>;
  /** every task that is a crew job (the list's rows with `crew`) */
  readonly jobs: Readable<readonly SessionRow[]>;
  readonly states: Readable<ReadonlyMap<string, MemberState<SessionRow>>>;
  /** most-needed first */
  readonly ranked: Readable<readonly CrewMember[]>;
  byId(id: string | undefined): CrewMember | undefined;
  /** the task row's key, for opening it and for commands */
  sessionKey(id: string): EntityKey | undefined;
}

const made = new WeakMap<PluginClient, CrewData>();

const EMPTY: MemberState<SessionRow> = { jobs: [], sent: [], asks: false, live: [], unread: 0, mood: 'idle' };
export const emptyState = (paused: boolean): MemberState<SessionRow> => ({ ...EMPTY, mood: paused ? 'sleep' : 'idle' });

export function crewData(client: PluginClient): CrewData {
  const had = made.get(client);
  if (had) return had;
  const e = client.entities;
  const keys = e.keys(KIND.member);
  const rows = e.list<MemberView>(KIND.member);
  const members = computed(() => {
    const ks = keys();
    return rows().map((v, i) => {
      const key = ks[i] as EntityKey;
      return { ...(v as MemberView), key, peer: ownerOf(key) } as CrewMember;
    });
  });
  const sessions = e.list<SessionRow>(KIND.session) as Readable<readonly SessionRow[]>;
  const jobs = filterBy(sessions, (s) => !!s.crew);
  const byCrew = groupBy(jobs, (s) => s.crew?.id ?? '');
  const states = computed(() => {
    const g = byCrew();
    return new Map(members().map((m) => [m.id, memberState(m, g.get(m.id) ?? [])]));
  });
  const ranked = computed(() => rankCrew(members(), states(), client.scope.timers.now()));
  const sessionKeys = e.keys(KIND.session);
  const data: CrewData = {
    members,
    jobs,
    states,
    ranked,
    byId: (id) => (id ? members().find((m) => m.id === id || m.key === id) : undefined),
    sessionKey: (id) => sessionKeys().find((k) => k === id || k.endsWith(`:${id}`)),
  };
  made.set(client, data);
  return data;
}
