// An answer's pictures load from the task's own computer (src/frame/answer-of.ts mediaUrl, v1 ctx.fileUrl).
import { expect, test } from 'vitest';
import { mediaUrl } from '../src/frame/answer-of.ts';
import { reveal } from '../src/frame/commands.ts';
import { wireOf } from './command.ts';

test('a file comes from the tasks computer, through this wisp for another; a link stays a link_v1_media_url', () => {
  expect(mediaUrl('home', 'home:s1', 'shots/a b.png')).toBe('/api/sessions/s1/file?path=shots%2Fa%20b.png');
  expect(mediaUrl('home', 'studio:s2', '/tmp/x.png')).toBe('/api/peer/studio/api/sessions/s2/file?path=%2Ftmp%2Fx.png');
  expect(mediaUrl('home', 'home:s1', 'https://x.dev/a.png')).toBe('https://x.dev/a.png');
  expect(mediaUrl('home', 'home:s1', '')).toBeUndefined();
  // Show in folder runs on the task's computer, with the path as the block named it
  expect(wireOf(reveal)({ id: 'studio:s2', path: 'a.png' })).toEqual({ id: 's2', path: 'a.png' });
});
