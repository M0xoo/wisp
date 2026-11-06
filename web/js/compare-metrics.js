// Compare's numbers (web/js/features/compare.js): what each run of a task took over all its turns,
// its plan share when runs overlap on one account, and a neutral sentence against the first run.
// DOM-free, so the tests read it as is.
//
// A run is compared on its own work: a copied turn (a fork's first turns, a shared task's) ran
// elsewhere, and the stored counters aren't each turn's, the same trap as server/allowance.js
// readingOf: Claude's costUsd before stats.totals and Codex's tokens without stats.totals are the
// conversation's running total, so a turn is the difference with the one before it.

import { countChanges } from './diff.js';
import { longestFirst, pct, tokenWords, turnTokens, windowName } from './receipt.js';

export { pct };

const STEP_KINDS = new Set(['run', 'tool', 'read', 'edit', 'agent', 'web', 'search']);
const NEAR = 0.05; // a difference under this share says nothing about one run each
const NEAR_MS = 5000;
const NOISE = 'One run each: the same setup varies run to run.';
const ESTIMATE = "An estimate. When runs overlap on one account, wisp can only trace what they took together, so this splits the total by each run's cost.";
const NO_COST = "Not every run reported a cost, so wisp can't split the total between them.";
const DASH = '—';

const copied = (t) => !!(t.forked || t.shared);
const own = (s) => (s?.turns || []).filter((t) => !copied(t));
const tidy = (x) => Math.round(x * 1e7) / 1e7; // differences of totals leave float dust
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const byAge = (list) => [...list].sort((a, b) => a.createdAt - b.createdAt);
const isLive = (s) => s?.state === 'running' || s?.state === 'waiting';
const letter = (i) => String.fromCharCode(65 + i);
const listed = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0] || '');

// Try it two ways: a run's variant in words, for the pill, tooltips and Compare's columns. Its
// subagents on the task's model only say so when the setting would have them on another (setting:
// defaults.subagentModel).
const SUBAGENT_NAME = { haiku: 'Haiku', sonnet: 'Sonnet' };
export function variantWords(v, setting = '') {
  const out = [];
  if (v?.subagentModel) out.push(`Subagents on ${SUBAGENT_NAME[v.subagentModel] || v.subagentModel}`);
  else if (v?.subagentModel === '' && setting) out.push('Subagents on task’s model');
  if (v?.skills === 'off') out.push('Skills off');
  return out;
}

const level = (e) => (!e ? 'Default' : e === 'xhigh' ? 'X-High' : e.charAt(0).toUpperCase() + e.slice(1));

// session.trial.differs in words: "Subagents: Opus → Haiku · Skills: on → off". names: the page's
// agent(id), model(id) and account(id), and taskModel: what '' subagents run on (run A's model).
export function differsWords(differs, { agent = (x) => x, model = (x) => x, account = (x) => x || 'Default', taskModel = 'Task’s model' } = {}) {
  if (!differs?.length) return 'Same setup on both runs';
  const rows = {
    agent: ['Harness', agent],
    model: ['Model', (x) => (x ? model(x) : 'Default')],
    effort: ['Thinking', level],
    account: ['Account', account],
    subagentModel: ['Subagents', (x) => SUBAGENT_NAME[x] || x || taskModel],
    skills: ['Skills', (x) => x],
  };
  return differs.map(({ key, values }) => `${rows[key]?.[0] || key}: ${values.map(rows[key]?.[1] || String).join(' → ')}`).join(' · ');
}

