import { afterEach, describe, expect, test } from 'vitest';
import { render } from 'solid-js/web';
import type { JSX } from 'solid-js';
import { Diff, parseDiff } from '../src/content/rich.ts';

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

const GIT = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,5 @@ export function a() {',
  ' const x = 1;',
  '-const y = 2;',
  '+const y = 3;',
  '+const z = 4;',
  '-- a/not-a-header',
  ' return x;',
  '\\ No newline at end of file',
  'diff --git a/new.md b/new.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.md',
  '@@ -0,0 +1,2 @@',
  '+# New',
  '+',
  'diff --git a/gone.txt b/gone.txt',
  'deleted file mode 100644',
  '--- a/gone.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  'diff --git a/old name.ts b/new name.ts',
  'similarity index 100%',
  'rename from old name.ts',
  'rename to new name.ts',
  'diff --git a/logo.png b/logo.png',
  'Binary files a/logo.png and b/logo.png differ',
].join('\n');

describe('parseDiff', () => {
  const files = parseDiff(GIT);

  test('finds every file with its status', () => {
    expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
      ['src/a.ts', 'modified', false],
      ['new.md', 'added', false],
      ['gone.txt', 'deleted', false],
      ['new name.ts', 'renamed', false],
      ['logo.png', 'modified', true],
    ]);
    expect(files[3]?.oldPath).toBe('old name.ts');
    expect(files[1]?.oldPath).toBeNull();
    expect(files[2]?.newPath).toBeNull();
  });

  test('numbers lines on both sides, counted from the hunk header', () => {
    const lines = files[0]?.hunks[0]?.lines ?? [];
    expect(lines.map((l) => [l.kind, l.old, l.new, l.text])).toEqual([
      ['ctx', 1, 1, 'const x = 1;'],
      ['del', 2, null, 'const y = 2;'],
      ['add', null, 2, 'const y = 3;'],
      ['add', null, 3, 'const z = 4;'],
      // A removed line that reads like a header is still a line of the hunk.
      ['del', 3, null, '- a/not-a-header'],
      ['ctx', 4, 4, 'return x;'],
      ['note', null, null, '\\ No newline at end of file'],
    ]);
    expect(files[0]?.additions).toBe(2);
    expect(files[0]?.deletions).toBe(2);
    expect(files[0]?.hunks[0]?.header).toBe('@@ -1,4 +1,5 @@ export function a() {');
  });

  test('a hunk whose header over-counts ends at the next file header', () => {
    // GIT's first hunk says +1,5 but has four new-side lines: the next `diff --git` still starts a file.
    expect(files.length).toBe(5);
  });

  test('a hunk without counts means one line', () => {
    expect(files[2]?.hunks[0]?.lines).toEqual([{ kind: 'del', text: 'bye', old: 1, new: null }]);
  });

  test('a plain diff -u with several files and timestamps', () => {
    const plain = '--- a.txt\t2024-01-01\n+++ a.txt\t2024-01-02\n@@ -1 +1 @@\n-x\n+y\n--- b.txt\n+++ b.txt\n@@ -1 +1 @@\n-p\n+q\n';
    expect(parseDiff(plain).map((f) => [f.path, f.additions, f.deletions])).toEqual([
      ['a.txt', 1, 1],
      ['b.txt', 1, 1],
    ]);
  });

  test('CRLF and an empty context line without its space', () => {
    const f = parseDiff('--- a/x\r\n+++ b/x\r\n@@ -1,3 +1,3 @@\r\n a\r\n\r\n-b\r\n+c\r\n')[0];
    expect(f?.hunks[0]?.lines.map((l) => l.kind)).toEqual(['ctx', 'ctx', 'del', 'add']);
  });

  test('empty input is no files', () => {
    expect(parseDiff('')).toEqual([]);
  });
});

describe('<Diff>', () => {
  test('renders its parts: root, file, head', () => {
    const host = mount(() => <Diff diff={GIT} part="changes.diff" binaryLabel="Binary file" />);
    expect(host.querySelector('[data-part="changes.diff"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-part="changes.diff.file"]').length).toBe(5);
    expect(host.querySelectorAll('[data-part="changes.diff.head"]').length).toBe(5);
    expect(host.textContent).toContain('Binary file');
    expect(host.textContent).toContain('old name.ts → ');
    expect(mount(() => <Diff diff="" />).querySelector('[data-part="ui.diff"]')).not.toBeNull();
  });

  test('shows +N and −M, and the lines as text', () => {
    const host = mount(() => <Diff diff={GIT} />);
    const head = host.querySelector('[data-kit="diff-head"]');
    expect(head?.textContent).toContain('+2');
    expect(head?.textContent).toContain('−2');
    expect(host.querySelectorAll('[data-kit="diff-line"][data-kind="add"]').length).toBe(4);
  });

  test('a large file starts folded and opens on click, in lazy chunks', () => {
    const n = 450;
    const big = `--- a/big.txt\n+++ b/big.txt\n@@ -0,0 +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+line ${i}`).join('\n')}`;
    const host = mount(() => <Diff diff={big} />);
    expect(host.querySelectorAll('[data-kit="diff-line"]').length).toBe(0);
    const expand = host.querySelector<HTMLButtonElement>('[data-part="ui.diff.expand"]');
    expect(expand?.textContent).toContain(`Show ${n} lines`);
    expand?.click();
    expect(host.querySelectorAll('[data-kit="diff-line"]').length).toBe(n);
    const chunks = host.querySelectorAll('[data-kit="diff-chunk"][data-lazy]');
    expect(chunks.length).toBe(Math.ceil((n + 1) / 200));
  });

  test('lazyLines sets the threshold', () => {
    const host = mount(() => <Diff diff={GIT} lazyLines={2} />);
    expect(host.querySelectorAll('[data-part="ui.diff.expand"]').length).toBe(1);
  });

  test('HTML in a line is text', () => {
    const host = mount(() => <Diff diff={'--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+<script>alert(1)</script>'} />);
    expect(host.querySelector('script')).toBeNull();
    expect(host.textContent).toContain('<script>alert(1)</script>');
  });
});
