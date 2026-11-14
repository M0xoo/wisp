// The follow-up queue (v1 queued.js, server/runner.js): pure list operations the reply box shows at
// once and declares as each command's optimistic patch, with the peer's own semantics so the patch
// and the answer agree. A Stop never discards anything: it only holds the queue (`queueHeld`).

import type { QueueItem, Row } from '../types.ts';

type Queue = readonly Row<QueueItem>[];

/** wisp's own items (reports back, repairs) can't be edited, combined or reordered by hand. */
export const editable = (q: Row<QueueItem>): boolean => q.id !== '' && q.by !== 'wisp';

/** The row's tag: Next · after X finishes / Held after Stop / Queued #n, as an i18n key and vars. */
export function tagOf(index: number, held: boolean, name: string): { key: string; vars: Record<string, string | number> } {
  if (index > 0) return { key: 'shell-composer.queue.nth', vars: { n: index + 1 } };
  return held ? { key: 'shell-composer.queue.held', vars: {} } : { key: 'shell-composer.queue.next', vars: { name } };
}

/** The text changed; an empty or unchanged edit changes nothing (removing is ×, not editing). */
export function edit(queue: Queue, id: string, text: string): Queue {
  const t = text.trim();
  return queue.map((q) => (q.id === id && t && t !== q.text ? { ...q, text: t } : q));
}

export const remove = (queue: Queue, id: string): Queue => queue.filter((q) => q.id !== id);

/**
 * Several follow-ups as one: the texts trimmed and joined by a blank line, the files together, in the
 * first one's place with its mode and harness (server/runner.js mergeQueued).
 */
export function combine(queue: Queue, ids: readonly string[]): Queue {
  const picked = queue.filter((q) => ids.includes(q.id) && editable(q));
  const first = picked[0];
  if (!first || picked.length < 2) return queue;
  const merged: Row<QueueItem> = {
    ...first,
    text: picked.map((q) => q.text.trim()).join('\n\n'),
    attachments: picked.flatMap((q) => q.attachments ?? []),
  };
  return queue.flatMap((q) => (q.id === first.id ? [merged] : picked.includes(q) ? [] : [q]));
}

/** `ids` first in that order (unknown ones skipped), the rest after in their order (the peer's rule). */
export function reorder(queue: Queue, ids: readonly string[]): Queue {
  const byId = new Map(queue.map((q) => [q.id, q]));
  const first = ids.flatMap((id) => {
    const q = byId.get(id);
    return q ? [q] : [];
  });
  const seen = new Set(first.map((q) => q.id));
  return [...first, ...queue.filter((q) => !seen.has(q.id))];
}

/** The item at `from` moved to `to` (drag, Move up / Move down); the order as ids. */
export function moved(queue: Queue, from: number, to: number): string[] {
  const ids = queue.map((q) => q.id);
  if (from === to || from < 0 || from >= ids.length) return ids;
  const [id] = ids.splice(from, 1);
  ids.splice(Math.max(0, Math.min(ids.length, to)), 0, id ?? '');
  return ids;
}

/** Combine is offered when this row and the next can both be edited. */
export const canCombineNext = (queue: Queue, i: number): boolean => {
  const a = queue[i];
  const b = queue[i + 1];
  return !!a && !!b && editable(a) && editable(b);
};

/** The ids Combine all takes: every editable one, when there are more than two. */
export const combinableAll = (queue: Queue): string[] => {
  const ids = queue.filter(editable).map((q) => q.id);
  return ids.length > 2 ? ids : [];
};

/** v1 C:138: the confirm's quote, cut to 80 characters. */
export const quote = (text: string): string => (text.length > 80 ? `${text.slice(0, 80)}…` : text);
