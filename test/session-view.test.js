import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leanSession } from '../server/session-view.js';

// A lead with three turns; each delegated to its own subagent, whose run has two turns.
const kid = (id) => ({
  id,
  parentId: 'lead',
  turns: [
    { id: `${id}-a`, status: 'done', activity: [{ kind: 'tool', label: 'old' }], changes: [{ path: 'a.js', beforeFile: 'x', diff: '+' }] },
    { id: `${id}-b`, status: 'done', activity: [{ kind: 'tool', label: 'ran' }], changes: [{ path: 'b.js', beforeFile: 'y', diff: '+' }] },
  ],
});
const turn = (i) => ({ id: `t${i}`, prompt: `p${i}`, status: 'done', activity: [{ kind: 'tool' }], delegations: [{ name: `k${i}`, sessionId: `k${i}`, turnId: `k${i}-b` }] });
const lead = () => ({ id: 'lead', turns: [turn(1), turn(2), turn(3)], childSessions: { k1: kid('k1'), k2: kid('k2'), k3: kid('k3') } });

test('lean: every subagent run whole, without beforeFile', () => {
  const out = leanSession(lead(), 0);
  assert.deepEqual(Object.keys(out.childSessions), ['k1', 'k2', 'k3']);
  for (const k of Object.values(out.childSessions)) {
    assert.equal(k.turns.length, 2);
    assert.equal(k.partial, undefined);
    for (const t of k.turns) assert.ok(t.changes.every((c) => !('beforeFile' in c)));
  }
});

test('the phone window: only the subagents its whole turns show, with only the turn each ran as', () => {
  const out = leanSession(lead(), 1);
  assert.deepEqual(Object.keys(out.childSessions), ['k3'], 'k1 and k2 belong to stubbed turns, whose rows show no cards');
  const k3 = out.childSessions.k3;
  assert.equal(k3.partial, true, 'the page fetches the whole run when it is opened');
  assert.deepEqual(k3.turns.map((t) => t.id), ['k3-b']);
  assert.deepEqual(k3.turns[0].activity, [{ kind: 'tool', label: 'ran' }], 'the card’s live line reads it');
  assert.equal('beforeFile' in k3.turns[0].changes[0], false);
});

test('the phone window: a subagent named by a whole turn but not yet in childSessions is not invented', () => {
  const s = lead();
  delete s.childSessions.k3;
  assert.deepEqual(leanSession(s, 1).childSessions, {});
});

test('the phone window: a window wider than the task keeps every run whole', () => {
  const out = leanSession(lead(), 8);
  assert.deepEqual(Object.keys(out.childSessions), ['k1', 'k2', 'k3']);
  assert.equal(out.childSessions.k1.turns.length, 2);
  assert.equal(out.childSessions.k1.partial, undefined);
});

test('the phone window: a crew job on another machine goes whole, opening it must not wait on that machine', () => {
  const out = leanSession(lead(), 1, { whole: (id) => id === 'k3' });
  assert.equal(out.childSessions.k3.partial, undefined);
  assert.equal(out.childSessions.k3.turns.length, 2);
  assert.equal('beforeFile' in out.childSessions.k3.turns[0].changes[0], false);
});
