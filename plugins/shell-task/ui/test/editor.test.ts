import { expect, test } from 'vitest';
import { editorUrl } from '../src/editor.ts';

test('open_in_editor_uses_the_editors_own_url_scheme_and_none_copies_v1_actions_js', () => {
  expect(editorUrl(undefined, '/code/wisp')).toBe('vscode://file/code/wisp');
  expect(editorUrl('cursor', '/code/wisp/a.ts', 12)).toBe('cursor://file/code/wisp/a.ts:12');
  expect(editorUrl('idea', '/code/w x')).toBe('idea://open?file=%2Fcode%2Fw%20x');
  expect(editorUrl('none', '/code/wisp')).toBeUndefined();
  expect(editorUrl('vscode', 'relative/path')).toBeUndefined();
});
