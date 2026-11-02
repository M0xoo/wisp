// Finding past work: GET /search over titles, prompts and answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchTasks } from '../server/search.js';

const task = (id, title, turns, updatedAt) => ({ id, title, updatedAt, turns });
const tasks = [
  task('a', 'Fix the login bug', [{ id: 't1', prompt: 'Users get logged out after refresh', presentation: { blocks: [{ type: 'hero', title: 'Session cookie now survives a reload' }, { type: 'markdown', text: 'The token was stored in sessionStorage; it lives in a cookie now.' }] } }], 3),
  task('b', 'Write docs', [{ id: 't2', prompt: 'Document the REST API', presentation: { blocks: [{ type: 'markdown', text: 'Added docs for /sessions and /search.' }] } }], 5),
  task('c', 'Refactor the store', [{ id: 't3', prompt: 'Split store.js', presentation: { blocks: [{ type: 'files', items: [{ path: 'server/store.js', change: 'modified', note: 'the cookie jar moved out' }] }] } }], 1),
  { id: 'sub', parentId: 'a', title: 'cookie helper', turns: [], updatedAt: 9 },
];

test('search: every word in one piece, newest first, with where and a snippet', () => {
  const hits = searchTasks(tasks, 'cookie');
  assert.deepEqual(hits.map((h) => [h.id, h.where]), [['a', 'answer'], ['c', 'answer']], 'answers (cards included), newest first; subagents left out');
  assert.match(hits[0].snippet, /cookie/i);
  assert.equal(hits[0].turn, 't1');
  assert.deepEqual(searchTasks(tasks, 'logged refresh').map((h) => [h.id, h.where]), [['a', 'prompt']], 'both words in the prompt');
  assert.deepEqual(searchTasks(tasks, 'logged cookie'), [], 'words split across the prompt and the answer are not one hit');
  assert.deepEqual(searchTasks(tasks, 'login').map((h) => [h.id, h.where]), [['a', 'title']]);
  assert.deepEqual(searchTasks(tasks, ' '), []);
  assert.equal(searchTasks(tasks, 'the', { limit: 1 }).length, 1);
});

test('search: a long answer gives a short snippet around the word', () => {
  const long = task('l', 'Long', [{ id: 't', prompt: 'x', presentation: { blocks: [{ type: 'markdown', text: `${'a '.repeat(500)}needle${' b'.repeat(500)}` }] } }], 1);
  const [hit] = searchTasks([long], 'needle');
  assert.ok(hit.snippet.length < 160 && hit.snippet.startsWith('…') && hit.snippet.endsWith('…'));
});
