// A crew job as the screens read it (types.ts SessionRow), from the task row the peer sends: runtime's
// `session` row ({id, title, state, agent, created_at, updated_at, summary, body}) with whose job it is in
// `body.ext["wisp.crew"]` (the crew's CrewExt, plugins/crew/api). The list's pending row (crew.assign's
// optimistic patch) is in the same shape. DOM-free.
import type { CrewExt, SessionRow } from './types.ts';

interface PeerRow {
  readonly id: string;
  readonly title?: string;
  readonly state?: string;
  readonly agent?: string;
  readonly archived?: boolean;
  readonly unread?: boolean;
  readonly parent_id?: string | null;
  readonly created_at?: number;
  readonly updated_at?: number;
  readonly summary?: Readonly<Record<string, unknown>>;
  readonly body?: Readonly<Record<string, unknown>>;
  /** a row in the screens' own shape already (v1-shaped dev data) */
  readonly crew?: unknown;
  readonly createdAt?: number;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** The job on a task row, or undefined when it isn't one. */
export function jobOf(r: PeerRow): SessionRow | undefined {
  if (r.crew) return r as unknown as SessionRow;
  const ext = (r.body?.['ext'] as Readonly<Record<string, unknown>> | undefined)?.['wisp.crew'] as CrewExt | undefined;
  if (!ext || typeof ext !== 'object' || !ext.id) return undefined;
  const s = r.summary ?? {};
  const question = str(s['question']) ?? str((s['ask'] as { question?: unknown } | undefined)?.question);
  const created = r.created_at ?? 0;
  const live = str(s['live']);
  const status = str(s['status']);
  const preview = str(s['preview']);
  const prompt = str((ext as { prompt?: unknown }).prompt);
  const forLater = s['forLater'] === true ? { at: r.updated_at ?? created } : undefined;
  return {
    id: r.id,
    title: r.title ?? '',
    agent: r.agent ?? '',
    cwd: str(s['cwd']) ?? str(r.body?.['cwd']) ?? '',
    state: r.state ?? 'idle',
    ...(status && { status }),
    ...(r.unread && { unread: true }),
    ...(r.archived && { archived: true }),
    ...(s['pending'] === true && { pending: true }),
    createdAt: created,
    updatedAt: r.updated_at ?? created,
    ...(preview && { preview }),
    ...(live && { live }),
    ...(question && { question }),
    ...(forLater && { forLater }),
    ...(r.parent_id && { parentId: r.parent_id }),
    crew: {
      id: ext.id,
      job: ext.job,
      ...(ext.from && { from: ext.from }),
      ...(ext.event && { event: ext.event }),
      ...(ext.kit && { kit: true }),
      ...(ext.sent && { sent: ext.sent }),
      ...(prompt && { prompt }),
    },
  };
}

/** The prompt a job was given: the crew's note of it, else the task's first prompt. */
export const promptOf = (r: SessionRow, first: string | undefined): string | undefined => r.crew?.prompt ?? first;
