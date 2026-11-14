// The inspector's data, pure (plan §4.6.8): one line per devtools entry, newest first, and the
// bug-report JSON with the peers' states added. Entries are summaries already (no row contents,
// no secrets): this only formats them.

import type { DevEntry } from '@wisp/client';

export const STORE_KINDS = ['session', 'turn', 'event', 'setting', 'crew_member', 'machine', 'stuff'] as const;

export function describe(e: DevEntry): string {
  switch (e.kind) {
    case 'frame':
      return `${e.peer} ← ${e.t}${e.seq === undefined ? '' : ` @${e.seq}`}${e.ops === undefined ? '' : ` (${e.ops} ops)`}`;
    case 'command':
      return `${e.cmd} → ${e.peer} [${e.mid.slice(-8)}]`;
    case 'sent':
      return `sent [${e.mid.slice(-8)}] → ${e.peer}`;
    case 'ack':
      return `ack [${e.mid.slice(-8)}] @${e.seq}`;
    case 'reject':
      return `reject [${e.mid.slice(-8)}] ${e.code}: ${e.message}`;
    case 'transition':
      return `${e.machine}: ${e.from} —${e.via}→ ${e.to}`;
    case 'warn':
      return `warn: ${e.message}`;
  }
}

/** Newest first, each with a key unique within this read (entries carry no id of their own). */
export function newestFirst<T extends { at: number }>(entries: readonly T[], limit = 500): (T & { key: string })[] {
  const out = entries.slice(-limit).map((e, i) => ({ ...e, key: `${e.at}:${i}` }));
  return out.reverse();
}
