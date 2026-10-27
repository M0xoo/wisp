// Topic tags (web/js/tags.js): the words a task's agent sets with wisp_tag, and how ⌘K finds
// tasks by them next to its fuzzy search.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { installFakeBins, makeRepo, tmp, until } from './helpers.js';
import { MAX_TAGS, normalizeTags, splitQuery, tagScore } from '../web/js/tags.js';
import { fuzzy } from '../web/js/fuzzy.js';

process.env.WISP_HOME = tmp('tags-home');
process.env.WISP_UPDATE_CHECK = '0';
process.env.WISP_NO_OPEN = '1';
process.env.FAKE_RECORD = tmp('tags-rec');
installFakeBins();
const { startServer } = await import('../server/index.js');
const { systemPrompt } = await import('../server/protocol.js');

test('normalizeTags: lowercase words, hyphens for spaces, no #, no repeats, at most ten', () => {
  assert.deepEqual(normalizeTags(['Rate Limiting', '#Redis', 'next.js', 'c++', ' redis ', '', '!!', 'a_b/c']), ['rate-limiting', 'redis', 'next.js', 'c++', 'a-b-c']);
  assert.deepEqual(normalizeTags('auth, login'), ['auth', 'login']);
  assert.deepEqual(normalizeTags(['--x--', '.y.']), ['x', 'y']);
  assert.deepEqual(normalizeTags(null), []);
  assert.equal(normalizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`)).length, MAX_TAGS);
  assert.equal(normalizeTags(['x'.repeat(80)])[0].length, 32);
});

test('splitQuery: #words are tags, the rest is text', () => {
  assert.deepEqual(splitQuery('#Auth login  #redis'), { tags: ['auth', 'redis'], text: 'login' });
  assert.deepEqual(splitQuery('# fix'), { tags: [], text: 'fix' });
  assert.deepEqual(splitQuery(''), { tags: [], text: '' });
});

test('tagScore: a #tag has to be there (or start one); a plain word naming a tag counts more', () => {
  assert.equal(tagScore(splitQuery('#auth'), ['billing']), null);
  assert.equal(tagScore(splitQuery('#auth'), undefined), null);
  assert.deepEqual(tagScore(splitQuery('#auth'), ['auth']).hit, ['auth']);
  assert.ok(tagScore(splitQuery('#auth'), ['auth']).score > tagScore(splitQuery('#au'), ['auth']).score, 'whole tag beats a prefix');
  assert.deepEqual(tagScore(splitQuery('login'), []), { score: 0, hit: [] }, 'no #tag: nothing is filtered out');
  assert.equal(tagScore(splitQuery('redis cache'), ['redis']).score, 10);
  assert.equal(tagScore(splitQuery('re'), ['redis']).score, 0, 'two letters are too short to count as a tag');
});

// The palette's ranking (web/js/palette.js): fuzzy over the fields plus the tag score.
const find = (q, tasks) => {
  const query = splitQuery(q);
  return tasks
    .map((t) => {
      const ts = tagScore(query, t.tags);
      const m = ts && (query.text ? fuzzy(query.text, [t.title, (t.tags || []).join(' ')]) : { score: 0 });
      return m && { t: t.title, score: m.score + ts.score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.t);
};

test('a task is found by its topic even when the title never says it', () => {
  const tasks = [
    { title: 'Make login faster', tags: ['auth', 'performance'] },
    { title: 'Fix the cache', tags: ['redis', 'bugfix'] },
    { title: 'Redis talk notes', tags: ['docs'] },
    { title: 'Untagged chore' },
  ];
  assert.deepEqual(find('#redis', tasks), ['Fix the cache'], '#redis keeps only tagged tasks');
  assert.deepEqual(find('redis', tasks).slice(0, 2).sort(), ['Fix the cache', 'Redis talk notes']);
  assert.deepEqual(find('auth', tasks), ['Make login faster']);
  assert.deepEqual(find('#bug fix', tasks), ['Fix the cache'], 'a #prefix and a title word together');
  assert.deepEqual(find('#auth #redis', tasks), [], 'every #tag has to match');
});

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let srv;
let base;
before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});

async function api(p, body, method = body ? 'POST' : 'GET', headers = {}) {
  const r = await fetch(`${base}/api${p}`, { method, headers: { ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${p}: ${j.error}`), { status: r.status });
  return j;
}
const task = async (prompt) => {
  const s = await api('/sessions', { prompt, cwd: makeRepo(), agent: 'claude', worktree: false });
  await until(async () => (await api(`/sessions/${s.id}`)).state !== 'running' && !srv.runner.live.has(s.id));
  return s;
};

test('wisp_tag: the agent tags its task; the page gets the tags and wisp_sessions finds by them', async () => {
  const a = await task('look at math.js');
  const b = await task('look at add()');
  const token = { 'x-wisp-token': srv.token };
  const out = await api('/internal/tags', { session: a.id, tags: ['Auth', '#rate limit', 'auth'] }, 'POST', token);
  assert.match(out.text, /Tagged: #auth #rate-limit\./);
  assert.deepEqual(srv.store.get(a.id).tags, ['auth', 'rate-limit'], 'stored with the task');
  assert.deepEqual((await api('/sessions')).find((x) => x.id === a.id).tags, ['auth', 'rate-limit'], 'in its summary, for the page');
  // Again: it replaces them.
  await api('/internal/tags', { session: a.id, tags: ['billing'] }, 'POST', token);
  assert.deepEqual(srv.store.get(a.id).tags, ['billing']);

  const found = await api(`/internal/sessions/${b.id}?query=%23billing`, undefined, 'GET', token);
  assert.match(found.text, new RegExp(`\`${a.id}\`.*#billing`));
  assert.match((await api(`/internal/sessions/${b.id}?query=billing`, undefined, 'GET', token)).text, new RegExp(a.id));

  await assert.rejects(api('/internal/tags', { session: a.id, tags: ['!!'] }, 'POST', token), /topic words/);
  await assert.rejects(api('/internal/tags', { session: 'nope', tags: ['x'] }, 'POST', token), /no such session/);
  assert.equal((await fetch(`${base}/api/internal/tags`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: a.id, tags: ['x'] }) })).status, 403);
});

test('the protocol tells the agent to tag its task, under the harness’s name for the tool', () => {
  assert.match(systemPrompt({ askTool: 'mcp__wisp__ask_user' }), /call `wisp_tag` \(mcp__wisp__wisp_tag\)/);
  assert.doesNotMatch(systemPrompt({ askTool: null }), /wisp_tag/, 'no wisp tools, no tagging');
});
