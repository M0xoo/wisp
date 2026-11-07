// wisp.git: provides git.service@1 (plan §6.11.1). It owns no tables and no routes: it is the one
// place git and gh run, for worktrees, ship, review, issues, the workspace panel and the runtime.

import type { PluginContext, PluginDef, ProcService } from '@wisp/kernel';
import { EVENTS, gitService } from '@wisp-plugin/git-api';
import type { BlobPut } from './repo.ts';
import { createGitService } from './service.ts';

// The kernel's definePlugin isn't exported yet (packages/kernel has no index.ts): the same identity.
const definePlugin = <T extends PluginDef>(d: T): T => d;

export default definePlugin({
  id: 'wisp.git',
  setup(ctx: PluginContext) {
    const git = createGitService({
      proc: ctx.service<ProcService>('proc'),
      blob: () => ctx.service<BlobPut>('blob'),
      scope: ctx.scope,
      now: () => ctx.clock.now(),
      onWorktreeAdded: (root, path) => ctx.emit(EVENTS.worktreeAdded, { root, path }),
    });
    ctx.scope.add(git);
    ctx.provide(gitService, git);
  },
});

export { createGitService } from './service.ts';
export type { GitDeps, GitServiceImpl } from './service.ts';
