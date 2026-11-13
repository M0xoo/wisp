// The kit's Changes list (app/Changes.tsx): v1 features/changes.js's stage, revert and commit controls.
import { afterEach, expect, test } from 'vitest';
import { render } from 'solid-js/web';
import { createSignal, type JSX } from 'solid-js';
import { ChangesList, firstLine, hunkKey, hunkRuns, type ChangeFile, type ChangesLabels, type ChangeRow } from '../src/app/Changes.tsx';

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

const L: ChangesLabels = {
  files: (n) => `${n} files`,
  vs: 'vs main',
  vsTitle: 'compared with main',
  expandAll: 'Expand all',
  collapseAll: 'Collapse all',
  stage: 'Stage',
  part: 'Partly',
  staged: 'Staged',
  viewed: 'Viewed',
  viewedTitle: (on) => (on ? 'Viewed' : 'Mark viewed'),
  edit: 'Edit',
  more: 'More',
  line: (n) => `Line ${n}`,
  revert: 'Revert',
  revertTitle: 'Put this hunk back',
  stageHunk: 'Stage',
  unstageHunk: 'Unstage',
  unchanged: (n) => `${n} unchanged`,
  commit: 'Commit',
  commitPlaceholder: 'Fix the sum',
};

const ROWS: ChangeRow[] = [
  { op: ' ', text: 'export function add(a, b) {', a: 1, b: 1 },
  { op: '-', text: '  return a - b;', a: 2 },
  { op: '+', text: '  return a + b;', b: 2 },
  { op: '…', count: 40 },
  { op: '-', text: 'old', a: 43 },
  { op: ' ', text: '}', a: 44, b: 43 },
];

test('a hunk key is v1 hash(): djb2 per code point in base 36, the same key wisp-git checks', () => {
  // the vectors of plugins/git/core/src/hunks.rs (hunk_key_is_v1s_hash)
  expect(hunkKey([])).toBe('45h');
  expect(hunkKey([{ op: '+', text: 'a', b: 1 }])).toBe('375t97');
  expect(hunkKey([{ op: '…', count: 3 }])).toBe('3cgvfs');
  expect(hunkKey([{ op: ' ', text: 'é😀', a: 1, b: 1 }])).toBe('yk5m0l');
});

test('a diff splits into hunks at each gap, each knowing the gap before it and its first changed line', () => {
  const hs = hunkRuns(ROWS);
  expect(hs.map((h) => [h.from, h.rows.length, h.gap?.count ?? null])).toEqual([
    [0, 3, null],
    [4, 2, 40],
  ]);
  expect(hs.map((h) => firstLine(h.rows))).toEqual([2, 43]); // a line only removed reads its old number
  expect(hunkKey(hs[0]?.rows ?? [])).not.toBe(hunkKey(hs[1]?.rows ?? []));
});

const FILE: ChangeFile = { path: 'src/math.js', status: 'M', add: 1, del: 2, binary: false, rows: ROWS, stage: 'part', hunkStage: ['unstage', 'stage'], revertable: true };

