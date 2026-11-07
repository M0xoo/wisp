// The git service as the plugin builds it, over a real proc service and an in-memory blob store.
import { createScope } from '@wisp/kernel';
import { memoryBlobs, nodeProc } from '@wisp/testkit/fake-gh';
import type { Worktree } from '@wisp-plugin/git-api';
import { createGitService, type GitServiceImpl } from '../src/service.ts';

export interface Rig {
  git: GitServiceImpl;
  proc: ReturnType<typeof nodeProc>;
  blobs: ReturnType<typeof memoryBlobs>;
  added: { root: string; path: string }[];
  dispose(): void;
}

export function rig(o: { now?: () => number; env?: Record<string, string | undefined> } = {}): Rig {
  const proc = nodeProc();
  const blobs = memoryBlobs();
  const scope = createScope('test');
  const added: Rig['added'] = [];
  const git = createGitService({ proc, blob: () => blobs, scope, ...(o.now && { now: o.now }), env: { ...process.env, ...o.env }, onWorktreeAdded: (root, path) => added.push({ root, path }) });
  return { git, proc, blobs, added, dispose: () => (git.dispose(), scope.dispose()) };
}

export const wtOf = (o: Partial<Worktree> & { path: string; root: string }): Worktree => ({ cwd: o.path, branch: '', base: 'main', baseRef: 'origin/main', head: null, remote: 'origin', createdAt: 0, ...o });
