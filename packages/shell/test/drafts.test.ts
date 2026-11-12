// The prompt boxes' drafts (src/frame/drafts.ts, v1 F-task-32): what's half-typed is still there after a reload.
import { expect, test } from 'vitest';
import { createClient, memoryPersist, type PeerId } from '@wisp/client';
import { draftValue, launcherDraft, replyDraft } from '../src/frame/drafts.ts';

const client = (persist: ReturnType<typeof memoryPersist>) => createClient({ clientId: 'c', build: 't', home: 'laptop' as PeerId, width: 1280, persist });

test('a half-typed prompt and reply are still there after a reload; New task keeps share-in s key_v1_drafts_survive_reload', async () => {
  // wisp.stuff's share-in writes New task's text at `<home>:launcher` → text (plugins/stuff/ui/src/share/launcher.ts)
  expect(launcherDraft('laptop')).toEqual(['laptop:launcher', 'text']);
  expect(replyDraft('laptop:s1')).toEqual(['laptop:s1', 'reply']);
  expect(draftValue('')).toBeUndefined();
  const persist = memoryPersist();
  const before = client(persist);
  await before.start([]);
  before.drafts.set(...launcherDraft('laptop'), 'Bump the deps and');
  before.drafts.set(...replyDraft('laptop:s1'), 'also the lockfile');
  await before.drafts.flush();
  // a reload: a new client on the same disk
  const after = client(persist);
  await after.start([]);
  expect(after.drafts.get(...launcherDraft('laptop'))()).toBe('Bump the deps and');
  expect(after.drafts.get(...replyDraft('laptop:s1'))()).toBe('also the lockfile');
});
