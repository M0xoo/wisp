// /side: a side discussion about a task, on a page of its own ("/side why did it pick sqlite?").
// Where /btw is one quick answer under the turn, a side discussion is a task of its own: you go
// back and forth with it, and its answers are full reports (blocks, apps, everything). It reads the
// main task's folder as it is now and gets the main task's latest state with every message, so it
// can always check on the work. It never changes anything: it runs in Plan (read-only), its
// approvals are refused, and wisp's tools that act (launch, delegate, crew edits…) aren't offered
// (server/mcp-ask.js, WISP_READONLY).

import { btwDigest } from './btw.js';
import { bad } from './util.js';

export const SIDE_CMD = /^\/side(?:\s+|$)/i;

// The opening message in "/side why …" ('' for a bare /side), or null when the text isn't a /side.
export function sideAsk(text) {
  const t = String(text || '').trim();
  return SIDE_CMD.test(t) ? t.replace(SIDE_CMD, '').trim() : null;
}

// A route that would change the work, on a side discussion: its folder is the main task's.
export function notSide(s, what = 'change the work') {
  if (s?.sideOf) throw bad(`A side discussion only reads: it can't ${what}. Do it on the main task.`, 409);
}

// Why an approval in a side discussion is refused (the harness hears it as the answer).
export const SIDE_DENIED = 'This is a read-only side discussion: nothing may be changed here. Do not retry; answer from what you can read, and say what the main task (or the user) would have to do.';

// The system prompt's part for a side discussion: what it is, and that it changes nothing.
export function sideNote(side, sessionTool = 'mcp__wisp__wisp_session') {
  const of = side.sideOf;
  return `

# wisp side discussion

This task is a side discussion about another wisp task, the main task “${of.title}” (wisp task ${of.id}). Another agent run does the main task's work; here you talk it over with the user: explain what it did and why, review it, weigh options, plan what to ask it next.

- Change nothing. No edits, no file writes, no commits, no branches, no installs, no commands with side effects, no new tasks. You run read-only; anything that would change something is refused.
- Read freely: the files in the folder you're in are the main task's work as it is right now (\`git status\`, \`git diff\`, \`git log\` show what it changed). ${sessionTool ? `\`${sessionTool}\` with id ${of.id} reads its whole record.` : ''}
- Every message from the user starts with the main task's latest state (under "The main task now"). It may have moved on since your last answer: go by the latest one.
- Answer as for any wisp task, wisp presentation block included. Where a change is wanted, say what to tell the main task (a follow-up the user can send there) instead of making it.`;
}

// What goes before each of the user's messages: the main task as it stands now. main is null
// once it's gone.
export function sidePrompt(main, text, name) {
  const head = main ? `## The main task now: “${main.title}”\n\n${btwDigest(main, name) || '_Nothing has run on it yet._'}` : '## The main task now\n\n_The main task was deleted: only what was said here, and its folder as it is, are left._';
  return `${head}\n\n---\n\n## The user, in this side discussion\n\n${text}`;
}
