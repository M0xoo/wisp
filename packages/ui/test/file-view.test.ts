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

// F-page-25 (v1 editor.js hoverOn): rest the pointer on a name and the language server says what it is.
test('hovering_a_name_asks_the_language_server_where_the_pointer_rests_and_shows_its_words', async () => {
  const { hoverWords, nameCellAt } = await import('../src/content/file/file-text.ts');
  const m = { padTop: 10, padLeft: 14, lineHeight: 20, charWidth: 8 };
  const text = 'fn main() {\n    squash(&s);\n}';
  // line 2, col 5 is the s of squash: (14 + 4*8 + 1, 10 + 20 + 5)
  expect(nameCellAt(text, 14 + 4 * 8 + 1, 10 + 20 + 5, m)).toEqual({ line: 2, col: 5 });
  // blanks, punctuation, past the line's end, above the text: no question
  expect(nameCellAt(text, 14 + 1, 10 + 20 + 5, m)).toBeUndefined();
  expect(nameCellAt(text, 14 + 10 * 8 + 1, 10 + 20 + 5, m)).toBeUndefined();
  expect(nameCellAt(text, 14 + 40 * 8, 10 + 5, m)).toBeUndefined();
  expect(nameCellAt(text, 20, 2, m)).toBeUndefined();
  expect(nameCellAt(text, 20, 15, { ...m, charWidth: 0 })).toBeUndefined();
  // a tab is two cells (the editor's tab-size): the screen cell maps back to the character
  expect(nameCellAt('\t\tgo()', 14 + 4 * 8 + 1, 15, m)).toEqual({ line: 1, col: 3 });
  expect(nameCellAt('\t\tgo()', 14 + 3 * 8 + 1, 15, m)).toBeUndefined();
  expect(hoverWords('```rust\nfn squash(s: &str) -> String\n```')).toBe('fn squash(s: &str) -> String');
  expect(hoverWords(undefined)).toBe('');
});
