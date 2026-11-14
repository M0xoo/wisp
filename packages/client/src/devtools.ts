// The devtools log (plan §4.6.8): the last 500 frames, patches and commands, and every machine's
// state. Settings → Diagnostics shows it and a bug report attaches `export()`, so a state bug is
// reproducible from the report. Entries are small summaries, never row contents (no secrets).

import type { Readable } from './signals.ts';
import { untracked } from './signals.ts';

export type DevEntry =
  | { kind: 'frame'; peer: string; t: string; seq?: number; ops?: number }
  | { kind: 'command'; mid: string; cmd: string; peer: string }
  | { kind: 'sent'; mid: string; peer: string }
  | { kind: 'ack'; mid: string; seq: number }
  | { kind: 'reject'; mid: string; code: string; message: string }
  | { kind: 'transition'; machine: string; from: string; via: string; to: string }
  | { kind: 'warn'; message: string };

export interface Devtools {
  record(entry: DevEntry): void;
  /** a machine's live state, listed until its scope ends */
  machine(id: string, state: Readable<string>): () => void;
  entries(): readonly (DevEntry & { at: number })[];
  machines(): Record<string, string>;
  /** JSON for a bug report */
  export(extra?: Record<string, unknown>): string;
}

export function createDevtools(now: () => number = Date.now, size = 500): Devtools {
  const ring: (DevEntry & { at: number })[] = [];
  let head = 0; // next slot once the ring is full
  const machines = new Map<string, Readable<string>[]>();
  const dev: Devtools = {
    record(entry) {
      const e = { ...entry, at: now() };
      if (ring.length < size) ring.push(e);
      else {
        ring[head] = e;
        head = (head + 1) % size;
      }
    },
    machine(id, state) {
      const list = machines.get(id) ?? [];
      list.push(state);
      machines.set(id, list);
      return () => {
        const i = list.indexOf(state);
        if (i >= 0) list.splice(i, 1);
        if (list.length === 0) machines.delete(id);
      };
    },
    entries: () => [...ring.slice(head), ...ring.slice(0, head)],
    machines() {
      const out: Record<string, string> = {};
      for (const [id, list] of machines) list.forEach((s, i) => (out[list.length > 1 ? `${id}#${i}` : id] = untracked(s)));
      return out;
    },
    export: (extra = {}) => JSON.stringify({ at: now(), entries: dev.entries(), machines: dev.machines(), ...extra }, null, 2),
  };
  return dev;
}
