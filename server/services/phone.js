// Phone (ntfy / Telegram): what a tap or a reply there does to a session, here or on a machine.

import { splitId } from '../machines.js';

export function phoneActions(app) {
  const { store, runner, machines } = app;

  // What the phone can do to a session, here or on a machine: { s, answer, reply, done } or null.
  async function sessionOps(sessionId) {
    const at = splitId(sessionId);
    if (!at) {
      const s = store.get(sessionId);
      return s && { s, answer: (a) => runner.answer(s, a), reply: (t) => app.launcher.replyTo(s, t), done: () => app.launcher.markDone(s) };
    }
    const call = (method, p, body) => machines.json(at.machine, method, `/sessions/${at.id}${p}`, body);
    const s = await call('GET', '').catch((err) => {
      if (err.status === 404) return null;
      throw err;
    });
    const live = s && (s.state === 'running' || s.state === 'waiting');
    return s && { s: machines.session(at.machine, s), answer: (a) => call('POST', '/answer', { text: a }), reply: (t) => call('POST', '/reply', { text: t }), done: async () => !live && !!(await call('PATCH', '', { state: 'done' })) };
  }

  return {
    // /new from Telegram: the launcher's remembered harness, model and mode, like `wisp "…"`.
    launch: async ({ project, prompt }) => {
      const d = store.config.defaults;
      const agent = d.agent || 'claude';
      const model = d.models?.[agent] ?? d.model ?? '';
      const [s] = await app.launcher.launchAny({ prompt, cwd: project.path, machine: project.machine || undefined, agent, model, mode: d.mode || 'edits' }, { kind: 'telegram', name: 'Telegram' });
      app.broadcast('config', {});
      return s;
    },
    act: async ({ sessionId, kind, ref, index, text }) => {
      const ops = await sessionOps(sessionId).catch((err) => ({ error: err.message }));
      if (ops?.error) return `Can’t reach it: ${ops.error}`;
      if (!ops) return 'That session is gone.';
      const { s } = ops;
      if (kind === 'answer') {
        if (!s.ask || s.ask.id !== ref) return 'That question was already answered.';
        const answer = s.ask.options[index];
        if (answer === undefined) return 'Unknown option.';
        await ops.answer(answer);
        return `✓ Answered: ${answer}`;
      }
      if (kind === 'reply') {
        const turn = s.turns.at(-1);
        if (!turn || turn.id !== ref || s.state === 'running') return 'That was already answered.';
        const q = turn.presentation?.blocks?.findLast((b) => b?.type === 'question');
        const o = q?.options?.[index];
        const msg = typeof o === 'string' ? o : o?.reply || o?.label;
        if (!msg) return 'Unknown option.';
        await ops.reply(msg);
        return `✓ Sent: ${typeof o === 'string' ? o : o.label || msg}`;
      }
      if (kind === 'done') {
        if (s.turns.at(-1)?.id !== ref && ref) return 'There is newer work on that session; open wisp to review it.';
        return (await ops.done()) ? '✓ Marked done' : 'It is still working.';
      }
      if (s.agent === 'wisp') return 'That is the tour; it can’t take follow-ups.';
      const r = await ops.reply(String(text || '').trim());
      return r.answered ? '✓ Answered' : r.interrupted ? '✓ Sent; the agent picked it up mid-run' : r.queued ? '✓ Queued for when it finishes' : '✓ Sent';
    },
  };
}
