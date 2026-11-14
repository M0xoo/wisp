// Sandboxes as the app shows them (ADR-0047). Pure: `/sandbox …` read off New task's text, an owner said in words,
// and which machines are sandboxes.

/** `/sandbox <what to do>`: the task's prompt, or null when the text isn't one ('' when nothing came after it). */
export function sandboxPrompt(text: string): string | null {
  const m = /^\/sandbox(?:\s+([\s\S]*))?$/i.exec(text.trimStart());
  if (!m) return null;
  return (m[1] ?? '').trim();
}

/** A sandbox's owner (wisp-sandbox-core `Owner`), as stored on its machine. */
export type Owner =
  | { readonly task: string }
  | { readonly pending: number }
  | { readonly lead: string; readonly member: string }
  | { readonly crew: string; readonly job: string }
  | { readonly crew: string }
  | { readonly judges: string };

export type Say = (key: string, vars?: Readonly<Record<string, string | number>>) => string;

/** Whose it is, in words: a task's, a delegate's, a crew job's or member's own, a goal's judges'. */
export function ownerWords(owner: unknown, say: Say, name: (crewId: string) => string = (c) => c): string {
  const o = (owner ?? {}) as Record<string, unknown>;
  if (typeof o['task'] === 'string') return say('sandbox.owner.task');
  if (typeof o['pending'] === 'number') return say('sandbox.owner.pending');
  if (typeof o['lead'] === 'string') return say('sandbox.owner.delegate', { member: String(o['member'] ?? '') });
  if (typeof o['crew'] === 'string' && typeof o['job'] === 'string') return say('sandbox.owner.job', { name: name(o['crew'] as string) });
  if (typeof o['crew'] === 'string') return say('sandbox.owner.member', { name: name(o['crew'] as string) });
  if (typeof o['judges'] === 'string') return say('sandbox.owner.judges');
  return say('sandbox.owner.none');
}

/** The task a sandbox belongs to, when it's a task's (to open it). */
export const ownerTask = (owner: unknown): string | undefined => {
  const t = (owner as { task?: unknown } | null)?.task;
  return typeof t === 'string' && t ? t : undefined;
};
