// Where a task came from, and the way back. A subagent's run opens by itself from its lead's card:
// it shows as a row under the lead (while one of them is open) and opens like any task. A crew
// member's job for another task is a task already (crew.js). Either way the open task's head names
// the tasks above it (the trail), and Back goes to the one it was opened from.

import { api } from '../core/api.js';
import { S } from '../core/state.js';
import { toast } from '../ui/toast.js';
import { renderFeed, reveal } from './feed.js';

const FOR_TASK = new Set(['delegated', 'mention', 'event']);
const subs = new Map(); // subagent id → its lead's id: opened by the user, shown under the lead
const cameFrom = new Map(); // task id → the task it was opened from (Back goes there)
let opening = null; // a subagent on its way open: kept even if its lead isn't open (a link)

// The task above `s`: a subagent's lead, or the task a crew job was done for.
export function parentOf(s) {
  if (!s) return null;
  if (s.parentId) return { id: s.parentId, title: S.sessions.get(s.parentId)?.title || 'its lead' };
  const f = FOR_TASK.has(s.crew?.job) && s.crew.from;
  return f?.id ? { id: f.id, title: S.sessions.get(f.id)?.title || f.title || 'a task' } : null;
}

// The tasks above `s`, the top one first. Stops at one that isn't here (or a loop).
export function trailOf(s) {
  const out = [];
  const seen = new Set([s?.id]);
  for (let p = parentOf(s); p && !seen.has(p.id) && out.length < 8; p = parentOf(S.sessions.get(p.id))) {
    seen.add(p.id);
    out.unshift({ ...p, here: S.sessions.has(p.id) });
    if (!S.sessions.has(p.id)) break;
  }
  return out;
}

// Back from the open task: to the task it was opened from, or a subagent's lead. Null: no way up.
export function backTarget(id) {
  const s = S.sessions.get(id);
  const to = cameFrom.get(id) || s?.parentId;
  return to && to !== id && S.sessions.has(to) ? to : null;
}

// A row under its lead: what the list shows, built from the lead's copy of the run until the
// server's own summary arrives (onChildSummary).
function summaryOf(child, lead) {
  const last = child.turns?.at(-1);
  const hero = last?.presentation?.blocks?.find((b) => b.type === 'hero');
  const running = last?.status === 'running';
  return {
    id: child.id,
    title: child.title || `@${child.member}`,
    agent: child.agent,
    cwd: child.cwd,
    ...(lead.machine && { machine: lead.machine }),
    project: lead.project,
    projectId: lead.projectId,
    color: lead.color,
    scratch: lead.scratch,
    mode: child.mode,
    model: child.model,
    effort: child.effort || '',
    state: child.state,
    unread: false,
    archived: false,
    createdAt: child.createdAt,
    updatedAt: child.updatedAt,
    turnCount: child.turns?.length || 0,
    queued: 0,
    status: running ? 'running' : hero?.status || (last?.status === 'error' ? 'blocked' : 'info'),
    preview: hero?.summary || '',
    live: running ? last.activity?.findLast((a) => a.kind !== 'text')?.label || 'Starting up' : '',
    branch: '',
    pr: null,
    toShip: null,
    team: [],
    parentId: lead.id,
    member: child.member,
  };
}

// Open a subagent's whole run by itself. child: its full record (the lead's childSessions has it).
export function openSub(leadId, child) {
  const lead = S.sessions.get(leadId);
  if (!lead || !child) return toast('That run isn’t here anymore.', { tone: 'bad' });
  if (!S.sessions.has(child.id)) S.sessions.set(child.id, summaryOf(child, lead));
  if (!S.full.has(child.id)) S.full.set(child.id, child);
  subs.set(child.id, leadId);
  cameFrom.set(child.id, leadId);
  opening = child.id;
  reveal(child.id);
}

// A task opened from another one's card (a crew member's job): Back returns to that card.
export function openFrom(id, from) {
  if (!S.sessions.has(id)) return toast('That task isn’t here anymore.', { tone: 'bad' });
  if (from && from !== id) cameFrom.set(id, from);
  reveal(id);
}

// A link to a task that isn't in the list (#/s/<id>): a subagent's run opens under its lead.
export async function openUnlisted(id) {
  const child = await api(`/sessions/${id}`).catch(() => null);
  if (!child?.parentId) return;
  if (!S.sessions.has(child.parentId)) return toast('Its lead task isn’t here anymore.', { tone: 'bad' });
  openSub(child.parentId, child);
}

// The subagent rows under a task in the list, oldest first.
export const subsUnder = (id) =>
  [...subs]
    .filter(([, l]) => l === id)
    .map(([c]) => S.sessions.get(c))
    .filter(Boolean)
    .sort((a, b) => a.createdAt - b.createdAt);

// Before each render: a subagent's row stays while it or its lead is open; then it goes back to its
// lead's card. A reload of the list (loadSessions) keeps the ones still shown.
export function pruneSubs() {
  if (S.open.has(opening)) opening = null;
  let gone = false;
  for (const [c, l] of subs)
    if (c !== opening && !S.open.has(c) && !S.open.has(l)) {
      subs.delete(c);
      if (S.sessions.get(c)?.parentId) S.sessions.delete(c);
      gone = true;
    }
  for (const [id, from] of cameFrom) if (!S.sessions.has(id) || !S.sessions.has(from)) cameFrom.delete(id);
  return gone;
}
export function keepSubs(prev) {
  for (const [c] of subs) if (prev.has(c) && !S.sessions.has(c)) S.sessions.set(c, prev.get(c));
}

// The server's summary of a subagent the user opened: its row and page follow it.
export function onSubSummary(c) {
  if (!subs.has(c.id)) return false;
  S.sessions.set(c.id, c);
  renderFeed();
  return true;
}
