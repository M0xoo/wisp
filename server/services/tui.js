// Terminal sessions (Settings → General): a task you start is the agent's own CLI in a terminal in
// the page (server/pty.js), started on your prompt, instead of wisp's headless run and its cards.
// wisp keeps the task (folder, worktree, title, the prompt as its turn) and the terminal stays its
// view: follow-ups are typed into it, and once it ends, opening the task resumes the conversation.

import crypto from 'node:crypto';
import { adapters } from '../adapters/index.js';
import { ptySupported } from '../pty.js';
import { alsoDirs, workdir } from '../runner.js';

// Told to the agent on top of its own system prompt, where the CLI takes one (Claude Code).
const TUI_NOTE = `You are running inside wisp, in a terminal the user is watching: they read your replies here and
answer you directly. Work as in any interactive session; answer in plain text.`;

// A take over: the run's instructions asked for a `wisp` block that only wisp's page reads.
export const TAKEOVER_NOTE = `The user took this session over from wisp and reads your replies in a terminal now. From here on,
answer them directly in plain text, with no \`wisp\` block, whatever earlier instructions said.`;

// Whether a launch starts as a terminal session: one you start by hand, on one harness, that wisp
// doesn't have to drive itself (crew jobs, schedules, spells, goals, teams, held tasks).
export function startsInTerminal(body, { on, agent, origin, crew, kind, goal, comparing, team, hold }) {
  if (!(body.tui ?? on) || !ptySupported()) return false;
  return !origin && !crew && !kind && !goal && !comparing && !team && !hold && !!adapters[agent]?.resumeCommand;
}

// The CLI's argv for task s: resumed when it has a conversation, else a new one on prompt (named by
// wisp where the CLI lets it, so it can be resumed later).
export function tuiArgv(app, s, { prompt = '' } = {}) {
  const adapter = adapters[s.agent];
  const trusted = app.store.isScratch(s.cwd) || !!s.worktree?.cwd;
  if (trusted) adapter.trust?.(workdir(s));
  let sessionId;
  if (!s.agentSessionId && adapter.sessionIds) {
    sessionId = crypto.randomUUID();
    s.agentSessionId = sessionId;
    s.agentSessions = { ...s.agentSessions, [s.agent]: sessionId };
  } else if (s.agentSessionId && adapter.hasSession && !adapter.hasSession(s.agentSessionId, workdir(s))) {
    // Its CLI exited before it kept the conversation (a question at start-up, Ctrl+C): it starts
    // again under the same id, on the task's first prompt (and the follow-up, if one brought it).
    sessionId = s.agentSessionId;
    prompt = [s.turns[0]?.prompt, prompt].filter(Boolean).join('\n\n');
  }
  const system = `${TUI_NOTE}${app.runner.terminalNote?.(s) || ''}`;
  const argv = adapter.resumeCommand({ resumeId: sessionId ? undefined : s.agentSessionId, sessionId, model: s.model, effort: s.effort, dirs: alsoDirs(s), cwd: workdir(s), trusted, mode: s.mode, systemPrompt: system, prompt: adapter.typesPrompt ? '' : prompt });
  return { argv, typed: adapter.typesPrompt ? prompt : '' };
}

// Open task s's terminal on prompt (its first one, or a follow-up once the last terminal ended).
export function openTui(app, s, { prompt = '', cols, rows } = {}) {
  const { argv, typed } = tuiArgv(app, s, { prompt });
  const t = app.terms.open(s.id, { argv, cwd: workdir(s), cols, rows });
  if (typed) typeWhenReady(app.terms, s.id, t, typed);
  app.store.save(s);
  return t;
}

// A CLI that takes no first prompt: pasted in (bracketed, so newlines don't send it early) once its
// screen has settled.
function typeWhenReady(terms, id, t, text, { settle = 1500, max = 30_000 } = {}) {
  const started = Date.now();
  const tick = setInterval(() => {
    if (t.code !== null || Date.now() - started > max) return clearInterval(tick);
    if (!t.out || Date.now() - t.usedAt < settle) return;
    clearInterval(tick);
    terms.input(id, `\x1b[200~${text}\x1b[201~\r`);
  }, 250);
  tick.unref?.();
}

// A follow-up on a terminal session goes to its CLI: typed into the open terminal, or the terminal
// opens again on it.
export function tuiReply(app, s, text) {
  const t = app.terms.get(s.id);
  if (t && t.code === null) app.terms.input(s.id, `\x1b[200~${text}\x1b[201~\r`);
  else openTui(app, s, { prompt: text });
  return { ok: true, terminal: true };
}
