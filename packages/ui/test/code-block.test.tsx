// The answer `code` block (blocks/Code.tsx, v1 blocks.js R.code): the structure v1's .b-code CSS styles, in kit parts.
import { expect, test } from 'vitest';
import { mount } from './helpers.tsx';
import { Answer } from '../src/index.ts';

test('code block: head with file:line that opens it and Copy, numbered lines from `line`, highlighted lines, the gutter width, the caption', () => {
  const opened: Array<[string, number | undefined]> = [];
  const code = Array.from({ length: 12 }, (_, i) => `const v${i} = ${i};`).join('\n');
  const root = mount(() => (
    <Answer blocks={[{ type: 'code', file: 'src/auth/limiter.ts', line: 95, highlight: [2, 3], code: `${code}\n`, caption: 'The **new** check' }]} ctx={{ openFile: (p, l) => opened.push([p, l]) }} />
  ));
  const block = root.querySelector('[data-kit="cb-code"][data-part="block.code"]');
  expect(block).not.toBeNull();
  // the head: a button naming the file (dir faint, base in ink) and :line, then Copy
  const head = block?.querySelector(':scope > [data-kit="cb-code-head"]');
  const file = head?.querySelector<HTMLButtonElement>('button[data-part="block.code.file"]');
  expect(file?.querySelector('[data-kit="cb-dir"]')?.textContent).toBe('src/auth/');
  expect(file?.querySelector('[data-kit="cb-base"]')?.textContent).toBe('limiter.ts');
  expect(file?.querySelector('[data-kit="cb-lineno"]')?.textContent).toBe(':95');
  expect(head?.querySelector('[data-part="block.code.copy"]')).not.toBeNull();
  file?.click();
  expect(opened).toEqual([['src/auth/limiter.ts', 95]]);
  // the body: one row per line (the trailing newline dropped), numbered from 95, rows 2 and 3 marked
  const rows = [...(block?.querySelectorAll('[data-part="block.code.body"] [data-kit="cb-code-line"]') ?? [])];
  expect(rows).toHaveLength(12);
  expect(rows.map((r) => r.querySelector('[data-kit="cb-code-no"]')?.textContent)).toEqual(Array.from({ length: 12 }, (_, i) => String(95 + i)));
  expect(rows.map((r, i) => (r.hasAttribute('data-hl') ? i + 1 : 0)).filter(Boolean)).toEqual([2, 3]);
  expect(rows[0]?.querySelector('[data-kit="cb-code-src"] [data-tk="k"]')?.textContent).toBe('const');
  // v1 highlight(): a capitalised identifier, constants included, is a type
  const caps = mount(() => <Answer blocks={[{ type: 'code', language: 'ts', code: 'if (n >= LIMIT) new Foo(WINDOW_MS, x);' }]} />);
  expect([...caps.querySelectorAll('[data-tk="t"]')].map((n) => n.textContent)).toEqual(['LIMIT', 'Foo', 'WINDOW_MS']);
  // the gutter fits the last number (106: 3 digits) for every row
  expect(block?.querySelector<HTMLElement>('[data-kit="cb-code-lines"]')?.style.getPropertyValue('--k-digits')).toBe('3');
  // the caption last, under the lines
  expect(block?.lastElementChild?.getAttribute('data-part')).toBe('block.code.caption');
  expect(block?.lastElementChild?.querySelector('strong')?.textContent).toBe('new');
});

test('code block: no file shows the language in the head, and lines number from 1', () => {
  const root = mount(() => <Answer blocks={[{ type: 'code', language: 'sh', code: 'npm test\n\nnpm run check' }]} />);
  expect(root.querySelector('[data-part="block.code.lang"]')?.textContent).toBe('sh');
  expect(root.querySelector('[data-part="block.code.file"]')).toBeNull();
  const nos = [...root.querySelectorAll('[data-kit="cb-code-no"]')].map((n) => n.textContent);
  expect(nos).toEqual(['1', '2', '3']);
  expect(root.querySelector('[data-part="block.code.caption"]')).toBeNull();
});
