// Preview's element picker, the panel's side (side/pick.ts, v1 run.js pickLine/pickedText, panel.js addToReply).
import { expect, test } from 'vitest';
import { pickedText, pickLine, withPicked } from '../src/side/pick.ts';

test('a picked element goes under what is in the reply box as v1 wrote it, and only while picking_v1_pick_line', () => {
  const d = { type: 'picked', tag: '<button class="primary">', text: '  Sign   in ', selector: 'form > button.primary', path: '/login', html: '<button class="primary">Sign in</button>', styles: 'size: 90 × 32px; color: rgb(255, 255, 255)' };
  expect(pickLine(d)).toBe('In the preview at /login, <button class="primary"> "Sign in" (selector: form > button.primary):\nHTML: <button class="primary">Sign in</button>\nStyles: size: 90 × 32px; color: rgb(255, 255, 255)');
  // at the root, no "at /"; no text, no quotes; no html or styles, no lines for them
  expect(pickLine({ tag: '<div>', selector: 'div', path: '/' })).toBe('In the preview, <div> (selector: div):');
  // the page's words are cut, each to its line
  expect(pickLine({ tag: '<p>', selector: 'p', text: 'x'.repeat(200) }).length).toBeLessThan(140);
  // only while picking, and only a well-formed pick
  expect(pickedText(false, d)).toBeUndefined();
  expect(pickedText(true, { ...d, selector: 3 })).toBeUndefined();
  expect(pickedText(true, d)).toBe(pickLine(d));
  // the reply box: under what's there, the caret on a line of its own
  expect(withPicked('', 'L')).toBe('L\n');
  expect(withPicked('Fix this:   \n', 'L')).toBe('Fix this:\nL\n');
});
