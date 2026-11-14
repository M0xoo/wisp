// A task being typed in New task (v1 launcher.js warmLaunch, F-comp-43): its project's remote is fetched now
// (`worktrees.warm`), so Send doesn't wait on the network for the worktree's base. At most every 30 s a folder
// (a fetch is good for a minute); none in place, with No folder, or for another computer (it finds its own checkout).
import { defineCommand } from '@wisp/client';

export const warm = defineCommand<{ peer: string; path: string }, unknown>({
  id: 'worktrees.warm',
  owner: (a) => a.peer,
  wire: ({ path }) => ({ path }),
  optimistic: 'none',
  pending: 'fetching the project',
});

export const WARM_EVERY_MS = 30_000;

/** The typing hook: called on each key with the folder to warm (undefined: nothing to warm). */
export function warmer(now: () => number, send: (path: string) => void): (path: string | undefined) => void {
  let last = { path: '', at: 0 };
  return (path) => {
    if (!path || (path === last.path && now() - last.at < WARM_EVERY_MS)) return;
    last = { path, at: now() };
    send(path);
  };
}