// What the page's fmtDuration writes (blocks.js touches the DOM on import).
function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 1) return `${ms}ms`;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// The same in a sentence: "40s", "3 min", "1h 5m".
function spanWords(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// A Claude turn's own cost, or null. counter: what it stood at after the turn before.
function ownCost(agent, st, counter) {
  if (agent !== 'claude') return num(st.costUsd);
  if (st.totals) {
    if (Number.isFinite(st.totals.costUsd)) counter.set(agent, st.totals.costUsd);
    return num(st.costUsd);
  }
  const now = num(st.costUsd);
  if (now === null) return null;
  const was = counter.get(agent) || 0;
  counter.set(agent, now);
  return tidy(now >= was ? now - was : now); // less than before: the counters started over
}

function ownTokens(agent, t, counter) {
  const tokens = turnTokens(t);
  if (agent !== 'codex') return tokens;
  if (t.stats?.totals) {
    counter.set(agent, turnTokens({ stats: t.stats.totals }));
    return tokens;
  }
  if (!tokens.read && !tokens.output) return tokens; // never got to report: the counter stands
  const was = counter.get(agent) || { read: 0, cached: 0, output: 0 };
  counter.set(agent, tokens);
  if (tokens.read < was.read || tokens.output < was.output) return tokens;
  return { read: tokens.read - was.read, cached: Math.max(0, tokens.cached - was.cached), output: tokens.output - was.output };
}

// Each turn's own work: Map(turn → { cost, tokens }). A copy or a baseline moves the counters, so
// the turn after differences correctly, but isn't in it.
function workOf(session) {
  const out = new Map();
  const costs = new Map(); // agent → its counter
  const tokens = new Map();
  for (const t of session?.turns || []) {
    const agent = t.agent || session.agent;
    const st = t.stats || {};
    const work = { cost: ownCost(agent, st, costs), tokens: ownTokens(agent, t, tokens) };
    if (!copied(t) && !st.baseline) out.set(t, work);
  }
  return out;
}

function testsOf(t) {
  const tests = (t?.presentation?.blocks || []).filter((b) => b?.type === 'tests');
  if (!tests.length) return null;
  return { passed: tests.reduce((a, b) => a + (Number(b.passed) || 0), 0), failed: tests.reduce((a, b) => a + (Number(b.failed) || 0), 0) };
}

function timeOf(t) {
  if (t.status === 'running') return null;
  if (t.stats?.durationMs > 0) return t.stats.durationMs;
  return t.endedAt ? t.endedAt - t.startedAt : null;
}

// One run's numbers. time, cost, tokens and steps are totals over its turns; files, add, del, tests
// and asks are what its last turn left, as the turn itself shows them.
export function runMetrics(session) {
  const turns = own(session);
  const work = workOf(session);
  let [time, cost, read, cached, output, steps, missing] = [null, null, 0, 0, 0, null, false];
  const plan = {};
  for (const t of turns) {
    const ms = timeOf(t);
    if (ms !== null) time = (time || 0) + ms;
    const w = work.get(t);
    if (w?.cost != null) cost = tidy((cost || 0) + w.cost);
    else if (w && t.status !== 'running' && t.endedAt) missing = true;
    read += w?.tokens.read || 0;
    cached += w?.tokens.cached || 0;
    output += w?.tokens.output || 0;
    steps = (steps || 0) + (t.activity || []).filter((a) => STEP_KINDS.has(a.kind)).length + (t.trimmed || 0);
    for (const p of t.plan || []) if (p?.window && p.used > 0) plan[p.window] = (plan[p.window] || 0) + p.used;
  }
  const last = turns.at(-1);
  const lines = (last?.changes || []).reduce((acc, c) => {
    const n = countChanges(c.edits);
    return { add: acc.add + n.add, del: acc.del + n.del };
  }, { add: 0, del: 0 });
  const live = isLive(session);
  return {
    id: session?.id,
    agent: session?.agent,
    createdAt: session?.createdAt,
    live,
    time,
    cost,
    costPartial: cost !== null && missing,
    tokens: read + output || null,
    // As on the receipt: a harness that doesn't report cached tokens has no cache number, not 0%.
    cache: read && cached ? cached / read : null,
    steps,
    plan: Object.entries(plan).map(([window, used]) => ({ window, used })).sort(longestFirst),
    files: last?.changes?.length || 0,
    ...lines,
    tests: testsOf(last),
    asks: (last?.activity || []).filter((a) => a.kind === 'ask').length,
    followUps: turns.slice(1).filter((t) => t.by !== 'wisp' && t.by !== 'compact').length, // yours, as in the task's summary (server/runner.js)
    unfinished: !live && (last?.status === 'error' || last?.status === 'stopped'),
  };
}

// Plan cells, in createdAt order, and the line with what overlapping runs took together. wisp splits
// a window's move among the turns running on the account by time (server/budget.js #sharers), so
// runs that overlap on one account can't each show a true share: only their total is known.
// Pooled is read from the turns, not from t.plan: a share lands late, and a turn that has none yet
// was still running beside the others.
export function planShares(sessions, now = Date.now()) {
  const runs = byAge(sessions).map((s, i) => {
    const work = workOf(s);
    const turns = own(s).filter((t) => Number.isFinite(t.startedAt)).map((t) => ({
      t,
      key: `${t.agent || s.agent}@${t.account || s.account || 'default'}`,
      from: t.startedAt,
      to: t.endedAt ?? now,
      cost: work.get(t)?.cost ?? null,
    }));
    return { i, turns, solo: {} };
  });
  const overlap = (a, b) => a.key === b.key && a.from < b.to && b.from < a.to;
  for (const r of runs) for (const x of r.turns) x.pooled = runs.some((o) => o !== r && o.turns.some((y) => overlap(x, y)));

  const pools = new Map(); // "agent@account window" → { key, window, used, members: Map(run → its pooled turns) }
  for (const r of runs) {
    for (const x of r.turns) {
      for (const p of x.t.plan || []) {
        if (!p?.window || !(p.used > 0)) continue;
        if (!x.pooled) {
          r.solo[p.window] = (r.solo[p.window] || 0) + p.used;
          continue;
        }
        const key = `${p.agent}@${p.account || 'default'}`;
        const id = `${key} ${p.window}`;
        if (!pools.has(id)) pools.set(id, { key, window: p.window, used: 0, members: new Map() });
        pools.get(id).used += p.used;
      }
    }
  }
  const shared = [];
  for (const pool of pools.values()) {
    for (const r of runs) {
      const mine = r.turns.filter((x) => x.pooled && (x.key === pool.key || x.t.plan?.some((p) => p.window === pool.window && `${p.agent}@${p.account || 'default'}` === pool.key)));
      if (mine.length) pool.members.set(r, mine);
    }
    // One turn's entry on an account the others never touched: nothing to split.
    if (pool.members.size < 2) {
      for (const r of pool.members.keys()) r.solo[pool.window] = (r.solo[pool.window] || 0) + pool.used;
      continue;
    }
    const turns = [...pool.members.values()].flat();
    const costs = turns.reduce((a, x) => a + (x.cost || 0), 0);
    pool.split = costs > 0 && turns.every((x) => x.cost !== null);
    pool.costs = costs;
    pool.waiting = turns.some((x) => x.cost === null && x.t.status === 'running'); // its cost is on the way
    shared.push(pool);
  }

  const cells = runs.map((r) => {
    const mine = shared.filter((p) => p.members.has(r));
    const window = [...new Set([...Object.keys(r.solo), ...mine.map((p) => p.window)])].map((w) => ({ window: w })).sort(longestFirst)[0]?.window;
    if (!window) return { text: DASH, tip: '' };
    const name = windowName(window);
    const here = mine.filter((p) => p.window === window);
    const solo = r.solo[window] || 0;
    if (!here.length) return { text: `${pct(solo)} of ${name}`, tip: '' };
    const stuck = here.find((p) => !p.split);
    if (stuck) return { text: DASH, tip: stuck.waiting ? '' : NO_COST };
    const part = here.reduce((a, p) => a + (p.used * p.members.get(r).reduce((c, x) => c + x.cost, 0)) / p.costs, 0);
    return { text: `≈${pct(solo + part)} of ${name}`, tip: ESTIMATE };
  });

  // One line per account, on its longest window, as on a cell.
  const longest = new Map();
  for (const p of [...shared].sort(longestFirst)) if (!longest.has(p.key)) longest.set(p.key, p);
  const who = (p) => {
    const n = p.members.size;
    if (n < runs.length) return listed([...p.members.keys()].map((r) => letter(r.i)).sort());
    return n === 2 ? 'Both runs' : `All ${n} runs`;
  };
  return { cells, total: [...longest.values()].map((p) => `${who(p)} took ${pct(p.used)} of ${windowName(p.window)}.`).join(' ') };
}

// "62% fewer tokens": a percent, never the 100% of a number that isn't gone.
function change(a, b) {
  const by = Math.round((Math.abs(b - a) / a) * 100);
  return b < a ? Math.min(by, 99) : by;
}

function deltas(a, b, name) {
  const parts = [];
  const tokens = a.tokens > 0 && b.tokens > 0;
  const time = a.time !== null && b.time !== null;
  if (tokens && Math.abs(b.tokens - a.tokens) / a.tokens >= NEAR) parts.push(`used ${change(a.tokens, b.tokens)}% ${b.tokens < a.tokens ? 'fewer' : 'more'} tokens`);
  if (a.cost > 0 && b.cost !== null && Math.abs(b.cost - a.cost) / a.cost >= NEAR) parts.push(`cost ${change(a.cost, b.cost)}% ${b.cost < a.cost ? 'less' : 'more'}`);
  if (time && Math.abs(b.time - a.time) >= NEAR_MS) parts.push(`took ${spanWords(Math.abs(b.time - a.time))} ${b.time < a.time ? 'less' : 'longer'}`);
  if (parts.length) return `${name} ${listed(parts)} than A.`;
  return tokens && time ? `${name} used about the same tokens and time as A.` : '';
}

// What can honestly be said against run A, in numbers only: it never says which run is better, and
// it never takes one run each for more than that. Takes sessions or runMetrics of them.
export function compareSentence(list) {
  const runs = byAge(list).map((x) => (x?.turns ? runMetrics(x) : x));
  const [a, ...rest] = runs;
  if (!a) return '';
  const said = new Set(); // a clause several runs share is said once
  rest.forEach((b, i) => {
    const name = letter(i + 1);
    if (a.live || b.live) return;
    if (a.unfinished || b.unfinished) said.add(`${listed([...(a.unfinished ? ['A'] : []), ...(b.unfinished ? [name] : [])])} didn't finish, so there's no comparison.`);
    else if (a.followUps !== b.followUps) said.add(`${name} had a different number of follow-ups, so it isn't the same work.`);
    else if (a.agent !== b.agent) said.add("Different harnesses count differently, so there's no ratio.");
    else said.add(deltas(a, b, name));
  });
  const done = runs.filter((r) => !r.live && !r.unfinished);
  const passed = done[0]?.tests?.passed;
  if (!runs.some((r) => r.live) && done.length > 1 && passed > 0 && done.every((r) => r.tests && !r.tests.failed && r.tests.passed === passed)) {
    said.add(`${done.length === 2 ? 'Both' : `All ${done.length}`} passed ${passed} test${passed === 1 ? '' : 's'}.`);
  }
  said.delete('');
  return said.size ? [...said, NOISE].join(' ') : '';
}

const filesHtml = (m) => `${m.files} <span class="plus">+${m.add}</span> <span class="minus">−${m.del}</span>`;
const testsHtml = (t) => `<span class="${t.failed ? 'minus' : 'plus'}">${t.passed} ✓${t.failed ? ` ${t.failed} ✗` : ''}</span>`;

// The table: the same rows in the same order whatever the runs hold, so nothing jumps while they
// work. { key, label, tip?, cells: [{ html, tip? }] }, a cell per run in createdAt order.
export function compareRows(sessions, now = Date.now()) {
  const metrics = byAge(sessions).map(runMetrics);
  const { cells: plan } = planShares(sessions, now);
  const row = (key, label, html, tip) => ({ key, label, ...(tip && { tip }), cells: metrics.map((m, i) => ({ html: html(m, i) ?? DASH })) });
  const rows = [
    row('time', 'Time', (m) => (m.time !== null ? duration(m.time) : null)),
    row('cost', 'Cost', (m) => (m.cost !== null ? `$${m.cost.toFixed(2)}` : null)),
    row('tokens', 'Tokens', (m) => (m.tokens ? tokenWords(m.tokens) : null)),
    row('cache', 'Cache', (m) => (m.cache !== null ? pct(m.cache) : null)),
    row('steps', 'Agent steps', (m) => (m.steps !== null ? String(m.steps) : null), 'Tools the agent used: commands, reads, edits, searches'),
    row('plan', 'Plan', (m, i) => plan[i].text),
    row('files', 'Files', filesHtml),
    row('tests', 'Tests', (m) => (m.tests ? testsHtml(m.tests) : null)),
    row('asks', 'Asked', (m) => String(m.asks)),
  ];
  const tip = (key, fn) => rows.find((r) => r.key === key).cells.forEach((c, i) => {
    if (fn(i)) c.tip = fn(i);
  });
  tip('cost', (i) => (metrics[i].costPartial ? 'Some turns reported no cost' : ''));
  tip('plan', (i) => plan[i].tip);
  return rows;
}
