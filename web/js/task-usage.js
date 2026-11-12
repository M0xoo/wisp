// A task's usage, all of it (TRY-16): the tokens its turns took, its subagents' included, its share
// of the plan's windows, and how full its context is. The details column's line says the share and
// the context in a few words (web/js/features/budget.js planLine); a click opens the whole of it
// (usageMenu there). DOM-free and shared: the server's task view (server/runner.js) reads tokensOf
// and contextOf from here, the page the rest.
//
// Two kinds of subagent count in: the CLI's own, inside a turn (Claude Code's Agent calls: their
// tokens are already in the turn's, stats.subagents says which), and wisp's, which are tasks of their
// own (parentId: the lead): the server sums each on the lead's view (subUsage, server/runner.js).

import { longestFirst, pct, subagentOutput, tokenWords, turnTokens, windowName } from './receipt.js';

const n0 = (x) => (Number.isFinite(x) && x > 0 ? x : 0);

// Every turn's tokens, read (cache reads and writes in) and written: { read, cached, output }.
export function tokensOf(turns = []) {
  const out = { read: 0, cached: 0, output: 0 };
  for (const t of turns) {
    const x = turnTokens(t);
    out.read += x.read;
    out.cached += x.cached;
    out.output += x.output;
  }
  return out;
}

// How full the task's context is now: { tokens, window } from the newest turn that measured it
// (window 0 when the harness doesn't say), or null. A compaction reports 0, which is the size now.
// A later turn that worked without a number (another harness, an old CLI) moved it on: null, never a guess.
export function contextOf(turns = []) {
  for (let i = turns.length - 1; i >= 0; i--) {
    const st = turns[i]?.stats;
    if (!st || turns[i].status === 'running') continue;
    if (Number.isFinite(st.contextTokens)) {
      // The window is the model's: a turn that measured none (a compaction) takes the one before.
      let window = 0;
      for (let j = i; j >= 0 && !window; j--) window = n0(turns[j]?.stats?.contextWindow);
      return { tokens: n0(st.contextTokens), window };
    }
    if (n0(st.outputTokens)) return null;
  }
  return null;
}

// The share of the window, 0–1, or null when the window isn't known.
export const contextShare = (c) => (c?.window ? Math.min(1, c.tokens / c.window) : null);

// "62% context" for the line, or "124k context" when the window isn't known; '' with no reading.
export function contextWords(c) {
  if (!c) return '';
  if (!c.tokens) return 'Compacted'; // a compaction's size isn't known until the next turn measures it
  const share = contextShare(c);
  return share != null ? `${pct(share)} context` : `${tokenWords(c.tokens)} context`;
}
export function contextTip(c) {
  if (!c) return '';
  if (!c.tokens) return 'Compacted: the next turn says how full the context is';
  const of = c.window ? ` of the model’s ${tokenWords(c.window)}` : '';
  return `${c.tokens.toLocaleString('en-US')} tokens in the context${of}, as its last turn left it. Compact shrinks it`;
}

// A plan share map ({ seven_day: 0.04, … }) as [{ window, used }], longest window first.
const planList = (m) =>
  Object.entries(m || {})
    .filter(([, x]) => x > 0)
    .map(([window, used]) => ({ window, used }))
    .sort(longestFirst);

// The task and its wisp subagents' share, summed: { seven_day: 0.06, five_hour: 0.21 }.
// s: a task view (its own plan), subs: its subagents' views.
export function planWithSubs(s, subs = []) {
  const out = {};
  // A subagent on another plan (samePlan false: another harness or account) has its own windows.
  for (const x of [s, ...subs.filter((x) => x?.samePlan !== false)]) for (const [w, used] of Object.entries(x?.plan || {})) if (used > 0) out[w] = (out[w] || 0) + used;
  return out;
}

// The details column's first line: "6% of weekly · 21% of 5-hour", the plan's windows longest first,
// the subagents' share in. With no plan share, the tokens stand in ("1.2M tokens"). [] with neither.
export function planParts(s, subs = []) {
  const plan = planList(planWithSubs(s, subs)).map((p) => `${pct(p.used)} of ${windowName(p.window)}`);
  const tokens = [s, ...subs].reduce((a, x) => a + n0(x?.tokens), 0);
  return plan.length ? plan : tokens ? [`${tokenWords(tokens)} tokens`] : [];
}
// Both lines' words: the plan's, then the context's ("62% context").
export function lineParts(s, subs = []) {
  const ctx = contextWords(s?.context);
  return [...planParts(s, subs), ...(ctx ? [ctx] : [])];
}

// The CLI's own subagents over every turn, by type: [{ type, calls, output, model }] most output first.
function inTurnAgents(turns = []) {
  const by = new Map();
  for (const t of turns) {
    for (const x of t?.stats?.subagents || []) {
      const key = `${x.type || 'general'} ${x.model || ''}`;
      const e = by.get(key) || { type: x.type || 'general', model: x.model || '', calls: 0, output: 0 };
      e.calls += n0(x.calls);
      e.output += subagentOutput(t.stats, x);
      by.set(key, e);
    }
  }
  return [...by.values()].sort((a, b) => b.output - a.output);
}

// The whole of it, for the popover. full: the task with its turns (S.full), s: its view, subs: its
// wisp subagents (s.subUsage: id, name, title, tokens, plan). Numbers only where wisp measured them.
export function taskUsage(full, s, subs = []) {
  const turns = full?.turns || [];
  const own = tokensOf(turns);
  // Not loaded yet (S.full): the view's total stands in, so the popover says what the line said.
  const ownTokens = turns.length ? own.read + own.output : n0(s?.tokens);
  const children = subs.map((x) => ({ id: x.id, name: x.name || x.member || x.title || 'Subagent', title: x.title || '', tokens: n0(x.tokens), plan: planList(x.plan), ...(x.samePlan === false && { apart: true }) }));
  const subTokens = children.reduce((a, x) => a + x.tokens, 0);
  const ownPlan = s?.plan || {};
  const plan = planList(planWithSubs(s, subs)).map((p) => ({ ...p, own: n0(ownPlan[p.window]) }));
  const agents = inTurnAgents(turns);
  return {
    tokens: ownTokens + subTokens,
    own: { ...own, tokens: ownTokens, cache: own.read ? own.cached / own.read : null },
    turns: turns.filter((t) => t.status !== 'running' && t.stats).length,
    plan,
    context: s?.context || contextOf(turns),
    agents,
    agentOutput: agents.reduce((a, x) => a + x.output, 0),
    subs: children,
    subTokens,
  };
}
