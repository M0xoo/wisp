// Save to My Stuff, the kit's pure half (blocks/keep.ts, v1 web/js/blocks.js plainTitle, hashText, ctx.keep.bind).
import { expect, test } from 'vitest';
import { codeKeep, docKeep, hashText, mediaKeep, plainTitle } from '../src/blocks/keep.ts';

test('a_cards_title_from_a_caption_drops_markdown_and_is_one_short_line_v1_plain_title', () => {
  expect(plainTitle('**The** `login` [page](x)\n  at 390')).toBe('The login pagex at 390');
  expect(plainTitle('  ')).toBeUndefined();
  expect(plainTitle(undefined)).toBeUndefined();
  expect(plainTitle('a'.repeat(200))?.length).toBe(80);
});

test('the_same_snippet_hashes_as_v1_did_so_a_snippet_kept_in_v1_is_found_again', () => {
  // v1 hashText (djb2, base 36) of this text
  expect(hashText('export const x = 1;')).toBe('dzvdfz');
  expect(hashText('a')).not.toBe(hashText('b'));
});

test('a_kept_picture_is_named_by_the_agents_path_even_once_wisp_copied_it_and_saves_the_copy', () => {
  // keepImages rewrote `path` to wisp's copy and kept the original as `source`: the key stays the original's
  const k = mediaKeep({ type: 'image', path: '/h/.wisp/shots/t/1.png', source: '/tmp/s.png', caption: '*Login* page' }, 'image');
  expect(k).toEqual({ what: 'media:/tmp/s.png', it: { kind: 'image', path: '/h/.wisp/shots/t/1.png', title: 'Login page' } });
  expect(mediaKeep({ type: 'video', src: 'demo.mp4' }, 'video')).toEqual({ what: 'media:demo.mp4', it: { kind: 'video', path: 'demo.mp4' } });
  expect(mediaKeep({ type: 'image' }, 'image'), 'nothing named: no button').toBeUndefined();
});

test('a_kept_snippet_is_the_code_the_answer_shows_with_its_language_and_file_name', () => {
  const k = codeKeep({ type: 'code', code: 'API_KEY=••••', file: 'app/.env' }, '');
  // the block's text as the server sent it: a masked .env stays masked in My Stuff
  expect(k.it).toEqual({ kind: 'code', text: 'API_KEY=••••', lang: 'env', name: '.env', title: '.env' });
  expect(k.what).toBe(`code:app/.env:${hashText('API_KEY=••••')}`);
  expect(codeKeep({ type: 'code', code: 'x' }, 'ts').it.title).toBe('ts snippet');
  expect(codeKeep({ type: 'code', code: 'x', caption: 'The fix' }, 'ts').it.title).toBe('The fix');
});

test('a_kept_doc_is_its_markdown_under_its_files_name', () => {
  expect(docKeep('docs/plan.md', 'Plan', '# Plan\n')).toEqual({ what: 'doc:docs/plan.md', it: { kind: 'doc', text: '# Plan\n', name: 'plan.md', title: 'Plan' } });
  expect(docKeep('', 'Notes', 'x').what).toBe('doc:Notes');
});
