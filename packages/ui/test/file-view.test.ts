// The file view's ✦ and Go to definition: the selected lines, and the name under the caret.
import { expect, test } from 'vitest';
import { lineAt, nameAt } from '../src/content/file/file-text.ts';

test('the_file_view_says_which_lines_are_selected_and_which_name_is_under_the_caret', () => {
  const text = 'one\npub fn squash(s: &str)\nthree';
  expect([lineAt(text, 0), lineAt(text, 4), lineAt(text, text.length)]).toEqual([1, 2, 3]);
  expect(nameAt(text, text.indexOf('squash') + 2)).toBe('squash');
  expect(nameAt(text, text.indexOf('(') + 1)).toBe('s');
  expect(nameAt('a  b', 2)).toBeUndefined();
  expect(nameAt('x 42 y', 3)).toBeUndefined();
});
