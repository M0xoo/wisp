// The task rows a pane's calls read (light.ts), from the runtime's `session` rows ({id, title, state, agent, summary,
// body}) and the projects (which one holds the task's folder). DOM-free.
import type { TaskRow } from '../types.ts';

export interface SessionLike {
  readonly id: string;
  readonly title?: string;
  readonly state?: string;
  readonly agent?: string;
  readonly archived?: boolean;
  readonly unread?: boolean;
  readonly pending?: boolean;
  readonly parent_id?: string | null;
  readonly created_at?: number;
  readonly updated_at?: number;
  readonly summary?: Readonly<Record<string, unknown>>;
  readonly body?: Readonly<Record<string, unknown>>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** The bare id a pane names a task by (the store's key has its peer in front). */
export const bareId = (id: string): string => id.slice(id.indexOf(':') + 1);

/** A runtime row as a pane's call reads it; `project` names the project holding its folder. A subagent isn't a task here. */
export function taskOfRow(r: SessionLike, project: (cwd: string) => string | undefined): TaskRow | undefined {
  if (r.parent_id) return undefined;
  const s = r.summary ?? {};
  const cwd = str(s['cwd']) ?? str(r.body?.['cwd']) ?? '';
  const ext = (r.body?.['ext'] as Readonly<Record<string, unknown>> | undefined) ?? {};
  const crew = ext['wisp.crew'] as { id?: unknown; name?: unknown } | undefined;
  const pr = s['pr'] as TaskRow['pr'] | undefined;
  // a Make a pane task is kind `pane` (wisp.stuff's ext); a spell being cast is left out of the list (light.ts)
  const kind = ext['wisp.stuff'] ? 'pane' : str(r.body?.['kind']);
  return {
    id: bareId(r.id),
    title: r.title ?? '',
    state: r.state ?? '',
    status: str(s['status']) ?? '',
    project: project(cwd) ?? '',
    agent: r.agent ?? '',
    model: str(s['model']) ?? '',
    mode: str(s['mode']) ?? '',
    branch: str(s['branch']) ?? '',
    preview: str(s['preview']) ?? '',
    live: str(s['live']) ?? '',
    unread: !!r.unread,
    archived: !!r.archived,
    asks: !!s['question'] || !!s['ask'],
    ...(r.pending && { pending: true }),
    ...(kind && { kind }),
    ...(typeof crew?.id === 'string' && { crew: { id: crew.id, name: typeof crew.name === 'string' ? crew.name : crew.id } }),
    ...(pr && typeof pr === 'object' && typeof (pr as { url?: unknown }).url === 'string' && { pr }),
    ...(r.created_at !== undefined && { createdAt: r.created_at }),
    ...(r.updated_at !== undefined && { updatedAt: r.updated_at }),
  };
}
