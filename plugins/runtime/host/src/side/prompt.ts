// /side (v1 server/side.js, its prompts): a side discussion about a task, a task of its own that
// works in the main task's folder as it is now and gets the main task's latest state with every
// message. Every write it makes goes through wisp's gate first (side/gate.ts). These are its texts.

import { btwDigest } from '../btw-text.ts';
import type { NameOf } from '../handoff.ts';
import type { Session } from '../model.ts';
import { bad } from '../util.ts';

export const SIDE_CMD = /^\/side(?:\s+|$)/i;

/** The opening message in "/side why …" ('' for a bare /side), or null when the text isn't a /side. */
export function sideAsk(text: unknown): string | null {
  const t = String(text ?? '').trim();
  return SIDE_CMD.test(t) ? t.replace(SIDE_CMD, '').trim() : null;
}

/** A route that belongs to the main task, on a side discussion: its folder is the main task's. */
export function notSide(s: Session | undefined, what = 'change the work'): void {
  if (s?.sideOf) throw bad(`A side discussion can't ${what}: that stays with the main task. Do it on the main task.`, 409);
}

export const SIDE_DENIED = "This is a read-only side discussion: this harness can't ask wisp before a write, so nothing may be changed here. Do not retry; answer from what you can read, and say what the main task (or the user) would have to do.";

export const SIDE_APPLY = 'Apply and tell main task';
export const SIDE_KEEP = 'Keep main’s version';
export const SIDE_APPLY_OTHER = 'Apply it';
export const SIDE_KEEP_OTHER = 'Keep the other discussion’s version';
export const sideKept = (words: string, other = false): string =>
  `The user kept the ${other ? 'other side discussion' : 'main task'}'s version: nothing was changed.${words ? ` They said: ${words}` : ''} Do not retry this change. Say what the user could tell ${other ? 'that side discussion' : 'the main task'} instead (a follow-up they can send there).`;

/** The system prompt's part for a side discussion. name: the harness's, when it can't ask before a write. */
export function sideNote(side: Session, sessionTool = 'mcp__wisp__wisp_session', { edits = true, name = 'This harness' }: { edits?: boolean; name?: string } = {}): string {
  const of = side.sideOf;
  if (!of) return '';
  const read = `\`git status\`, \`git diff\`, \`git log\` show what it changed. ${sessionTool ? `\`${sessionTool}\` with id ${of.id} reads its whole record.` : ''}`;
  const open = `

# wisp side discussion

This task is a side discussion about another wisp task, the main task “${of.title}” (wisp task ${of.id}). Another agent run does the main task's work; here you talk it over with the user: explain what it did and why, review it, weigh options, plan what to ask it next.
`;
  const latest = `- Every message from the user starts with the main task's latest state (under "The main task now"). It may have moved on since your last answer: go by the latest one.`;
  if (!edits) {
    return `${open}
- Change nothing. No edits, no file writes, no commits, no branches, no installs, no commands with side effects, no new tasks. You run read-only; anything that would change something is refused. ${name} can’t ask wisp before a write, so side discussions on it only read.
- Read freely: the files in the folder you're in are the main task's work as it is right now (${read})
${latest}
- Answer as for any wisp task, wisp presentation block included. Where a change is wanted, say what to tell the main task (a follow-up the user can send there) instead of making it.`;
  }
  return `${open}
- You share the main task's folder: the files here are its work as it is right now (${read}) What you change lands in that work, and the main task may be editing at the same time.
- Run what the user asks and edit what they ask, when they ask. Don't start changes of your own: this is a discussion, the main task does the work.
- wisp checks every write before it happens. A file the main task hasn't touched goes through. One it changed elsewhere goes through with a warning. Lines it changed are a clash: the user sees a card here, and if they accept, wisp tells the main task. If they keep the main task's version your call is refused: don't retry it, and say what to tell the main task instead.
- Commits, pushes, resets, stashes, rebases, merges and the like rewrite the main task's work: they count as clashes, and so does a command that removes or writes over a file it changed (\`rm\`, \`>\`, \`sed -i\`, \`patch\`, \`cp\`…). wisp's own Ship, rollback, fork, goals and terminal stay on the main task. You can't start tasks, delegate or edit the crew.
${latest}
- Answer as for any wisp task, wisp presentation block included.`;
}

/** What goes before each of the user's messages: the main task as it stands now (null once it's gone). */
export function sidePrompt(main: Session | null, text: string, name: NameOf): string {
  const head = main ? `## The main task now: “${main.title}”\n\n${btwDigest(main, name) || '_Nothing has run on it yet._'}` : '## The main task now\n\n_The main task was deleted: only what was said here, and its folder as it is, are left._';
  return `${head}\n\n---\n\n## The user, in this side discussion\n\n${text}`;
}
