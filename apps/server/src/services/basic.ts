// The small kernel services: paths, net and notify. Each is what the plugins get through
// ctx.service(name); an install (the grid, a test) may pass its own instead.
import path from 'node:path';
import type { Json, NetService, NotifyService, PathsService } from '@wisp/kernel';

/** ~/.wisp (or WISP_HOME); a plugin's own folder is <home>/plugins/<id> unless it maps a v1 path. */
export function homePaths(home: string): PathsService {
  return {
    home,
    dir: (...parts: string[]) => path.join(home, ...parts),
  };
}

/** HTTP out, with a timeout: plugins never call the global fetch (tools/check refuses it). */
export function timedNet(base: typeof fetch = fetch): NetService {
  return {
    fetch(url, init = {}) {
      const { timeoutMs, ...rest } = init;
      if (!timeoutMs) return base(url, rest);
      const signal = rest.signal ? AbortSignal.any([rest.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      return base(url, { ...rest, signal });
    },
  };
}

/** Notices go to every client: the sync layer as `notice` frames, v1 clients as an event of that name. */
export function fanoutNotify(sinks: readonly ((kind: string, data: Json) => void)[]): NotifyService {
  return {
    notice(kind, data) {
      for (const s of sinks) s(kind, data);
    },
  };
}
