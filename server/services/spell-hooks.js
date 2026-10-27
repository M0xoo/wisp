// Spell hooks: what spells do on their own when something happens to a task. A hook fires at most
// its `max` times per task (default once), so a spell that replies to failed tests can't loop.
//
//   turn.finished    a turn ended with the agent's report     turn.failed   a turn ended in an error
//   session.started  a new task started                       session.waiting  a task asks you something

import { sessionToMarkdown } from '../render.js';
import { summarize } from '../runner.js';
import { fillTemplate } from '../../web/js/spell-schema.js';
import { VERSION, clip } from '../util.js';

// Did the turn's tests fail (its own tests block, or Auto's check)?
export function testsFailed(session, turn) {
  const blocks = turn?.presentation?.blocks || [];
  if (blocks.some((b) => b.type === 'tests' && Number(b.failed) > 0)) return true;
  return session.auto?.checks?.at(-1)?.verdict === 'fail';
}

export function hookMatches(cond = {}, { session, turn, summary }) {
  const list = (v) => (Array.isArray(v) ? v : [v]);
  if (cond.status !== undefined && !list(cond.status).includes(summary.status) && !list(cond.status).includes(turn?.status)) return false;
  if (cond.testsFailed !== undefined && testsFailed(session, turn) !== !!cond.testsFailed) return false;
  if (cond.agent !== undefined && !list(cond.agent).includes(session.agent)) return false;
  if (cond.project !== undefined && !list(cond.project).some((p) => p === summary.project || p === summary.projectId)) return false;
  if (cond.hasPr !== undefined && !!(session.pr || session.prs?.length) !== !!cond.hasPr) return false;
  if (cond.mode !== undefined && !list(cond.mode).includes(session.mode)) return false;
  return true;
}

export function createSpellHooks(app) {
  const { runner, store, spells } = app;
  const waiting = new Set(); // sessions already reported as waiting, until they move on

  const skip = (s) => !s || s.agent === 'wisp' || s.parentId || s.kind === 'spell';

  async function act(spell, hook, s) {
    const [k, v] = Object.entries(hook.do || {})[0] || [];
    const summary = summarize(s, store);
    const text = typeof v === 'string' ? fillTemplate(v, summary) : v;
    switch (k) {
      case 'reply':
        runner.reply(s, `${text}`, [], { by: 'wisp' });
        break;
      case 'done':
        app.launcher.markDone(s);
        break;
      case 'archive':
        if (s.state === 'running' || s.state === 'waiting') return;
        s.archived = true;
        s.unread = false;
        app.sessionChanged(s);
        break;
      case 'forLater':
        if (s.state === 'running' || s.state === 'waiting' || s.archived || runner.live.has(s.id)) return;
        s.forLater = { at: Date.now(), by: 'user' };
        app.sessionChanged(s);
        break;
      case 'notify':
        app.broadcast('spell', { toast: clip(text, 200), spell: spell.name, session: s.id });
        await app.remote?.send?.({ title: `🧙 ${spell.name}`, text, actions: [] }).catch(() => {});
        break;
      case 'webhook':
        await fetch(v, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': `wisp/${VERSION}` },
          body: JSON.stringify({ event: hook.on, spell: spell.id, session: summary, markdown: sessionToMarkdown(s), at: Date.now() }),
          signal: AbortSignal.timeout(10_000),
        });
        break;
      default:
        return;
    }
    app.telemetry?.track('spell_hook', { on: hook.on, action: k });
  }

  function fire(event, s, turn = s?.turns?.at(-1)) {
    if (skip(s)) return;
    const summary = summarize(s, store);
    for (const { spell, hook } of spells.hooks(event)) {
      if (spell.harnesses && !spell.harnesses.includes('*') && !spell.harnesses.includes(s.agent)) continue;
      if (spells.hookCount(spell.id, hook.id, s.id) >= hook.max) continue;
      if (!hookMatches(hook.if, { session: s, turn, summary })) continue;
      spells.countHook(spell.id, hook.id, s.id);
      // After the event's own handlers: a reply must not start inside the turn that's ending.
      setTimeout(() => act(spell, hook, s).catch((err) => console.warn(`wisp: spell ${spell.id} hook ${hook.id}: ${err.message}`)), 50);
    }
  }

  runner.on('ended', ({ session, turn, interrupted }) => {
    if (interrupted || turn.status === 'stopped') return;
    fire(turn.status === 'error' ? 'turn.failed' : 'turn.finished', session, turn);
  });
  runner.on('started', ({ session }) => {
    if (session.turns.length === 1) fire('session.started', session);
  });
  runner.on('summary', (sum) => {
    if (sum.state !== 'waiting') return void waiting.delete(sum.id);
    if (waiting.has(sum.id)) return;
    waiting.add(sum.id);
    fire('session.waiting', store.get(sum.id));
  });

  return { fire };
}