test('stage, stage a hunk, revert a hunk and commit call back with the path, hunk and key', () => {
  const calls: string[] = [];
  const host = mount(() => (
    <ChangesList
      files={[FILE]}
      labels={L}
      open={() => true}
      viewed={() => false}
      onToggle={() => {}}
      onViewed={(p) => calls.push(`viewed ${p}`)}
      allOpen
      onAll={() => {}}
      onStage={(p, un) => calls.push(`stage ${p} ${un}`)}
      onHunkStage={(p, i, k, un) => calls.push(`hunk ${p} ${i} ${k} ${un}`)}
      onRevertHunk={(p, i, k) => calls.push(`revert ${p} ${i} ${k}`)}
      commit={{ count: '1 staged', countTitle: 'staged files', placeholder: 'Fix the sum', onCommit: (m) => calls.push(`commit ${m}`) }}
    />
  ));
  const stage = host.querySelector<HTMLButtonElement>('[data-part~="panel.changes.stage"]');
  expect(stage?.hasAttribute('data-part-staged')).toBe(true); // part-staged
  stage?.click();
  const hunkStage = host.querySelectorAll<HTMLButtonElement>('[data-part~="panel.changes.stageHunk"]');
  expect([...hunkStage].map((b) => b.textContent)).toEqual(['Unstage', 'Stage']);
  hunkStage[1]?.click();
  host.querySelectorAll<HTMLButtonElement>('[data-part~="panel.changes.revertHunk"]')[0]?.click();
  host.querySelector<HTMLButtonElement>('[data-part~="panel.changes.viewed"]')?.click();
  const input = host.querySelector<HTMLInputElement>('[data-part~="panel.changes.commit"] input');
  expect(input?.placeholder).toBe('Fix the sum');
  host.querySelector<HTMLButtonElement>('[data-kit="cx-cm-go"]')?.click(); // empty: the placeholder is the message
  const [h0, h1] = hunkRuns(ROWS);
  expect(calls).toEqual([
    'stage src/math.js false', // part-staged: Stage stages the rest
    `hunk src/math.js 1 ${hunkKey(h1?.rows ?? [])} false`,
    `revert src/math.js 0 ${hunkKey(h0?.rows ?? [])}`,
    'viewed src/math.js',
    'commit Fix the sum',
  ]);
});

test('a hunk being reverted is hidden at once, and the file without staging has no stage controls', () => {
  const [going, setGoing] = createSignal<ReadonlySet<string>>(new Set());
  const host = mount(() => (
    <ChangesList
      files={[{ ...FILE, stage: undefined, hunkStage: undefined }]}
      labels={L}
      open={() => true}
      viewed={() => false}
      onToggle={() => {}}
      onViewed={() => {}}
      allOpen
      onAll={() => {}}
      onRevertHunk={() => {}}
      going={going()}
    />
  ));
  expect(host.querySelector('[data-part~="panel.changes.stage"]')).toBeNull();
  expect(host.querySelector('[data-part~="panel.changes.stageHunk"]')).toBeNull();
  expect(host.querySelector('[data-part~="panel.changes.commit"]')).toBeNull();
  const shown = (): number => [...host.querySelectorAll('[data-kit="cx-hunk"]')].filter((h) => !(h as HTMLElement).hidden).length;
  expect(shown()).toBe(2);
  setGoing(new Set(['src/math.js#0']));
  expect(shown()).toBe(1);
});

test('F-page-41: a .env file has v1 env-mask\'s line over its diff, Reveal ⇄ Hide in place, the button the same size', () => {
  const calls: string[] = [];
  const [env, setEnv] = createSignal<'hidden' | 'shown'>('hidden');
  const host = mount(() => (
    <ChangesList
      files={[{ ...FILE, path: 'app/.env.local', env: env() }, { ...FILE, path: 'src/a.ts' }]}
      labels={{ ...L, envHidden: (n) => `${n}’s values are hidden`, envShown: (n) => `Showing ${n}’s values`, reveal: 'Reveal', hide: 'Hide' }}
      open={() => true}
      viewed={() => false}
      onToggle={() => {}}
      onViewed={() => {}}
      allOpen
      onAll={() => {}}
      onReveal={(p, on) => calls.push(`${p} ${on}`)}
    />
  ));
  const bars = host.querySelectorAll('[data-part="changes.envMask"]');
  expect(bars.length).toBe(1); // only the .env file
  expect(bars[0]?.textContent).toBe('.env.local’s values are hiddenReveal');
  const btn = (): HTMLButtonElement => host.querySelector('[data-part="changes.envReveal"]') as HTMLButtonElement;
  expect(btn().getAttribute('aria-pressed')).toBe('false');
  btn().click();
  setEnv('shown');
  expect(btn().textContent).toBe('Hide');
  expect(btn().getAttribute('aria-pressed')).toBe('true');
  expect(host.querySelector('[data-kit="env-mask-what"]')?.textContent).toBe('Showing .env.local’s values');
  btn().click();
  expect(calls).toEqual(['app/.env.local true', 'app/.env.local false']);
});
