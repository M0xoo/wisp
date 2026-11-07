import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { Markdown, parseInline, parseMarkdown, safeHref, type MarkdownBlock as Block, type MarkdownInline as Inline } from '../src/content/rich.ts';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = '';
});

function mount(ui: () => import('solid-js').JSX.Element): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(ui, host);
  return host;
}

const t = (v: string): Inline => ({ t: 'text', v });

describe('inline', () => {
  test.each<[string, Inline[]]>([
    ['plain', [t('plain')]],
    ['a **b** c', [t('a '), { t: 'strong', c: [t('b')] }, t(' c')]],
    ['*em* and _em_', [{ t: 'em', c: [t('em')] }, t(' and '), { t: 'em', c: [t('em')] }]],
    ['***both***', [{ t: 'strong', c: [{ t: 'em', c: [t('both')] }] }]],
    ['~~gone~~', [{ t: 'del', c: [t('gone')] }]],
    ['`a **b**`', [{ t: 'code', v: 'a **b**' }]],
    ['`` a`b ``', [{ t: 'code', v: 'a`b' }]],
    ['snake_case_name', [t('snake_case_name')]],
    ['2 * 3 * 4', [t('2 * 3 * 4')]],
    ['\\*not em\\*', [t('*not em*')]],
    ['[wisp](https://trywisp.dev "Home")', [{ t: 'link', href: 'https://trywisp.dev', title: 'Home', c: [t('wisp')] }]],
    ['<https://a.dev/x>', [{ t: 'link', href: 'https://a.dev/x', title: null, c: [t('https://a.dev/x')] }]],
    ['see https://a.dev/x.', [t('see '), { t: 'link', href: 'https://a.dev/x', title: null, c: [t('https://a.dev/x')] }, t('.')]],
    ['(https://a.dev/(x))', [t('('), { t: 'link', href: 'https://a.dev/(x)', title: null, c: [t('https://a.dev/(x)')] }, t(')')]],
    ['line  \nnext', [t('line'), { t: 'br' }, t('next')]],
    ['line\nnext', [t('line\nnext')]],
    ['unclosed `tick', [t('unclosed `tick')]],
    ['**unclosed', [t('**unclosed')]],
  ])('%j', (src, want) => {
    expect(parseInline(src)).toEqual(want);
  });

  test('a link inside link text stays text', () => {
    expect(parseInline('[a [b](x) c](y)')).toEqual([{ t: 'link', href: 'y', title: null, c: [t('a [b](x) c')] }]);
  });

  test('unsafe link schemes become plain text', () => {
    expect(parseInline('[click](javascript:alert(1))')).toEqual([t('click')]);
    expect(parseInline('[x](JAVA\nSCRIPT:alert(1))')).toEqual([t('[x](JAVA\nSCRIPT:alert(1))')]);
    expect(parseInline('<javascript:alert(1)>')).toEqual([t('<javascript:alert(1)>')]);
  });
});

describe('safeHref', () => {
  test.each([
    ['https://a.dev', 'https://a.dev'],
    ['mailto:a@b.c', 'mailto:a@b.c'],
    ['/docs', '/docs'],
    ['#top', '#top'],
    ['./x.md', './x.md'],
    ['javascript:alert(1)', undefined],
    [' JaVaScRiPt:alert(1)', undefined],
    ['java\tscript:alert(1)', undefined],
    ['data:text/html,<b>', undefined],
    ['vbscript:x', undefined],
    ['file:///etc/passwd', undefined],
  ])('%s', (url, want) => {
    expect(safeHref(url)).toBe(want);
  });
});

const kinds = (blocks: readonly Block[]): string[] => blocks.map((b) => b.t);

