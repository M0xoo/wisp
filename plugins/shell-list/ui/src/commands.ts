// Every write the list makes, as a command with its optimistic patch (ADR-0006): the row changes at
// once, the peer that owns the task runs it, and a refusal rolls the patch back with a toast. The
// ids and argument shapes are wisp.runtime's (plugins/runtime/api/src/commands.rs): rename, archive,
// markRead, setState, delete. Save for later and pin are fields other plugins own on the summary
// (`forLater`, `pinned`), written through runtime.setExt, which sets one such field.

import { defineCommand, type EntityKey, type EntityOps, type EntityReader } from '@wisp/client';
import type { PatchOp } from '@wisp/protocol';
import { KIND, type Session, type SessionRow } from './types.ts';

const RUNTIME = 'wisp.runtime';
const row = (base: EntityReader, id: EntityKey): SessionRow | undefined => base.peek<Session>(KIND.session, id);
const patch = (id: EntityKey, ops: PatchOp[]): EntityOps => (ops.length ? [{ e: KIND.session, id, op: 'patch', ops }] : []);

/** Sets or clears an optional field, with the op JSON Patch needs for what's there now. */
function setField(s: SessionRow | undefined, field: keyof Session, value: unknown): PatchOp[] {
  const has = s !== undefined && s[field] !== undefined;
  if (value === undefined || value === null) return has ? [{ op: 'remove', path: `/${field}` }] : [];
  return [{ op: has ? 'replace' : 'add', path: `/${field}`, value }];
}

export const rename = defineCommand<{ id: EntityKey; title: string }>({
  id: 'runtime.rename',
  owner: (a) => a.id,
  optimistic: (base, a) => (row(base, a.id) ? patch(a.id, [{ op: 'replace', path: '/title', value: a.title }]) : []),
  feature: { plugin: RUNTIME, command: 'runtime.rename', label: 'Rename' },
});

/** Archiving also marks it read (server/routes/sessions.js:327). */
export const archive = defineCommand<{ id: EntityKey; archived: boolean }>({
  id: 'runtime.archive',
  owner: (a) => a.id,
  optimistic: (base, a) => {
    const s = row(base, a.id);
    if (!s) return [];
    return patch(a.id, [...setField(s, 'archived', a.archived), ...(a.archived && s.unread ? setField(s, 'unread', false) : [])]);
  },
  feature: { plugin: RUNTIME, command: 'runtime.archive', label: 'Archive' },
});

export const markRead = defineCommand<{ id: EntityKey; unread: boolean }>({
  id: 'runtime.markRead',
  owner: (a) => a.id,
  optimistic: (base, a) => {
    const s = row(base, a.id);
    return s && !!s.unread !== a.unread ? patch(a.id, setField(s, 'unread', a.unread)) : [];
  },
  feature: { plugin: RUNTIME, command: 'runtime.markRead', label: 'Mark read' },
});

/** Mark done (`done`) and Reopen (`review`). Any state change takes it out of For later (sessions.js:332). */
export const setState = defineCommand<{ id: EntityKey; state: 'done' | 'review' }>({
  id: 'runtime.setState',
  owner: (a) => a.id,
  optimistic: (base, a) => {
    const s = row(base, a.id);
    if (!s) return [];
    return patch(a.id, [{ op: 'replace', path: '/state', value: a.state }, ...setField(s, 'forLater', undefined)]);
  },
  feature: { plugin: RUNTIME, command: 'runtime.setState', label: 'Mark done' },
});

export const remove = defineCommand<{ id: EntityKey }>({
  id: 'runtime.delete',
  owner: (a) => a.id,
  optimistic: (base, a) => (row(base, a.id) ? [{ e: KIND.session, id: a.id, op: 'del' }] : []),
  feature: { plugin: RUNTIME, command: 'runtime.delete', label: 'Delete task' },
});

/** One summary field another plugin owns (`forLater`, `pinned`); `null` clears it. */
export const setExt = defineCommand<{ id: EntityKey; plugin: 'forLater' | 'pinned'; value: { at: number; by: 'user' } | true | null }>({
  id: 'runtime.setExt',
  owner: (a) => a.id,
  optimistic: (base, a) => patch(a.id, setField(row(base, a.id), a.plugin, a.value)),
  feature: { plugin: RUNTIME, command: 'runtime.setExt', label: 'Save for later' },
});

export const COMMANDS = [rename, archive, markRead, setState, remove, setExt] as const;
