// The mock peer's commands, named and shaped as the Rust plugins declare them
// (plugins/runtime/api/src/commands, the settings plugin). A handler reads the current rows and
// returns the ops one commit makes; throwing `{ code, message }` refuses the command (the client
// rolls its optimistic patch back and toasts the message). UI agents: add the commands your screen
// sends here, with the args the plugin's api crate has.

import type { EntityOp, PatchOp, Topic } from '@wisp/protocol';

export interface CommandCtx {
  readonly peer: string;
  now(): number;
  row(topic: Topic, e: string, id: string): unknown;
  rows(topic: Topic): readonly { e: string; id: string; v: unknown }[];
  /** starts a streaming turn in the session */
  stream(id: string): void;
  /** a commit `ms` from now (a delayed effect) */
  later(ms: number, ops: () => EntityOp[]): void;
}

export type CommandFn = (args: unknown, ctx: CommandCtx) => { ops: EntityOp[]; result?: unknown };

type Args = Record<string, unknown>;
const obj = (a: unknown): Args => (typeof a === 'object' && a !== null ? (a as Args) : {});
const refuse = (code: string, message: string): never => {
  throw { code, message };
};
const str = (a: Args, k: string): string => {
  const v = a[k];
  return typeof v === 'string' && v !== '' ? v : refuse('invalid', `${k} is required`);
};

/** The session's rows live on `list` and on its own topic: a change to it goes to both. */
function sessionPatch(ctx: CommandCtx, id: string, ops: PatchOp[]): EntityOp[] {
  if (ctx.row('list', 'session', id) === undefined) refuse('not_found', `no task ${id}`);
  const out: EntityOp[] = [{ topic: 'list', e: 'session', id, op: 'patch', ops }];
  if (ctx.row(`session:${id}`, 'session', id) !== undefined) out.push({ topic: `session:${id}`, e: 'session', id, op: 'patch', ops });
  return out;
}

const touch = (ctx: CommandCtx): PatchOp => ({ op: 'replace', path: '/updated_at', value: ctx.now() });

export const COMMANDS: Record<string, CommandFn> = {
  'runtime.rename': (a, ctx) => {
    const x = obj(a);
    const title = str(x, 'title').trim();
    if (title.length > 200) refuse('invalid', 'A title is at most 200 characters');
    return { ops: sessionPatch(ctx, str(x, 'id'), [{ op: 'replace', path: '/title', value: title }]) };
  },
  'runtime.archive': (a, ctx) => {
    const x = obj(a);
    return { ops: sessionPatch(ctx, str(x, 'id'), [{ op: 'replace', path: '/archived', value: x['archived'] === true }, touch(ctx)]) };
  },
  'runtime.markRead': (a, ctx) => {
    const x = obj(a);
    return { ops: sessionPatch(ctx, str(x, 'id'), [{ op: 'replace', path: '/unread', value: x['unread'] === true }]) };
  },
  'runtime.setState': (a, ctx) => {
    const x = obj(a);
    const state = str(x, 'state');
    if (!['running', 'review', 'done', 'error'].includes(state)) refuse('invalid', `state is running, review, done or error`);
    return { ops: sessionPatch(ctx, str(x, 'id'), [{ op: 'replace', path: '/state', value: state }, touch(ctx)]) };
  },
  'runtime.delete': (a, ctx) => {
    const id = str(obj(a), 'id');
    if (ctx.row('list', 'session', id) === undefined) refuse('not_found', `no task ${id}`);
    const own: Topic = `session:${id}`;
    return { ops: [{ topic: 'list', e: 'session', id, op: 'del' }, ...ctx.rows(own).map((r): EntityOp => ({ topic: own, e: r.e, id: r.id, op: 'del' }))] };
  },
  'runtime.stop': (a, ctx) => ({ ops: sessionPatch(ctx, str(obj(a), 'id'), [{ op: 'replace', path: '/state', value: 'review' }, { op: 'replace', path: '/summary/live', value: '' }]) }),
  'runtime.followUp': (a, ctx) => {
    const x = obj(a);
    const id = str(x, 'id');
    str(x, 'text');
    const ops = sessionPatch(ctx, id, [touch(ctx)]);
    ctx.stream(id);
    return { ops, result: { queued: false } };
  },
  'runtime.create': (a, ctx) => {
    const x = obj(a);
    const prompt = typeof x['prompt'] === 'string' ? x['prompt'] : str(x, 'text');
    const at = ctx.now();
    const id = `${ctx.peer}:${at.toString(36)}`;
    const row = {
      id, parent_id: null, title: prompt.split('\n')[0]?.slice(0, 80) ?? 'New task', state: 'running', agent: typeof x['agent'] === 'string' ? x['agent'] : 'claude',
      archived: false, unread: false, created_at: at, updated_at: at, rev: 1,
      summary: { status: 'running', turnCount: 1, queued: 0, preview: prompt.slice(0, 80), live: 'Starting…', cwd: typeof x['cwd'] === 'string' ? x['cwd'] : '~/code/wisp', model: 'claude-opus-5-5', mode: 'auto' },
      body: {},
    };
    ctx.later(10, () => {
      ctx.stream(id);
      return [];
    });
    return { ops: [{ topic: 'list', e: 'session', id, op: 'upsert', v: row }, { topic: `session:${id}`, e: 'session', id, op: 'upsert', v: row }], result: { id } };
  },
  'settings.set': (a, ctx) => {
    const x = obj(a);
    const key = str(x, 'key');
    const prev = obj(ctx.row('config', 'setting', key));
    if (typeof prev['locked_by'] === 'string') refuse('forbidden', `${key} is set by ${prev['locked_by']}`);
    return { ops: [{ topic: 'config', e: 'setting', id: key, op: 'upsert', v: { key, value: x['value'] ?? null, locked_by: null } }] };
  },
  'stuff.delete': (a, ctx) => {
    const id = str(obj(a), 'id');
    if (ctx.row('stuff', 'stuff', id) === undefined) refuse('not_found', `nothing saved as ${id}`);
    return { ops: [{ topic: 'stuff', e: 'stuff', id, op: 'del' }] };
  },
};