describe('blocks', () => {
  test('headings, paragraphs, rules and quotes', () => {
    const b = parseMarkdown('# Title #\n\nOne\ntwo\n\n---\n\n> quoted\n> > nested\n\n#nothashtag');
    expect(kinds(b)).toEqual(['heading', 'paragraph', 'hr', 'quote', 'paragraph']);
    expect(b[0]).toEqual({ t: 'heading', level: 1, c: [t('Title')] });
    const q = b[3];
    expect(q?.t === 'quote' && kinds(q.c)).toEqual(['paragraph', 'quote']);
  });

  test('fences keep their content verbatim, and an unclosed one runs to the end', () => {
    expect(parseMarkdown('```ts\nconst a = 1;\n\n# not a heading\n```')).toEqual([{ t: 'code', lang: 'ts', v: 'const a = 1;\n\n# not a heading' }]);
    expect(parseMarkdown('~~~\nstill\nstreaming')).toEqual([{ t: 'code', lang: '', v: 'still\nstreaming' }]);
  });

  test('indented code', () => {
    expect(parseMarkdown('    npm test\n    npm run x\n\nafter')).toEqual([{ t: 'code', lang: '', v: 'npm test\nnpm run x' }, { t: 'paragraph', c: [t('after')] }]);
  });

  test('nested lists by indentation', () => {
    const [list] = parseMarkdown('- a\n  - b\n    - c\n- d');
    expect(list?.t).toBe('list');
    if (list?.t !== 'list') return;
    expect(list.items.length).toBe(2);
    expect(list.tight).toBe(true);
    const inner = list.items[0]?.c[1];
    expect(inner?.t === 'list' && inner.items.length).toBe(1);
    const deepest = inner?.t === 'list' ? inner.items[0]?.c[1] : undefined;
    expect(deepest?.t).toBe('list');
  });

  test('a fence inside a list item stays in the item', () => {
    const [list, ...rest] = parseMarkdown('1. Install\n   ```sh\n   npm i\n   - not an item\n   ```\n2. Run');
    expect(rest).toEqual([]);
    if (list?.t !== 'list') throw new Error('no list');
    expect(list.ordered).toBe(true);
    expect(list.items.length).toBe(2);
    expect(list.items[0]?.c[1]).toEqual({ t: 'code', lang: 'sh', v: 'npm i\n- not an item' });
  });

  test('ordered lists keep their start; a blank line between items makes it loose', () => {
    const [list] = parseMarkdown('3. three\n\n4. four');
    expect(list).toMatchObject({ t: 'list', ordered: true, start: 3, tight: false });
  });

  test('task lists', () => {
    const [list] = parseMarkdown('- [x] done\n- [ ] open\n- plain');
    if (list?.t !== 'list') throw new Error('no list');
    expect(list.items.map((i) => i.task)).toEqual([true, false, null]);
  });

  test('tables with alignment, escaped pipes and pipes in code spans', () => {
    const [table] = parseMarkdown('| Name | Size | Note |\n|:--|--:|:-:|\n| `a|b` | 12 | x \\| y |\n| short |');
    if (table?.t !== 'table') throw new Error('no table');
    expect(table.align).toEqual(['left', 'right', 'center']);
    expect(table.rows[0]?.[0]).toEqual([{ t: 'code', v: 'a|b' }]);
    expect(table.rows[0]?.[2]).toEqual([t('x | y')]);
    // A short row is padded to the header's width.
    expect(table.rows[1]?.length).toBe(3);
  });

  test('a paragraph ends at a list or heading but not at "2024."', () => {
    expect(kinds(parseMarkdown('Intro\n- item'))).toEqual(['paragraph', 'list']);
    expect(kinds(parseMarkdown('Intro\n## Head'))).toEqual(['paragraph', 'heading']);
    expect(kinds(parseMarkdown('In\n2024. was long'))).toEqual(['paragraph']);
  });

  test('Windows line ends and tabs', () => {
    expect(parseMarkdown('# A\r\n\r\n-\tb')).toEqual([
      { t: 'heading', level: 1, c: [t('A')] },
      { t: 'list', ordered: false, start: 1, tight: true, items: [{ task: null, c: [{ t: 'paragraph', c: [t('b')] }] }] },
    ]);
  });
});

describe('<Markdown>', () => {
  test('renders its data-part, and its children name theirs', () => {
    const host = mount(() => <Markdown source={'Hi `x` [a](https://a.dev)\n\n```\ncode\n```\n\n| a |\n|---|\n| b |'} part="answer.body" />);
    expect(host.querySelector('[data-part="answer.body"]')).not.toBeNull();
    expect(host.querySelector('[data-part="answer.body.code"]')?.textContent).toBe('x');
    expect(host.querySelector('[data-part="answer.body.link"]')).not.toBeNull();
    expect(host.querySelector('[data-part="answer.body.code-block"]')).not.toBeNull();
    expect(host.querySelector('[data-part="answer.body.table"]')).not.toBeNull();
    expect(mount(() => <Markdown source="x" />).querySelector('[data-part="ui.markdown"]')).not.toBeNull();
  });

  test('escapes HTML: no element comes from the source, the text shows', () => {
    const src = '<img src=x onerror=alert(1)><script>alert(2)</script>\n\n**<b>bold</b>**\n\n<iframe src="https://x"></iframe>';
    const host = mount(() => <Markdown source={src} />);
    for (const tag of ['img', 'script', 'b', 'iframe']) expect(host.querySelector(tag)).toBeNull();
    expect(host.textContent).toContain('<img src=x onerror=alert(1)><script>alert(2)</script>');
    expect(host.textContent).toContain('<b>bold</b>');
    expect(host.querySelectorAll('[onerror]').length).toBe(0);
  });

  test('javascript: links render no anchor', () => {
    const host = mount(() => <Markdown source={'[click](javascript:alert(1)) and <javascript:x>'} />);
    expect(host.querySelector('a')).toBeNull();
    expect(host.textContent).toContain('click');
  });

  test('links open in a new tab without the opener, and report clicks', () => {
    const onLink = vi.fn((_href: string, e: MouseEvent) => e.preventDefault());
    const host = mount(() => <Markdown source="[docs](https://trywisp.dev) [top](#top)" onLink={onLink} />);
    const [ext, local] = [...host.querySelectorAll('a')];
    expect(ext?.getAttribute('target')).toBe('_blank');
    expect(ext?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(local?.getAttribute('target')).toBeNull();
    ext?.click();
    expect(onLink).toHaveBeenCalledWith('https://trywisp.dev', expect.anything());
  });

  test('headings start at h3 by default, and headingBase moves them', () => {
    expect(mount(() => <Markdown source="# A" />).querySelector('h3')?.textContent).toBe('A');
    expect(mount(() => <Markdown source="## B" headingBase={1} />).querySelector('h2')?.textContent).toBe('B');
  });

  test('task items render disabled checkboxes; tight items have no <p>', () => {
    const host = mount(() => <Markdown source={'- [x] done\n- [ ] open'} />);
    const boxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    expect(boxes.every((b) => b.disabled)).toBe(true);
    expect(host.querySelector('li p')).toBeNull();
  });

  test('a long unbroken word is kept whole in the text (CSS breaks it)', () => {
    const word = 'a'.repeat(500);
    expect(mount(() => <Markdown source={word} />).textContent).toBe(word);
  });

  test('growing source keeps the blocks that did not change (streaming)', () => {
    const [src, setSrc] = createSignal('First paragraph.\n\nSecond');
    const host = mount(() => <Markdown source={src()} />);
    const first = host.querySelector('p');
    setSrc('First paragraph.\n\nSecond, longer now');
    expect(host.querySelector('p')).toBe(first);
    expect(host.querySelectorAll('p')[1]?.textContent).toBe('Second, longer now');
  });
});
