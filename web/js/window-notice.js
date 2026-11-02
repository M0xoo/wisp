// Window changes (design/budget.md): a plan's usage window that appeared, went, changed its length or
// moved its reset off its schedule, as server/budget.js saw it (on GET /agents, budget[].notices).
// One line each in Settings → Usage and under Needs you on split home, with × (POST
// /agents/:id/windows/dismiss) until that window changes again. Advice only: wisp never switches
// accounts. DOM-free, so the tests read it.

import { spareWhose } from './spare.js';

// agents: GET /agents. → [{ agent, name, account, accountLabel, window, kind, label, wasLabel, ms,
// wasMs, resetsAt, wasResetsAt, at }], newest first. Only installed harnesses and accounts still here.
export function noticesOf(agents = []) {
  const out = [];
  for (const a of agents) {
    if (!a?.available || !Array.isArray(a.budget)) continue;
    const many = (a.accounts?.length || 0) > 1;
    for (const b of a.budget) {
      const acc = many ? a.accounts.find((x) => x.id === b.account) : null;
      if (many ? !acc : b.account !== 'default') continue; // an account since removed
      for (const n of b.notices || []) {
        if (!n?.window || !n.kind) continue;
        out.push({ ...n, agent: a.id, name: a.name || a.id, account: b.account, accountLabel: acc?.label || '', label: n.label || 'Usage' });
      }
    }
  }
  return out.sort((p, q) => (q.at || 0) - (p.at || 0));
}

const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

// The line, with `when(t)` formatting a reset ("Sun 09:00"):
//   reset  "Codex’s weekly window now resets Sun 09:00 (was Thu 21:00)"
//   length "Codex’s weekly window is now 30-day, resets Sun 09:00"
//   new    "Codex has a new 30-day window, resets Sun 09:00"
//   gone   "Codex’s weekly window is gone: it no longer reports one"
export function noticeWords(n, when) {
  const at = (t) => (t ? `, resets ${when(t)}` : '');
  const who = `${n.name}${n.accountLabel ? ` (${n.accountLabel})` : ''}`;
  if (n.kind === 'reset') return `${spareWhose(n)} now resets ${when(n.resetsAt)}${n.wasResetsAt ? ` (was ${when(n.wasResetsAt)})` : ''}`;
  if (n.kind === 'length') return n.wasLabel ? `${who}’s ${lower(n.wasLabel)} window is now ${lower(n.label)}${at(n.resetsAt)}` : `${spareWhose(n)} changed its length${at(n.resetsAt)}`;
  if (n.kind === 'new') return `${who} has a new ${lower(n.label)} window${at(n.resetsAt)}`;
  if (n.kind === 'gone') return `${spareWhose(n)} is gone: it no longer reports one`;
  return `${spareWhose(n)} changed`;
}

// The key of one notice for the page: what × sends, and what tells two apart.
export const noticeKey = (n) => `${n.agent}:${n.account}:${n.window}`;
