// Home's overview (design/today.md): its words and numbers, written from data wisp has.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAsk, openPr, plansLine, plansOf, quietFor, sentenceOf, shortName, stageOf, STAGES } from '../web/js/today.js';

const stage = (s) => STAGES[stageOf(s)];

test('the sentence names what needs you, then what is working, then says all quiet', () => {
  assert.equal(sentenceOf({ asks: ['Kilo Code', 'Plan limits'], working: 4 }).line, 'Kilo Code and Plan limits need you.');
  assert.equal(sentenceOf({ asks: ['Kilo Code'] }).line, 'Kilo Code needs you.');
  assert.equal(sentenceOf({ asks: ['A', 'B', 'C', 'D'] }).line, 'A, B and 2 more need you.');
  assert.equal(sentenceOf({ working: 3, ready: 2 }).line, '3 working.');
  assert.equal(sentenceOf({ ready: 1 }).line, '1 ready for review.');
  assert.equal(sentenceOf({}).line, 'All quiet.');
});

test('the line under it says what the sentence left out, and no percentage of anything', () => {
  assert.equal(sentenceOf({ asks: ['A'], working: 4, last: { title: 'Issue sits in the Recipes row', ago: '15m' } }).sub, '4 working. Last done 15m ago: Issue sits in the Recipes row.');
  assert.equal(sentenceOf({ working: 2 }).sub, '', 'the sentence said it');
  assert.equal(sentenceOf({ last: { title: 'x', ago: 'now' } }).sub, 'Last done just now: x.');
});

test('a long title is cut between words, and a short one is left alone', () => {
  assert.equal(shortName('Plan limits'), 'Plan limits');
  assert.equal(shortName('Fix it.'), 'Fix it');
  assert.equal(shortName('i should be able to right click on a project and edit it or delete it'), 'i should be able to right click…');
  assert.ok(shortName('x'.repeat(80)).length <= 33, 'one long word still fits');
});

test('cards are for what asks something: questions, due reminders and held tasks', () => {
  assert.ok(isAsk({ state: 'waiting' }));
  assert.ok(isAsk({ state: 'review', reminder: { text: 'x' } }));
  assert.ok(isAsk({ state: 'review', status: 'held' }));
  assert.ok(!isAsk({ state: 'review', status: 'done', unread: true }), 'a report is reading');
  assert.ok(!isAsk({ state: 'review', status: 'failed' }));
});

test('the stage comes from the task and its PR, and claims nothing finer', () => {
  assert.equal(stage({ state: 'running', pending: true }), 'Asked');
  assert.equal(stage({ state: 'running', live: 'Starting up' }), 'Asked');
  assert.equal(stage({ state: 'running', live: 'Editing math.js' }), 'Working');
  assert.equal(stage({ state: 'running', pr: { state: 'OPEN', draft: true, checks: { pass: 3 } } }), 'Working', 'a draft is not up for review');
  assert.equal(stage({ state: 'running', pr: { state: 'OPEN', checks: { pending: 1, pass: 2 } } }), 'Checks');
  assert.equal(stage({ state: 'running', pr: { state: 'OPEN', checks: { fail: 1, pass: 2 } } }), 'Checks', 'failing checks are still checks');
  assert.equal(stage({ state: 'running', pr: { state: 'OPEN', checks: { pass: 0, fail: 0, pending: 0 } } }), 'Checks', 'none reported yet');
  assert.equal(stage({ state: 'running', pr: { state: 'OPEN', checks: { pass: 3 } } }), 'Your review');
  assert.equal(stage({ state: 'running', pr: { state: 'MERGED', checks: {} } }), 'Merged');
  assert.equal(stage({ state: 'running', prs: [{ repo: 'a/b', pr: { state: 'OPEN', checks: { pass: 1 } } }] }), 'Your review', 'a PR its agent attached counts');
  assert.equal(stage({ state: 'running', pr: { state: 'CLOSED', checks: {} } }), 'Working', 'a closed PR says nothing about how far this is');
  assert.equal(stage({ state: 'review' }), 'Your review', 'finished, no PR: yours to read');
  assert.equal(stage({ state: 'review', pr: { state: 'OPEN', checks: { pending: 2 } } }), 'Checks');
});

test('plans show what Settings shows, turned around, for accounts that are still there', () => {
  const now = 1000;
  const agents = [
    { id: 'claude', name: 'Claude Code', budget: [{ account: 'default', windows: [{ id: 'seven_day', label: 'Weekly', used: 0.384, resetsAt: 2000 }, { id: 'five_hour', label: '5-hour', used: 0.2, resetsAt: 500 }] }, { account: 'gone', windows: [{ id: 'seven_day', label: 'Weekly', used: 0.1, resetsAt: 2000 }] }] },
    { id: 'codex', name: 'Codex', accounts: [{ id: 'a', label: 'work' }, { id: 'b', label: 'home' }], budget: [{ account: 'a', windows: [{ id: 'w', label: 'Weekly', used: 0.825, resetsAt: 3000 }] }, { account: 'c', windows: [{ id: 'w', label: 'Weekly', used: 0.5, resetsAt: 3000 }] }] },
    { id: 'cursor', name: 'Cursor' },
  ];
  assert.deepEqual(
    plansOf(agents, now).map((r) => [r.name, r.account, r.label, r.left]),
    [
      ['Claude Code', '', 'Weekly', 62],
      ['Codex', 'work', 'Weekly', 17],
    ],
  );
});

test('an open PR counts unless it is a draft, closed or merged', () => {
  assert.ok(openPr({ pr: { state: 'OPEN' } }));
  assert.ok(openPr({ prs: [{ pr: { state: 'MERGED' } }, { pr: { state: 'OPEN' } }] }));
  assert.ok(!openPr({ pr: { state: 'OPEN', draft: true } }));
  assert.ok(!openPr({ pr: { state: 'MERGED' } }));
  assert.ok(!openPr({}));
});

test('quiet is a fact about a running task, never about one that is asking', () => {
  const now = 100 * 60_000;
  const at = (min) => now - min * 60_000;
  assert.equal(quietFor({ state: 'running', updatedAt: at(12) }, now), 'Quiet for 12 min');
  assert.equal(quietFor({ state: 'running', updatedAt: at(9) }, now), '', 'not yet');
  assert.equal(quietFor({ state: 'running', updatedAt: at(180) }, now), 'Quiet for 3 h');
  assert.equal(quietFor({ state: 'running', asks: true, updatedAt: at(30) }, now), '');
  assert.equal(quietFor({ state: 'running', tui: true, updatedAt: at(30) }, now), '', 'a terminal reports nothing here');
  assert.equal(quietFor({ state: 'waiting', updatedAt: at(30) }, now), '');
  assert.equal(quietFor({ state: 'review', updatedAt: at(30) }, now), '');
});

test('usage is one line: the tightest window of each account', () => {
  const r = (agent, name, account, label, left) => ({ agent, name, account, label, left });
  assert.equal(plansLine([r('claude', 'Claude Code', '', 'Weekly', 62), r('claude', 'Claude Code', '', '5-hour', 88), r('codex', 'Codex', 'work', 'Weekly', 18)]), 'Claude Code 62% weekly · Codex (work) 18% weekly');
  assert.equal(plansLine([]), '');
});
