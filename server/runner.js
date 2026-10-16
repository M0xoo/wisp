// Session orchestration: launches turns on adapters, folds their events into the
// session record, and handles follow-ups that arrive while the agent is busy: by default
// they interrupt the run and resume the session with the new message; with the `queue`
// setting they wait until the run finishes.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapters } from './adapters/index.js';
import { SYSTEM_PROMPT, parsePresentation, heroOf } from './protocol.js';

const MAX_ACTIVITY = 400;
const LINGER_MS = 3000; // how long a CLI may keep running after it reported its result
const ASK_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-ask.js');

export const newId = () => randomUUID().replace(/-/g, '').slice(0, 12);

function autoTitle(prompt) {
  const line = prompt.trim().split('\n')[0].replace(/\s+/g, ' ');
  return line.length > 64 ? `${line.slice(0, 63)}…` : line;
}

export function summarize(s, store) {
  const project = store?.projectFor(s.cwd);
  const last = s.turns.at(-1);
  const hero = heroOf(last?.presentation);
  const lastAct = last?.activity?.findLast?.((a) => a.kind !== 'text');
  return {
    id: s.id,
    title: s.title,
    agent: s.agent,
    cwd: s.cwd,
    project: s.agent === 'wisp' ? 'tour' : project?.name || path.basename(s.cwd || ''),
    projectId: project?.id || null,
    color: project?.color || 'slate',
    mode: s.mode,
    model: s.model,
    state: s.state,
    unread: s.unread,
    archived: !!s.archived,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    turnCount: s.turns.length,
    queued: s.queue?.length || 0,
    status: last?.status === 'running' ? 'running' : hero?.status || (last?.status === 'error' ? 'blocked' : 'info'),
    preview: hero?.summary || '',
    live: s.ask ? `Asks: ${s.ask.question}` : last?.status === 'running' ? lastAct?.label || 'Starting up' : '',
    asks: !!s.ask || !!last?.presentation?.blocks?.some((b) => b.type === 'question'),
    question: s.ask?.question || '',
  };
}

export class Runner extends EventEmitter {
  // bridge: { url, token } — how the injected ask_user MCP server reaches us.
  constructor(store, bridge) {
    super();
    this.store = store;
    this.bridge = bridge;
    this.live = new Map(); // sessionId -> adapter handle
    this.stopping = new Set();
    this.interrupting = new Set();
    this.answers = new Map(); // askId -> answer, until the MCP server picks it up

    // Anything that was mid-flight when wisp last died is now orphaned.
    for (const s of store.all()) {
      const t = s.turns.at(-1);
      delete s.ask;
      if (s.state === 'running' || s.state === 'waiting' || t?.status === 'running') {
        if (t?.status === 'running') this.#finishTurn(s, t, { isError: true, stopped: true, text: '' }, 'wisp was restarted while this was running.');
        s.state = 'review';
        store.save(s);
      }
    }
  }

  create({ prompt, cwd, agent = 'claude', mode = 'edits', model = '', attachments = [] }) {
    if (!adapters[agent]) throw new Error(`Unknown agent: ${agent}`);
    const now = Date.now();
    const session = {
      id: newId(),
      title: autoTitle(prompt),
      titleAuto: true,
      agent,
      cwd,
      mode,
      model,
      state: 'running',
      unread: false,
      createdAt: now,
      updatedAt: now,
      agentSessionId: null,
      queue: [],
      turns: [],
    };
    this.store.put(session);
    this.store.touchProject(cwd);
    this.#startTurn(session, prompt, attachments);
    return session;
  }

  reply(session, text, attachments = [], { queue = false } = {}) {
    if (session.ask) {
      this.answer(session, text);
      return { answered: true };
    }
    const handle = this.live.get(session.id);
    if (handle) {
      const turn = session.turns.at(-1);
      // The run already produced its result and the CLI is only lingering on its way out:
      // there's nothing to wait for, so let it go and start the follow-up now.
      if (turn?.status !== 'running') {
        session.queue.push({ id: newId(), text, attachments });
        handle.release();
        return { queued: session.queue.length > 0 };
      }
      // Interrupting needs an agent session to resume; before the agent reports one, queue.
      if (queue || !session.agentSessionId) {
        session.queue.push({ id: newId(), text, attachments });
        this.#touch(session);
        return { queued: true, ahead: session.queue.length - 1 };
      }
      // Ahead of anything queued, but after earlier interrupting follow-ups, so they keep their order.
      const at = session.queue.findIndex((q) => !q.now);
      session.queue.splice(at < 0 ? session.queue.length : at, 0, { id: newId(), text, attachments, now: true });
      this.#interrupt(session);
      return { interrupted: true };
    }
    this.#startTurn(session, text, attachments);
    return { queued: false };
  }

