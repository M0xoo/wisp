// A manual clock for timers: `later` schedules, `advance` runs what came due, in order.
import type { Later } from '../../src/order.ts';

export function manualTime(start = 1_000_000): { now: () => number; later: Later; advance(ms: number): void; pending(): number } {
  let t = start;
  let seq = 0;
  const q = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    later: (ms, fn) => {
      const id = seq++;
      q.set(id, { at: t + ms, fn });
      return () => void q.delete(id);
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...q.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        q.delete(due[0]);
        t = Math.max(t, due[1].at);
        due[1].fn();
      }
      t = end;
    },
    pending: () => q.size,
  };
}
