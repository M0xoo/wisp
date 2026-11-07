import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBus, memoryBlobs, nodeProc } from '@wisp/testkit/fake-gh';
import { gitService } from '@wisp-plugin/git-api';

test('the plugin provides git.service@1 and frees it with its scope', async () => {
  const bus = createBus({ proc: nodeProc(), blob: memoryBlobs() });
  const ctx = await bus.load('@wisp-plugin/git');
  assert.equal(ctx.id, 'wisp.git');
  const git = ctx.use(gitService);
  assert.equal(typeof git.repo, 'function');
  bus.dispose();
  assert.equal(ctx.tryUse(gitService), undefined);
});
