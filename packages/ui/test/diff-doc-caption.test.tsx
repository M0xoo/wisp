// The diff block's caption and the doc block's path (v1 blocks.js R.diff / R.doc, blocks.css .caption and
// .doc-name .path): the structure the kit CSS styles as v1 did.
import { expect, test } from 'vitest';
import { mount } from './helpers.tsx';
import { Answer } from '../src/index.ts';

test('diff_caption_closes_the_file_card_and_doc_path_is_the_small_mono_path_as_v1', () => {
  const root = mount(() => (
    <Answer
      blocks={[
        { type: 'diff', file: 'src/a.ts', before: 'a\n', after: 'b\n', caption: 'The **new** check' },
        { type: 'diff', file: 'src/b.ts', before: 'a\n', after: 'b\n' },
        { type: 'doc', path: 'docs/plan.md', text: '# Plan\n\nOne.\nTwo.\n' },
      ]}
    />
  ));
  const [withCap, bare] = [...root.querySelectorAll('[data-kit="cb-diff"]')];
  // the caption: in a foot that follows the diff card and closes it (data-foot squares the card's bottom)
  expect(withCap?.hasAttribute('data-foot')).toBe(true);
  const foot = withCap?.lastElementChild;
  expect(foot?.getAttribute('data-kit')).toBe('cb-diff-foot');
  expect(foot?.previousElementSibling?.getAttribute('data-kit')).toBe('diff');
  const cap = foot?.querySelector(':scope > [data-kit="cb-caption"][data-part="block.diff.caption"]');
  expect(cap?.querySelector('strong')?.textContent).toBe('new');
  // no caption and no Open in editor: no foot, the card keeps its corners
  expect(bare?.hasAttribute('data-foot')).toBe(false);
  expect(bare?.querySelector('[data-kit="cb-diff-foot"]')).toBeNull();
  // the doc path: a cb-path inside the name's meta line, before the line count
  const meta = root.querySelector('[data-kit="rb-doc-name"] > span');
  expect(meta?.firstElementChild?.getAttribute('data-kit')).toBe('cb-path');
  expect(meta?.firstElementChild?.getAttribute('data-part')).toBe('block.doc.path');
  expect(meta?.querySelector(':scope > i')).not.toBeNull();
});