  // Drop a follow-up that hasn't gone out yet.
  unqueue(session, itemId) {
    const at = session.queue.findIndex((q) => q.id === itemId);
    if (at < 0) return false;
    session.queue.splice(at, 1);
    this.#touch(session);
    return true;
  }

  // ask_user: the agent is blocked inside a tool call until answer() is called.
  ask(session, { question, context, options }) {
    const turn = session.turns.at(-1);
    session.ask = {
      id: newId(),
      question: String(question || '').trim() || 'The agent has a question.',
      context: context ? String(context) : '',
      options: Array.isArray(options) ? options.map(String).slice(0, 6) : [],
      askedAt: Date.now(),
    };
    session.state = 'waiting';
    session.unread = true;
    delete session.archived; // a question needs the user, so it comes back to the feed
    if (turn) this.#onEvent(session, turn, { type: 'tool', kind: 'ask', label: `Asked you: ${session.ask.question}` });
    this.#touch(session, { turn: turn?.id });
    this.emit('finished', { session: summarize(session, this.store) });
    return session.ask.id;
  }

  answer(session, text) {
    const ask = session.ask;
    if (!ask) return false;
    ask.answer = text;
    this.answers.set(ask.id, text);
    delete session.ask;
    session.state = this.live.has(session.id) ? 'running' : 'review';
    const turn = session.turns.at(-1);
    if (turn) this.#onEvent(session, turn, { type: 'tool', kind: 'answer', label: `You answered: ${text}` });
    this.#touch(session, { turn: turn?.id });
    return true;
  }

  pollAnswer(askId) {
    if (this.answers.has(askId)) {
      const answer = this.answers.get(askId);
      this.answers.delete(askId);
      return { answer };
    }
    const open = this.store.all().some((s) => s.ask?.id === askId);
    return open ? { pending: true } : { cancelled: true };
  }

  stop(session) {
    session.queue = [];
    delete session.ask;
    if (!this.live.has(session.id)) return;
    this.stopping.add(session.id);
    this.live.get(session.id).stop();
  }

