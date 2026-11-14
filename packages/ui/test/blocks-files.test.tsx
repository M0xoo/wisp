/// <reference types="vite/client" />
import CSS from '../src/css/answer-content.css?raw';
import { describe, expect, test } from 'vitest';
import { mount, part } from './helpers.tsx';
import { Answer } from '../src/index.ts';

const rule = (sel: string): string => {
  const i = CSS.indexOf(`${sel} {`);
  return i < 0 ? '' : CSS.slice(i, CSS.indexOf('}', i));
};

describe('files block', () => {
  // v1 blocks.js R.files + blocks.css .b-title/.count/.badge/.path/.nums: the head is "Files" then its count in a
  // separate faint span 8px away (not "Files2"), each change is a tinted badge (not a bare "M"), the path is one
  // line cut with an ellipsis, and every piece has CSS behind it.
  test('files_block_head_badge_and_path_have_v1_structure_and_styles', () => {
    const files = { type: 'files', items: [{ path: 'src/session.ts', change: 'modified', additions: 12, deletions: 3 }, { path: 'src/present/blocks.ts', change: 'added' }, { path: 'legacy.ts', change: 'deleted' }] };
    mount(() => <Answer blocks={[files]} />);
    const title = part('block.files.title');
    expect(title?.querySelector('[data-kit="cb-title-text"]')?.textContent).toBe('Files');
    expect(title?.querySelector('[data-kit="cb-count"]')?.textContent).toBe('3');
    const badges = [...document.querySelectorAll('[data-part="block.files.change"]')];
    expect(badges.map((b) => [b.textContent, b.getAttribute('data-kit'), b.getAttribute('data-change')])).toEqual([
      ['M', 'cb-badge', 'mod'],
      ['A', 'cb-badge', 'add'],
      ['D', 'cb-badge', 'del'],
    ]);
    expect(badges[0]?.getAttribute('aria-label')).toBeTruthy();
    const path = document.querySelector('[data-part="block.files.path"]');
    expect([...(path?.children ?? [])].map((c) => [c.getAttribute('data-kit'), c.textContent])).toEqual([
      ['cb-dir', 'src/'],
      ['cb-base', 'session.ts'],
    ]);
    expect(part('block.files.counts')?.textContent).toBe('+12−3');
    const items = [...document.querySelectorAll<HTMLElement>('[data-part="block.files.item"]')];
    expect(items.map((li) => li.style.getPropertyValue('--k'))).toEqual(['0', '1', '2']);

    expect(rule("[data-kit='cb-title']")).toContain('gap: var(--space-4)');
    expect(rule("[data-kit='cb-count']")).toContain('color: var(--faint)');
    expect(rule("[data-kit='cb-badge']")).toContain('width: var(--size-avatar-sm)');
    for (const kind of ['add', 'mod', 'del', 'ren']) expect(rule(`[data-kit='cb-badge'][data-change='${kind}']`)).toContain('background:');
    expect(rule("[data-kit='cb-path']")).toContain('text-overflow: ellipsis');
    expect(rule("[data-kit='cb-file-row']")).toContain('display: flex');
    expect(rule("[data-kit='cb-files']")).toContain('list-style: none');
  });

  // Improvement over v1 (design/v1-reference/allowed.md §7): v1 cut the whole path at its end, so on a 320 px phone
  // the file name could vanish. The folder now shrinks first, cut from its start (rtl, its text isolated in a <bdi> so
  // the slashes stay put), and the name keeps its width: CSS only, no measuring per row (the Changes panel's way).
  test('files_block_path_truncates_in_the_middle_so_the_name_stays_visible', () => {
    const files = { type: 'files', items: [{ path: 'packages/very/long/folder/that/keeps/going/a-file.tsx', change: 'modified' }] };
    mount(() => <Answer blocks={[files]} />);
    const path = part('block.files.path');
    const dir = path?.querySelector('[data-kit="cb-dir"]');
    expect(dir?.firstElementChild?.tagName).toBe('BDI');
    expect(dir?.textContent).toBe('packages/very/long/folder/that/keeps/going/');
    expect(path?.querySelector('[data-kit="cb-base"]')?.textContent).toBe('a-file.tsx');
    expect(path?.getAttribute('title')).toBe(files.items[0]?.path);

    expect(rule("[data-part='block.files.path']")).toContain('display: flex');
    const d = rule("[data-part='block.files.path'] > [data-kit='cb-dir']");
    for (const decl of ['flex: 0 1 auto', 'direction: rtl', 'text-overflow: ellipsis', 'overflow: hidden', 'min-width: 2ch']) expect(d).toContain(decl);
    const b = rule("[data-part='block.files.path'] > [data-kit='cb-base']");
    for (const decl of ['flex: 0 1 auto', 'text-overflow: ellipsis', 'min-width: 3ch']) expect(b).toContain(decl);
    // after a folder the name never shrinks while the folder can (a weighted shrink leaked 0.1 px and cut it)
    const nb = rule("[data-part='block.files.path'] > [data-kit='cb-dir'] + [data-kit='cb-base']");
    for (const decl of ['flex: none', 'max-width: calc(100% - 2ch)']) expect(nb).toContain(decl);
  });
});
