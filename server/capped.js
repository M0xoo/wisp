// A task a channel started at a mode cap (Slack, GitHub, a Telegram group): whoever could write there
// asked for it, so it mustn't get further through wisp's own tools than the channel could.
// session.capped = { mode }: written once at the start (services/phone.js), kept on follow-ups, and
// copied to whatever it starts. You choosing a higher mode in wisp clears it for that task
// (POST /sessions/:id/reply). A session without it, old or yours, works as it always did.
// The rules are the routes' (routes/control.js, routes/internal.js, routes/connectors.js), by the
// session a call authenticates as (agent-token.js): hiding tools (mcp-ask.js offered) proves nothing.

import fs from 'node:fs';
import path from 'node:path';
import { MODE_LABEL, MODE_RANK } from './channels/policy.js';

// null at Full auto: that channel lets a message do anything already.
export const cappedAt = (cap) => (MODE_RANK[cap] < MODE_RANK.auto ? { mode: cap } : null);
export const cappedFrom = (v) => cappedAt(v?.mode) || null;
export const aboveCap = (mode, capped) => !!capped && MODE_RANK[mode] > MODE_RANK[capped.mode];
export const atCap = (mode, capped) => (aboveCap(mode, capped) ? capped.mode : mode);
// The lower of a channel's cap and the task's own.
export const tighter = (cap, capped) => (aboveCap(cap, capped) ? capped.mode : cap);

// What the agent reads: plain, and with what to do instead.
export const cappedRefusal = (what) => `Refused: this task was started from a channel with a mode cap, so it can't ${what}. Say so in your report; the user can do it in wisp.`;
export const overCap = (mode, capped) => `Refused: ${MODE_LABEL[mode]} is above this task's cap of ${MODE_LABEL[capped.mode]}, set by the channel that started it. Use ${MODE_LABEL[capped.mode]} or lower; the user can raise it in wisp.`;

// A session's project: its lead's for a subagent (whose folder is the lead's worktree), else its
// folder, for a task in none.
export function projectKey(store, s) {
  let x = s;
  for (let n = 0; x?.parentId && n < 5; n++) x = store.get(x.parentId) || { cwd: x.cwd };
  return store.projectFor?.(x?.cwd)?.id || x?.cwd || '';
}
// dir is a folder an agent named: `..` and links don't get it out, and a project inside this one is another.
export function inProject(store, s, dir) {
  const at = path.resolve(String(dir));
  if ((store.projectFor?.(at)?.id || at) !== projectKey(store, s)) return false;
  return insideFolders(at, [store.projectFor?.(at)?.path || at]);
}
export const startedBy = (s, x) => x?.origin?.kind === 'task' && x.origin.id === s.id;
export const ownProject = (store, s, x) => x.id === s.id || startedBy(s, x) || projectKey(store, x) === projectKey(store, s);

// What My Stuff came from: only a task of this project counts. The user's own uploads don't.
export const ownItem = (store, s, it) => {
  const from = it?.from?.session && store.get(it.from.session);
  return !!from && ownProject(store, s, from);
};

// A path the server is asked to read for the agent: inside its folders, links followed.
export function insideFolders(file, roots) {
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const at = real(file);
  return roots.some((r) => at === real(r) || at.startsWith(real(r) + path.sep));
}