  // Stop the current run but keep the queue: done.finally() starts the next follow-up.
  #interrupt(session) {
    if (this.interrupting.has(session.id)) return; // already on its way down
    this.interrupting.add(session.id);
    this.stopping.add(session.id);
    this.live.get(session.id).stop();
  }

  #startTurn(session, prompt, attachments = []) {
    const turn = {
      id: newId(),
      prompt,
      agent: session.agent,
      model: session.model,
      attachments: attachments.map(({ id, name, mime, size }) => ({ id, name, mime, size })),
      startedAt: Date.now(),
      endedAt: null,
      status: 'running',
      activity: [],
      changes: [],
      presentation: null,
      stats: null,
    };
    session.turns.push(turn);
    session.state = 'running';
    session.unread = false;
    delete session.archived;
    this.#touch(session, { turn: turn.id });

    let released = false;
    let linger;
    const adapter = adapters[session.agent];
    const handle = adapter.run({
      prompt,
      attachments,
      cwd: session.cwd,
      resumeId: session.agentSessionId,
      mode: session.mode,
      model: session.model,
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: this.bridge
        ? {
            wisp: {
              command: process.execPath,
              args: [ASK_SERVER],
              // Inside the desktop app execPath is the Electron binary; without
              // ELECTRON_RUN_AS_NODE it boots a second app (extra Dock icon) per turn.
              env: { ELECTRON_RUN_AS_NODE: '1', WISP_URL: this.bridge.url, WISP_TOKEN: this.bridge.token, WISP_SESSION: session.id },
            },
          }
        : {},
      onEvent: (ev) => {
        if (released) return; // a lingering process we already let go of
        this.#onEvent(session, turn, ev);
        // A CLI can outlive its result (flushing, or a background process it spawned holding
        // stdout open, so 'close' never fires). Don't hold the session hostage to that.
        if (ev.type === 'result') linger = setTimeout(release, LINGER_MS);
      },
    });
    // Ends the run exactly once: on exit, LINGER_MS after the result, or when a follow-up arrives.
    const release = () => {
      if (released) return;
      if (turn.status === 'running') this.#finishTurn(session, turn, { isError: true, text: 'The agent exited without a result.' });
      released = true;
      clearTimeout(linger);
      handle.stop();
      if (this.live.get(session.id) !== handle) return;
      this.live.delete(session.id);
      this.interrupting.delete(session.id);
      this.stopping.delete(session.id); // a stop that landed after the result has nothing left to stop
      const next = session.queue.shift();
      if (next && this.store.get(session.id)) this.#startTurn(session, next.text, next.attachments);
      else this.#touch(session);
    };
    handle.release = release;
    this.live.set(session.id, handle);
    handle.done.finally(release);
  }

  #onEvent(session, turn, ev) {
    switch (ev.type) {
      case 'session':
        session.agentSessionId = ev.id;
        return;
      case 'tool':
      case 'tool_error':
      case 'text': {
        const item = { t: Date.now(), kind: ev.type === 'tool' ? ev.kind : ev.type === 'text' ? 'text' : 'error' };
        if (ev.type === 'tool') Object.assign(item, { label: ev.label, file: ev.file, detail: ev.detail });
        else if (ev.type === 'text') item.label = ev.text.slice(0, 600);
        else item.label = `${ev.name || 'Tool'} failed: ${ev.text}`;
        turn.activity.push(item);
        if (turn.activity.length > MAX_ACTIVITY) turn.activity.splice(0, turn.activity.length - MAX_ACTIVITY);
        this.emit('activity', { sessionId: session.id, turnId: turn.id, item });
        this.#touch(session, { quiet: ev.type === 'text' });
        return;
      }
      case 'change': {
        let entry = turn.changes.find((c) => c.file === ev.file);
        if (!entry) turn.changes.push((entry = { file: ev.file, op: ev.op, edits: [] }));
        if (ev.op === 'create' && entry.edits.length === 0) entry.op = 'create';
        entry.edits.push(...ev.edits);
        this.store.save(session);
        return;
      }
      case 'result':
        this.#finishTurn(session, turn, ev);
        return;
    }
  }

  #finishTurn(session, turn, ev, reason) {
    turn.endedAt = Date.now();
    turn.stats = ev.stats || null;
    delete session.ask;
    if (this.stopping.delete(session.id)) ev = { ...ev, stopped: true };
    const interrupted = ev.stopped && this.interrupting.has(session.id);
    if (ev.stopped) {
      turn.status = 'stopped';
      turn.presentation = {
        blocks: [
          interrupted
            ? { type: 'hero', title: 'Interrupted', summary: 'You sent a follow-up while this was running, so it picked that up instead.', status: 'partial' }
            : { type: 'hero', title: 'Stopped', summary: reason || 'You stopped this run. Follow up to pick it back up.', status: 'partial' },
          ...(turn.changes.length ? [{ type: 'files', items: turn.changes.map((c) => ({ path: c.file, change: c.op === 'create' ? 'added' : 'modified' })) }] : []),
        ],
      };
    } else if (ev.isError) {
      turn.status = 'error';
      turn.presentation = {
        blocks: [
          { type: 'hero', title: 'Something went wrong', summary: 'The agent run ended with an error.', status: 'blocked' },
          { type: 'terminal', command: `${session.agent} run`, output: ev.text || 'No output.', exitCode: 1 },
          { type: 'next', items: ['Try again', 'Explain what went wrong'] },
        ],
      };
    } else {
      turn.status = 'done';
      turn.raw = ev.text; // kept so the turn can be re-parsed if the parser improves
      turn.presentation = parsePresentation(ev.text);
      this.store.keepImages(session, turn);
      const hero = heroOf(turn.presentation);
      if (hero?.title && session.titleAuto && session.turns.length === 1) session.title = hero.title;
    }
    session.state = 'review';
    session.unread = !interrupted;
    this.store.save(session, { now: true });
    this.#touch(session, { turn: turn.id });
    // The follow-up starts right away; don't notify for the run it replaced.
    if (!interrupted) this.emit('finished', { session: summarize(session, this.store) });
  }

  #touch(session, { turn, quiet } = {}) {
    session.updatedAt = Date.now();
    this.store.save(session);
    if (!quiet) this.emit('summary', summarize(session, this.store));
    if (turn) this.emit('turn', { sessionId: session.id, turnId: turn });
  }
}
