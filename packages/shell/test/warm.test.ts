// New task fetches its project's remote while you type (v1 launcher.js warmLaunch, F-comp-43): at most every 30 s
// a folder, a new folder at once, nothing with No folder or in place.
import { expect, test } from 'vitest';
import { warm, warmer, WARM_EVERY_MS } from '../src/frame/warm.ts';

test('typing in new task warms its project once per 30 s a folder_v1_launch_warm', () => {
  let now = 1_000;
  const sent: string[] = [];
  const w = warmer(() => now, (p) => sent.push(p));
  w('/code/app');
  w('/code/app');
  now += WARM_EVERY_MS - 1;
  w('/code/app');
  expect(sent).toEqual(['/code/app']);
  w('/code/site'); // another project: at once
  now += WARM_EVERY_MS;
  w('/code/site');
  w(undefined); // No folder, or in place
  expect(sent).toEqual(['/code/app', '/code/site', '/code/site']);
  expect(warm.id).toBe('worktrees.warm');
});
