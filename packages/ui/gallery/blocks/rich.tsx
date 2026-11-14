// Gallery: the rich and interactive blocks (flow … app), every state.
import type { JSX } from 'solid-js';
import { Answer } from '../../src/index.ts';
import { Specimen } from '../frame.tsx';
import { galleryCtx } from './ctx.ts';

const RICH: readonly unknown[] = [
  { type: 'next', items: ['Add tests for the edges', { label: 'Ship it', reply: 'commit and open a PR' }] },
  { type: 'question', question: 'Which **database** should the cache use?', options: ['Postgres', { label: 'SQLite', detail: 'one file, no server' }] },
  { type: 'blocked', items: [{ tool: 'Bash', detail: 'rm -rf build/', why: 'outside the task folder' }] },
  { type: 'actions', title: 'Try it', items: [{ label: 'Run the linter', command: 'npm run lint' }, { label: 'Ask why', reply: 'explain the change' }] },
  { type: 'terminal', command: 'npm test', output: '\u001b[32m✓\u001b[0m 48 passed\n\u001b[31m✗\u001b[0m 1 failed', exitCode: 1 },
  { type: 'tests', passed: 48, failed: 1, skipped: 2, durationMs: 5300, command: 'npm test', failures: [{ name: 'auth › rejects expired token', message: 'expected 401, got 500', file: 'test/auth.test.ts:42' }] },
  { type: 'compare', before: { items: ['Every request hit the database'] }, after: { label: 'After', items: ['Reads come from the cache', 'Writes invalidate it'] } },
  { type: 'task', id: 'a1b2c3', note: 'Picks up where this one stopped' },
  { type: 'stuff', id: '0bac5acb43c9' },
  { type: 'doc', path: 'docs/plan.md', title: 'Plan' },
  { type: 'image', src: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300"><rect width="640" height="300" fill="#2fd0b4"/><circle cx="320" cy="150" r="80" fill="#6a5cff"/></svg>')}`, caption: 'The *login* page at 390 px' },
  { type: 'map', title: 'Coffee near the office', route: true, places: [{ name: 'Blue Bottle Coffee', address: '66 Mint St, San Francisco, CA 94103', note: 'Opens at 7' }, { name: 'Sightglass', address: '270 7th St, San Francisco, CA 94103' }] },
  { type: 'preview', url: 'https://example.com/', device: 'mobile', title: 'Settings page', caption: 'The new **dark mode** toggle' },
  {
    type: 'graph', title: 'Refresh sessions in auth', ref: '#128', state: 'open', into: 'main', merge: 'conflict',
    commits: [
      { hash: 'd29f50', message: 'Add refresh tests', branch: 'feat/refresh', author: 'You', when: 'now' },
      { hash: '7aa1c0', message: 'Refresh on 401', branch: 'feat/refresh', author: 'You', when: '4m' },
      { hash: '5be27d', message: 'Rotate keys', branch: 'main', author: 'Lena', when: '6m', conflict: true },
    ],
    conflicts: [{ file: 'src/auth.ts:42', commit: '5be27d', detail: 'Both sides rewrote getSession()', ours: 'refresh(token)', theirs: 'rotate(key)', resolution: 'Rotate first, then refresh' }],
    checks: [{ label: 'Tests', value: '42 passed', status: 'pass' }, { label: 'Lint', status: 'pending' }],
    action: { label: 'Resolve conflicts', reply: 'Merge main in and resolve the conflicts' },
  },
  { type: 'app', title: 'Tip calculator', height: 140, html: '<label>Bill <input id=b value=42></label> <output id=o></output><script>const f=()=>o.textContent=(b.value*1.15).toFixed(2);b.oninput=f;f()</script>' },
];

export function RichBlocksGallery(): JSX.Element {
  return (
    <Specimen title="Rich blocks" note="flow, chart, image, video, preview, map, doc, task, stuff, question, blocked, actions, next, app">
      <Answer blocks={RICH} ctx={{ ...galleryCtx, draft: (t) => console.info('[gallery] draft', t), deny: () => console.info('[gallery] deny'), appState: { get: () => undefined, set: () => {} } }} />
    </Specimen>
  );
}
