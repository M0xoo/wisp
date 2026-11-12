// The Watch tab opening by itself (src/open-task.ts opensWatch, v1 panel.js bus 'watch' opened).
import { expect, test } from 'vitest';
import { opensWatch, watchOpened, WATCH_VIEW } from '../src/open-task.ts';

test('only a new open opens it, never on a phone or over Changes or Shell you are reading_v1_watch_opens_itself', () => {
  const none = { kind: 'none' };
  expect(opensWatch(undefined, 3, none, false)).toBe(false); // the mark the task had when it opened
  expect(opensWatch(3, 3, none, false)).toBe(false); // a state or a caption: no new open
  expect(opensWatch(3, 5, none, false)).toBe(true);
  expect(opensWatch(0, 1, { kind: 'preview', id: 'k' }, false)).toBe(true);
  expect(opensWatch(0, 1, none, true)).toBe(false); // stacked: the task fills the phone
  expect(opensWatch(0, 1, { kind: 'changes', id: 'k' }, false)).toBe(false);
  expect(opensWatch(0, 1, { kind: 'shell', id: 'k' }, false)).toBe(false);
  expect(opensWatch(0, 1, { kind: 'view', id: WATCH_VIEW }, false)).toBe(false);
  expect(watchOpened({ summary: { watch: { opened: 4 } } })).toBe(4);
  expect(watchOpened({ watch: { opened: 2 } })).toBe(2);
  expect(watchOpened(undefined)).toBe(0);
});
