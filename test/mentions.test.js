// Task mentions: the prompt box's stored form (web/js/mention-text.js), what agents get
// (server/mentions.js) and what wisp_session returns (server/routes/internal.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentPrompt, mentionsIn, plainMentions, textMentions } from '../server/mentions.js';
import { sessionText } from '../server/routes/internal.js';
import { cleanTitle, decode, encode, mentionHtml, pastedTasks, plain, spans } from '../web/js/mention-text.js';

const A = 'a1b2c3d4e5f6';
const B = '0123456789ab';
const stored = `Use @[Login limiter](wisp:${A}) and @[Login](wisp:${B}), then @[Login limiter](wisp:${A}) again`;

test('decode shows titles and keeps each mentioned task once; encode turns them back', () => {
  const d = decode(stored);
  assert.equal(d.text, 'Use @Login limiter and @Login, then @Login limiter again');
  assert.deepEqual(d.mentions, [{ id: A, title: 'Login limiter' }, { id: B, title: 'Login' }]);
  assert.equal(encode(d.text, d.mentions), stored);
});

test('spans: longest title first, no overlaps; an edited mention is plain text again', () => {
  const { text, mentions } = decode(stored);
  assert.deepEqual(spans(text, mentions).map((s) => [text.slice(s.start, s.end), s.id]), [['@Login limiter', A], ['@Login', B], ['@Login limiter', A]]);
  assert.equal(encode('Use @Login limitr', mentions), `Use @[Login](wisp:${B}) limitr`);
  assert.equal(encode('nothing here', mentions), 'nothing here');
});

test('titles lose ] and newlines so they fit the stored form', () => {
  assert.equal(cleanTitle('Fix [auth]\nflow'), 'Fix [auth flow');
  assert.equal(cleanTitle(''), 'Untitled task');
  const t = cleanTitle('a]b');
  assert.equal(decode(encode(`@${t}`, [{ id: A, title: t }])).text, `@${t}`);
});

test('pastedTasks: only text made of known task references', () => {
  const known = (id) => id === A || id === B;
  assert.deepEqual(pastedTasks(` ${A} `, known), [A]);
  assert.deepEqual(pastedTasks(`wisp:${A}\nhttp://localhost:4321/#/s/${B}`, known), [A, B]);
  assert.equal(pastedTasks('deadbeefcafe', known), null, 'a hex string that is no task');
  assert.equal(pastedTasks(`see ${A}`, known), null, 'other words: pasted as text');
  assert.equal(pastedTasks('', known), null);
});

test('mentionHtml and plain: chips in sent prompts, titles for people', () => {
  assert.equal(mentionHtml(`hi @[T &amp; x](wisp:${A})`), `hi <a class="mn" href="#/s/${A}" title="Open this task">@T &amp; x</a>`);
  assert.equal(mentionHtml(`@[T](wisp:${A})`, { link: false }), '<span class="mn">@T</span>');
  assert.equal(plain(stored), 'Use @Login limiter and @Login, then @Login limiter again');
});

const store = (sessions) => ({ get: (id) => sessions.find((s) => s.id === id), projectFor: () => ({ id: 'p1', name: 'api' }) });
const target = {
  id: A,
  title: 'Login limiter',
  state: 'review',
  agent: 'codex',
  model: 'gpt-5',
  cwd: '/work/api',
  updatedAt: Date.now() - 2 * 3600_000,
  worktree: { path: '/wt/api-limiter', branch: 'wisp/limiter' },
  turns: [
    { id: 't1', prompt: 'Add a limiter', status: 'done', presentation: { blocks: [{ type: 'hero', title: 'First pass', summary: 'Added it.', status: 'done' }] }, changes: [{ file: 'a.js', edits: [] }] },
    { id: 't2', prompt: `Compare with @[Other](wisp:${B})`, status: 'done', presentation: { blocks: [{ type: 'hero', title: 'Limiter done', summary: '5 per minute.', status: 'done' }] }, changes: [] },
  ],
};

test('server side: agents get title and id plus how to read it; people get titles', () => {
  assert.deepEqual(mentionsIn(stored), [{ id: A, title: 'Login limiter' }, { id: B, title: 'Login' }]);
  assert.equal(plainMentions(`x @[T](wisp:${A})`), 'x @T');
  assert.equal(textMentions(`x @[T](wisp:${A})`), `x @T (wisp task ${A})`);
  const p = agentPrompt(`Carry on from @[Login limiter](wisp:${A})`, store([target]), { tool: 'mcp__wisp__wisp_session' });
  assert.match(p, new RegExp(`^Carry on from @Login limiter \\(wisp task ${A}\\)\n\n<wisp-tasks>`));
  assert.match(p, /Read one with `wisp_session` \(mcp__wisp__wisp_session\)/);
  assert.match(p, new RegExp(`\`${A}\` \\*\\*Login limiter\\*\\*: review, codex, 2 turns, in \`/wt/api-limiter\``));
  assert.equal(agentPrompt('no mentions', store([])), 'no mentions');
});

test('server side: a run without wisp tools gets the report inline; an unknown task says so', () => {
  const p = agentPrompt(`See @[Login limiter](wisp:${A}) and @[Gone](wisp:${B})`, store([target]), { tool: null });
  assert.match(p, /Their latest reports:\n\n### Login limiter/);
  assert.match(p, /## Limiter done/);
  assert.match(p, new RegExp(`\`${B}\` \\(Gone\\): not on this computer`));
  // A task mentioning itself gets no note about itself.
  assert.equal(agentPrompt(`me @[Me](wisp:${A})`, store([target]), { self: A }), `me @Me (wisp task ${A})`);
});

test('wisp_session text: header, every request, and the chosen turn\'s report', () => {
  const t = sessionText(target, store([target]), null);
  assert.match(t, /^# Login limiter\nTask `a1b2c3d4e5f6` · review · codex \(gpt-5\) · project api · updated 2h ago/);
  assert.match(t, /Folder: `\/wt\/api-limiter` \(worktree, branch `wisp\/limiter`\)/);
  assert.match(t, /## Requests \(2\)\n1\. Add a limiter\n2\. Compare with @Other\n/);
  assert.match(t, /## Report for turn 2 of 2 \(pass turn to read another\)/);
  assert.match(t, /Limiter done/);
  const first = sessionText(target, store([target]), '1');
  assert.match(first, /## Report for turn 1 of 2/);
  assert.match(first, /First pass/);
  assert.match(first, /Files edited in this turn: `a\.js`/);
  assert.match(sessionText(target, store([target]), '9'), /Turn 9 doesn't exist; this task has 2\./);
});
