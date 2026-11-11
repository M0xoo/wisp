// A crew member asked in a task (v1 btw.js crew entries, crew.js replyIn): a reply that starts with @a member is
// for them, not the task's agent; their answer shows under the turn it was asked on, and a reply to it carries on
// the same job. Pure: the reply box's text in, who it's for out; a turn row in, its answers out.

/** One answer as wisp.crew keeps it on the asking turn (`ext["wisp.crew"].answers`, crew api `CrewAnswer`). */
export interface CrewAnswer {
  readonly id: string;
  readonly crew: string;
  readonly member: string;
  readonly job?: string;
  readonly question: string;
  readonly answer: string;
  readonly status: 'running' | 'done' | 'error';
  readonly thread?: string;
  readonly askedAt: number;
  readonly answeredAt?: number;
}

const LEAD = /^\s*@\[([^\]\n]*)\]\(crew:([^)\s]+)\)[\s,:]*/;

/**
 * The members a reply starts with (`@[Ada](crew:id), @[Bo](crew:id2) check this`) and the words for them; `null`
 * when it doesn't start with a member (it goes to the task's agent), or nothing's left to ask.
 */
export function askedOf(text: string): { readonly ids: readonly string[]; readonly question: string } | null {
  const ids: string[] = [];
  let rest = text;
  for (let m = LEAD.exec(rest); m; m = LEAD.exec(rest)) {
    const id = m[2] ?? '';
    if (id && !ids.includes(id)) ids.push(id);
    rest = rest.slice(m[0].length);
  }
  const question = rest.trim();
  return ids.length > 0 && question ? { ids, question } : null;
}

/** A turn row's answers (the row's own fields, or its `body`), in the order kept. */
export function answersOf(row: unknown): readonly CrewAnswer[] {
  if (!row || typeof row !== 'object') return [];
  const r = row as { body?: { ext?: Record<string, unknown> }; ext?: Record<string, unknown> };
  const slot = (r.body?.ext ?? r.ext)?.['wisp.crew'] as { answers?: unknown } | undefined;
  return Array.isArray(slot?.answers) ? (slot.answers as CrewAnswer[]) : [];
}

/** Whether `a` continues an earlier entry (it's shown indented under it, without the member's head again). */
export const isReply = (a: CrewAnswer): boolean => !!a.thread && a.thread !== a.id;

/** Asks each member the words after them (`crew.ask`): their job, their answer under the task's latest turn. */
export function askAll(asked: { readonly ids: readonly string[]; readonly question: string }, ask: (id: string, question: string) => void): void {
  for (const id of asked.ids) ask(id, asked.question);
}
