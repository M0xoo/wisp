// What wisp says about the runs that were going when it last died: restarted, or (on a wisp Grid)
// its box ran out of memory, with the waitlist for bigger cloud computers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runner, restartReason } from '../server/runner.js';

const orphan = () => ({ id: 'a', agent: 'claude', cwd: '/x', state: 'running', queue: [], turns: [{ id: 't', status: 'running', changes: [], activity: [], btw: [{ status: 'running' }] }] });
const store = (s) => ({ all: () => [s], save: () => {}, get: () => s, projectFor: () => null });

function sweep(env) {
  const keep = { ...process.env };
  Object.assign(process.env, env);
  try {
    const s = orphan();
    new Runner(store(s), {});
    return s;
  } finally {
    for (const k of Object.keys(env)) if (keep[k] === undefined) delete process.env[k];
    Object.assign(process.env, keep);
  }
}

test('restartReason: a plain restart, or out of memory with the limit and the waitlist', () => {
  assert.deepEqual(restartReason({}), { summary: 'wisp was restarted while this was running.', short: 'wisp was restarted', asked: 'wisp was restarted before this was answered.' });
  const r = restartReason({ WISP_OUT_OF_MEMORY: '1536m', WISP_GRID_URL: 'https://grid.example/' });
  assert.equal(r.title, 'Out of memory');
  assert.match(r.summary, /ran out of memory \(1\.5 GB\)/);
  assert.match(r.blocks[0].text, /\[join the waitlist\]\(https:\/\/grid\.example\/#machines\/bigger\)/);
  // No size known (the process driver), and no grid to link: still says what happened.
  const bare = restartReason({ WISP_OUT_OF_MEMORY: '1' });
  assert.match(bare.summary, /ran out of memory while/);
  assert.doesNotMatch(bare.blocks[0].text, /waitlist/);
  assert.equal(restartReason({ WISP_OUT_OF_MEMORY: '2g' }).summary.includes('(2 GB)'), true);
});

test('a run going when wisp died stops with why: restarted, or out of memory', () => {
  const plain = sweep({});
  assert.equal(plain.state, 'review');
  assert.equal(plain.turns[0].status, 'stopped');
  assert.deepEqual(plain.turns[0].presentation.blocks, [{ type: 'hero', title: 'Stopped', summary: 'wisp was restarted while this was running.', status: 'partial' }]);
  assert.equal(plain.turns[0].btw[0].error, 'wisp was restarted before this was answered.');

  const oom = sweep({ WISP_OUT_OF_MEMORY: '1536m', WISP_GRID_URL: 'https://grid.example' });
  const [hero, tip] = oom.turns[0].presentation.blocks;
  assert.equal(hero.title, 'Out of memory');
  assert.equal(tip.type, 'callout');
  assert.match(tip.text, /grid\.example\/#machines\/bigger/);
  assert.equal(oom.turns[0].btw[0].error, 'The cloud computer ran out of memory before this was answered.');
});
