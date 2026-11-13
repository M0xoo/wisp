// The Changes pane's model (side/changes.ts).
import { expect, test } from 'vitest';
import { envState, filesOf, gitFiles, hunkOf, revealedOf, seenMasked, setRevealed, type ChangeTurn } from '../src/side/changes.ts';

test('a task\'s turns become one diff per file, edits in turn order, kept lines as context', () => {
  const h = hunkOf('a\nb\nc\n', 'a\nB\nc\n');
  expect(h.lines.map((l) => `${l.kind}:${l.text}`)).toEqual(['ctx:a', 'del:b', 'add:B', 'ctx:c']);
  const turns: ChangeTurn[] = [
    { session_id: 's1', idx: 1, body: { changes: [{ file: 'math.js', op: 'modify', edits: [{ before: 'x\n', after: 'y\n' }] }] } },
    { session_id: 's1', idx: 0, body: { changes: [{ file: 'math.js', op: 'modify', edits: [{ before: 'a - b', after: 'a + b' }] }, { file: 'new.txt', op: 'add', edits: [{ before: '', after: 'hi\n' }] }] } },
    { session_id: 'other', idx: 0, body: { changes: [{ file: 'nope.js', edits: [] }] } },
    // where runtime keeps them today, with the absolute path it records
    { session_id: 's1', idx: 2, body: { ext: { 'wisp.runtime': { changes: [{ file: '/w/api/src/a.ts', op: 'modify', edits: [{ before: '1', after: '2' }] }] } } } },
  ];
  const files = filesOf(turns, 's1', '/w/api');
  expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([['math.js', 'modified', 2, 2], ['new.txt', 'added', 1, 0], ['src/a.ts', 'modified', 1, 1]]);
  expect(files[0]?.hunks[0]?.lines.map((l) => l.text)).toEqual(['a - b', 'a + b']); // the first turn's edit first
  expect(files[1]?.oldPath).toBeNull();
  // macOS: the change was recorded under /private/tmp, the task's folder is /tmp
  expect(filesOf([{ session_id: 's', idx: 0, body: { changes: [{ file: '/private/tmp/p/math.js', edits: [] }] } }], 's', '/tmp/p')[0]?.path).toBe('math.js');
});

test('git\'s diff against the base reads as the kit\'s: a hunk per run of rows, a gap starts the next', () => {
  const files = gitFiles({ base: 'main', at: 'abc', body: { kind: 'inline', files: [{ path: 'math.js', status: 'M', add: 1, del: 1, binary: false, rows: [
    { op: ' ', text: 'export function add(a, b) {', a: 1, b: 1 },
    { op: '-', text: '  return a - b;', a: 2 },
    { op: '+', text: '  return a + b;', b: 2 },
    { op: '…', count: 40 },
    { op: ' ', text: '}', a: 43, b: 43 },
  ] }, { path: 'new.txt', status: 'A', add: 1, del: 0, binary: false, rows: [{ op: '+', text: 'hi', b: 1 }] }] } });
  expect(files?.map((f) => [f.path, f.status, f.hunks.length])).toEqual([['math.js', 'modified', 2], ['new.txt', 'added', 1]]);
  expect(files?.[0]?.hunks[0]?.lines.map((l) => `${l.kind}:${l.old ?? '-'}:${l.new ?? '-'}`)).toEqual(['ctx:1:1', 'del:2:-', 'add:-:2']);
  expect(files?.[0]?.hunks[1]?.oldStart).toBe(43);
  expect(gitFiles({ base: 'main', at: 'x', body: { kind: 'blob' } })).toBeNull();
});

test('F-page-41: a .env file git sent masked reads hidden; once revealed it stays shown for this task until Hide', () => {
  expect(envState({ path: '.env', masked: true }, new Set())).toBe('hidden');
  expect(envState({ path: 'src/a.ts' }, new Set())).toBeUndefined();
  // revealed: git sends it as it is (no `masked`), the line still says it's shown, with Hide
  const on = setRevealed('t1', '.env', true);
  expect(envState({ path: '.env' }, on)).toBe('shown');
  // per task, and kept for the tab's life: the pane opened again finds it
  expect(revealedOf('t1').has('.env')).toBe(true);
  expect(revealedOf('t2').size).toBe(0);
  const off = setRevealed('t1', '.env', false);
  expect(envState({ path: '.env', masked: true }, off)).toBe('hidden');
  expect(revealedOf('t1').size).toBe(0);
});

test('F-page-41: the edits wisp saw to a .env file (no git) read KEY=•••• until revealed; other files and masking off as they are', () => {
  const turns: ChangeTurn[] = [{ session_id: 's', idx: 0, body: { changes: [{ file: '/w/.env', op: 'modify', edits: [{ before: 'API_KEY=sk-1\n', after: 'API_KEY=sk-2\n' }] }, { file: '/w/a.ts', op: 'modify', edits: [{ before: 'K=1', after: 'K=2' }] }] } }];
  const text = (mask: (p: string) => boolean): string[] => filesOf(turns, 's', '/w', mask).flatMap((f) => f.hunks.flatMap((h) => h.lines.map((l) => `${f.path} ${l.kind}:${l.text}`)));
  expect(text((p) => seenMasked(p, true, new Set()))).toEqual(['.env del:API_KEY=••••', '.env add:API_KEY=•••• (changed)', 'a.ts del:K=1', 'a.ts add:K=2']);
  expect(text((p) => seenMasked(p, true, new Set(['.env'])))).toContain('.env add:API_KEY=sk-2');
  expect(text((p) => seenMasked(p, false, new Set()))).toContain('.env add:API_KEY=sk-2');
  expect(seenMasked('.env.example', true, new Set())).toBe(false);
});

test('ADR-0050: a revealed .env file the server sent masked shows each turn’s edits as Reveal brought them back', () => {
  const turns = [{ id: 't1', session_id: 's', idx: 0, body: { ext: { 'wisp.runtime': { changes: [{ file: '/w/.env', op: 'modify', edits: [{ before: 'K=••••', after: 'K=•••• (changed)' }] }] } } } }];
  const masked = filesOf(turns, 's', '/w');
  expect(masked[0]?.hunks.flatMap((h) => h.lines.map((l) => l.text))).not.toContain('K=sk-2');
  const shown = filesOf(turns, 's', '/w', () => false, (turn, file) => (turn === 't1' && file === '/w/.env' ? [{ before: 'K=sk-1', after: 'K=sk-2' }] : undefined));
  expect(shown[0]?.hunks.flatMap((h) => h.lines.map((l) => l.text))).toEqual(['K=sk-1', 'K=sk-2']);
  // still masked (not revealed): the server's copy is never asked for
  const hidden = filesOf(turns, 's', '/w', () => true, () => [{ before: 'K=sk-1', after: 'K=sk-2' }]);
  expect(JSON.stringify(hidden)).not.toContain('sk-');
});
