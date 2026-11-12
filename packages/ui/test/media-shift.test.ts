// A picture growing in a task (app/media-shift.ts, v1 tail.js mediaShift #776).
import { expect, test } from 'vitest';
import { atTail, mediaShift } from '../src/app/media-shift.ts';

test('a_picture_loading_in_a_task_keeps_the_view_where_the_reader_had_it', () => {
  const grew = [{ top: 40, from: 0, to: 300 }];
  // at the end: back to the end
  expect(mediaShift({ tail: true, anchors: false, inset: 100, grew })).toBe('end');
  // Chrome anchors the scroll itself: nothing to do
  expect(mediaShift({ tail: false, anchors: true, inset: 100, grew })).toBe(0);
  // WebKit: one wholly above the reading line pushed the text down by what it grew; one below moves nothing
  expect(mediaShift({ tail: false, anchors: false, inset: 100, grew })).toBe(300);
  expect(mediaShift({ tail: false, anchors: false, inset: 100, grew: [{ top: 500, from: 0, to: 300 }] })).toBe(0);
  // two above: the lower one's top already counts the upper one's growth, and both are undone
  expect(mediaShift({ tail: false, anchors: false, inset: 400, grew: [{ top: 330, from: 0, to: 120 }, { top: 10, from: 0, to: 300 }] })).toBe(420);
  expect(atTail({ scrollHeight: 1000, scrollTop: 599, clientHeight: 400 })).toBe(true);
  expect(atTail({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 })).toBe(false);
});
