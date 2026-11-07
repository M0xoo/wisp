import { afterEach, expect, test } from 'vitest';
import { render } from 'solid-js/web';
import type { JSX } from 'solid-js';
import { Code, highlight } from '../src/content/rich.ts';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = '';
});

function mount(ui: () => JSX.Element): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(ui, host);
  return host;
}

test('inline code renders its data-part and text', () => {
  const host = mount(() => <Code part="tip.cmd">npm test</Code>);
  const el = host.querySelector('code[data-part="tip.cmd"]');
  expect(el?.textContent).toBe('npm test');
  expect(mount(() => <Code>x</Code>).querySelector('[data-part="ui.code"]')).not.toBeNull();
});

test('a block renders its parts, title and language', () => {
  const host = mount(() => (
    <Code block lang="ts" title="src/a.ts">
      {'const a: Foo = "x"; // note\nreturn 42;'}
    </Code>
  ));
  expect(host.querySelector('[data-part="ui.code-block"]')).not.toBeNull();
  expect(host.querySelector('[data-part="ui.code-block.title"]')?.textContent).toBe('src/a.ts');
  expect(host.querySelector('code')?.getAttribute('data-lang')).toBe('ts');
  expect(host.querySelector('[data-tk="k"]')?.textContent).toBe('const');
  expect(host.querySelector('[data-tk="s"]')?.textContent).toBe('"x"');
  expect(host.querySelector('[data-tk="c"]')?.textContent).toBe('// note');
  expect(host.querySelector('[data-tk="n"]')?.textContent).toBe('42');
  expect(host.querySelector('[data-tk="t"]')?.textContent).toBe('Foo');
  expect(host.querySelector('pre')?.textContent).toBe('const a: Foo = "x"; // note\nreturn 42;');
});

test('code that looks like HTML stays text', () => {
  const host = mount(() => <Code block lang="html">{'<script>alert(1)</script><img src=x onerror=y>'}</Code>);
  expect(host.querySelector('script')).toBeNull();
  expect(host.querySelector('img')).toBeNull();
  expect(host.textContent).toContain('<script>');
});

test('highlight: tokens join back to the source, for every language family', () => {
  const samples: Array<[string, string]> = [
    ['ts', 'import { x } from "y";\n/* block */ let n = 0x1f; `tpl ${n}`'],
    ['sh', 'echo "hi" # comment\nnpm run build --if-present'],
    ['py', "def f(a):\n    return 'x' + str(1.5)"],
    ['unknown', 'anything <goes> here'],
    ['ts', '"unterminated'],
  ];
  for (const [lang, src] of samples) expect(highlight(src, lang).map((t) => t.text).join('')).toBe(src);
  expect(highlight('#!/bin/sh', 'sh')[0]?.kind).toBe('c');
  expect(highlight('x', 'nope')).toEqual([{ kind: null, text: 'x' }]);
});

test('highlight gives up on very large blocks', () => {
  const big = 'const x = 1;\n'.repeat(5000);
  expect(highlight(big, 'ts')).toEqual([{ kind: null, text: big }]);
});

test('plain turns highlighting off', () => {
  const host = mount(() => <Code block lang="ts" plain>{'const x = 1'}</Code>);
  expect(host.querySelector('[data-tk]')).toBeNull();
});
