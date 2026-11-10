// The crew's second half writes through these (ids from v1's routes, as the reference port named
// them: git show v2-ts-server-reference:plugins/crew/api/src/index.ts COMMANDS). Each carries the
// member's entity key (`key`) so the command goes to the peer that owns it and the optimistic
// patch lands on the right row; the peer reads `id` and the body.

import { defineCommand, type EntityKey, type EntityOps } from '@wisp/client';
import { KIND } from '../types.ts';
import type { ExportAnswer, ImportChoice, ImportPreview, LocalKit, Member, MemberView } from './types.ts';

/** The fields of a member this half changes. */
export type MemberBody = Partial<Pick<Member, 'kit' | 'notebook' | 'team' | 'offers'>>;

const replaceOps = (key: EntityKey, body: MemberBody): EntityOps => [
  { e: KIND.member, id: key, op: 'patch', ops: Object.entries(body).map(([k, v]) => ({ op: 'replace' as const, path: `/${k}`, value: v })) },
];

/** crew.update: the member's kit, notebook, delegates or offers. The row changes at once. */
export const updateMember = defineCommand<{ key: EntityKey; id: string } & MemberBody, MemberView>({
  id: 'crew.update',
  owner: (a) => a.key,
  optimistic: (base, a) => {
    const { key, id: _id, ...body } = a;
    return base.peek(KIND.member, key) ? replaceOps(key, body) : [];
  },
});

/** crew.kit: skills and instructions files on the member's computer (read-only). */
export const localKit = defineCommand<{ key: EntityKey; cwd?: string }, LocalKit>({
  id: 'crew.kit',
  owner: (a) => a.key,
  wire: (a) => ({ cwd: a.cwd ?? '' }),
  optimistic: 'none', pending: 'the crew.kit control',
  dedupe: (a) => `localKit:${a.key}:${a.cwd ?? ''}`,
});

/** crew.assign with kit: the member studies its job and proposes its own files (an offer). */
export const kitJob = defineCommand<{ key: EntityKey; crewId: string; prompt: string; kit: true }, { session?: string; queued?: boolean }>({
  id: 'crew.assign',
  owner: (a) => a.key,
  optimistic: 'none', pending: 'the crew.assign control',
});

/** crew.export: the bundle for these options, checked by the peer (its secret scan refuses it). */
export const exportCrew = defineCommand<{ peer: string; ids: string[]; kit: boolean; notebook: boolean; team: boolean; gist?: boolean }, ExportAnswer>({
  id: 'crew.export',
  owner: (a) => a.peer,
  wire: ({ peer: _p, ...rest }) => rest,
  optimistic: 'none', pending: 'the crew.export control',
});

/** crew.import with dryRun: who a bundle (text, a link or gist:<id>) brings, and what changed on the way in. */
export const reviewImport = defineCommand<{ peer: string; text?: string; url?: string; dryRun: true }, ImportPreview>({
  id: 'crew.import',
  owner: (a) => a.peer,
  wire: ({ peer: _p, ...rest }) => rest,
  optimistic: 'none', pending: 'the crew.import control',
});

/** A member about to join, shown at once while the import runs. */
export interface Joining {
  key: string;
  name: string;
  role: string;
  avatar: string;
  color: string;
  cwd: string;
}

/**
 * crew.import: they join the crew, paused, under the names and projects picked. `joining` is what
 * shows at once (placeholder rows `<peer>:new-<key>`); the overlay goes when the peer's rows land.
 */
export const runImport = defineCommand<{ peer: string; text?: string; url?: string; choices: Record<string, ImportChoice>; joining: Joining[] }, { members: MemberView[] }>({
  id: 'crew.import',
  owner: (a) => a.peer,
  wire: ({ peer: _p, joining: _j, ...rest }) => rest,
  optimistic: (_base, a) =>
    a.joining.map((j) => ({
      e: KIND.member,
      id: `${a.peer}:new-${j.key}` as EntityKey,
      op: 'upsert' as const,
      v: { id: `new-${j.key}`, name: j.name, role: j.role, avatar: j.avatar, color: j.color, cwd: j.cwd, paused: true, kit: [], team: [], offers: [], log: [], queue: [], links: [], notebook: '', running: 0, jobs: 0 },
    })),
});
