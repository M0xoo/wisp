// Spend and outcomes across sessions: what each turn cost, whether it worked, how often the
// agent had to ask. Built from the session records, nothing extra is stored.

const DAY = 864e5;
const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// A turn "worked" when it finished and its hero didn't say partial or blocked.
const outcome = (t) => {
  if (t.status === 'error') return 'failed';
  if (t.status === 'stopped') return 'stopped';
  const hero = t.presentation?.blocks?.find((b) => b?.type === 'hero');
  return hero?.status === 'blocked' || hero?.status === 'partial' ? hero.status : 'done';
};

function bucket() {
  return { turns: 0, cost: 0, priced: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, done: 0, questions: 0 };
}
function add(b, t) {
  const st = t.stats || {};
  b.turns++;
  if (typeof st.costUsd === 'number') (b.cost += st.costUsd), b.priced++;
  b.inputTokens += st.inputTokens || 0;
  b.outputTokens += st.outputTokens || 0;
  b.durationMs += t.endedAt && t.startedAt ? t.endedAt - t.startedAt : 0;
  if (outcome(t) === 'done') b.done++;
  b.questions += (t.activity || []).filter((a) => a.kind === 'ask').length + ((t.presentation?.blocks || []).some((x) => x?.type === 'question') ? 1 : 0);
}
const finish = (b) => ({ ...b, cost: Math.round(b.cost * 10000) / 10000, successRate: b.turns ? b.done / b.turns : null, avgMs: b.turns ? Math.round(b.durationMs / b.turns) : 0 });

// sessions: full records. project(s) → { id, name, color } or null.
export function usage(sessions, { days = 30, now = Date.now(), project = () => null } = {}) {
  days = Math.min(Math.max(Math.round(days) || 30, 1), 365);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const since = start.getTime() - (days - 1) * DAY;

  const total = bucket();
  const byDay = new Map();
  for (let i = 0; i < days; i++) {
    const t = new Date(since);
    t.setDate(t.getDate() + i);
    byDay.set(dayKey(t), { date: dayKey(t), ...bucket() });
  }
  const byProject = new Map();
  const byRunner = new Map();
  const sessionIds = new Set();

  for (const s of sessions) {
    if (s.agent === 'wisp') continue; // the tour
    const p = project(s);
    for (const t of s.turns || []) {
      if (!t.startedAt || t.startedAt < since || t.status === 'running') continue;
      sessionIds.add(s.id);
      add(total, t);
      const d = byDay.get(dayKey(t.startedAt));
      if (d) add(d, t);
      const pk = p?.id || s.cwd;
      if (!byProject.has(pk)) byProject.set(pk, { id: p?.id || null, name: p?.name || String(s.cwd || '').split(/[\\/]/).pop(), color: p?.color || 'slate', ...bucket() });
      add(byProject.get(pk), t);
      const agent = t.agent || s.agent;
      const model = t.model ?? s.model ?? '';
      const rk = `${agent}\u0000${model}`;
      if (!byRunner.has(rk)) byRunner.set(rk, { agent, model, ...bucket() });
      add(byRunner.get(rk), t);
    }
  }
  const sorted = (m) => [...m.values()].map(finish).sort((a, b) => b.cost - a.cost || b.turns - a.turns);
  return {
    days,
    since,
    total: { ...finish(total), sessions: sessionIds.size },
    daily: [...byDay.values()].map(finish),
    projects: sorted(byProject),
    runners: sorted(byRunner),
  };
}

// Tool calls across sessions, for the agent-facing `wisp_stats` tool: how often each kind of
// action ran (run, read, edit, search, web, …), per harness, project and day. Kinds are wisp's
// normalized activity kinds, not the harness's own tool names. Spend and success come from usage().
const NOT_TOOLS = new Set(['text', 'error', 'answer']);
const tally = () => ({ calls: 0, kinds: {} });
const count = (b, kind) => {
  b.calls++;
  b.kinds[kind] = (b.kinds[kind] || 0) + 1;
};
const ranked = (m) => [...m.values()].sort((a, b) => b.calls - a.calls);

// filter: { agent, project } — agent is a harness id, project a project id or folder name.
export function toolStats(sessions, { days = 30, now = Date.now(), project = () => null, filter = {} } = {}) {
  const keep = sessions
    .filter((s) => {
      if (!filter.project) return true;
      const p = project(s);
      return p?.id === filter.project || (p?.name || String(s.cwd || '').split(/[\\/]/).pop()) === filter.project;
    })
    .map((s) => (filter.agent ? { ...s, turns: (s.turns || []).filter((t) => (t.agent || s.agent) === filter.agent) } : s));
  const u = usage(keep, { days, now, project });
  const since = u.since;

  const total = tally();
  const byAgent = new Map();
  const byProject = new Map();
  const byDay = new Map(u.daily.map((d) => [d.date, { date: d.date, ...tally() }]));
  for (const s of keep) {
    if (s.agent === 'wisp') continue;
    const p = project(s);
    for (const t of s.turns || []) {
      if (!t.startedAt || t.startedAt < since || t.status === 'running') continue;
      const agent = t.agent || s.agent;
      const pk = p?.id || s.cwd;
      if (!byAgent.has(agent)) byAgent.set(agent, { agent, ...tally() });
      if (!byProject.has(pk)) byProject.set(pk, { id: p?.id || null, name: p?.name || String(s.cwd || '').split(/[\\/]/).pop(), ...tally() });
      for (const a of t.activity || []) {
        if (!a?.kind || NOT_TOOLS.has(a.kind)) continue;
        count(total, a.kind);
        count(byAgent.get(agent), a.kind);
        count(byProject.get(pk), a.kind);
        const d = byDay.get(dayKey(a.t || t.startedAt));
        if (d) count(d, a.kind);
      }
    }
  }
  const outcome = (b) => ({ turns: b.turns, cost: b.cost, priced: b.priced, successRate: b.successRate });
  const runs = new Map();
  for (const r of u.runners) {
    const b = runs.get(r.agent) || { turns: 0, done: 0, cost: 0, priced: 0 };
    runs.set(r.agent, { turns: b.turns + r.turns, done: b.done + r.done, cost: b.cost + r.cost, priced: b.priced + r.priced });
  }
  const withRuns = (a) => {
    const r = runs.get(a.agent) || { turns: 0, done: 0, cost: 0, priced: 0 };
    return { ...a, turns: r.turns, cost: Math.round(r.cost * 10000) / 10000, priced: r.priced, successRate: r.turns ? r.done / r.turns : null };
  };
  const projectRuns = new Map(u.projects.map((p) => [p.id || p.name, p]));
  return {
    days: u.days,
    since,
    filter: { agent: filter.agent || null, project: filter.project || null },
    total: { ...total, sessions: u.total.sessions, ...outcome(u.total), inputTokens: u.total.inputTokens, outputTokens: u.total.outputTokens, questions: u.total.questions },
    kinds: Object.entries(total.kinds).map(([kind, calls]) => ({ kind, calls })).sort((a, b) => b.calls - a.calls),
    agents: ranked(byAgent).map(withRuns),
    projects: ranked(byProject).map((p) => ({ ...p, ...outcome(projectRuns.get(p.id || p.name) || { turns: 0, cost: 0, priced: 0, successRate: null }) })),
    daily: [...byDay.values()],
  };
}

// toolStats() as markdown for an agent to read.
export function toolStatsText(st) {
  const pct = (r) => (r === null || r === undefined ? '—' : `${Math.round(r * 100)}%`);
  const usd = (b) => (b.priced ? `$${b.cost.toFixed(2)}${b.priced < b.turns ? ` (${b.priced}/${b.turns} turns priced)` : ''}` : '—');
  const kinds = (k) => Object.entries(k).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join(', ') || '—';
  const scope = [st.filter.agent && `harness ${st.filter.agent}`, st.filter.project && `project ${st.filter.project}`].filter(Boolean).join(', ');
  const t = st.total;
  const out = [
    `## wisp tool stats — last ${st.days} day${st.days === 1 ? '' : 's'}${scope ? ` (${scope})` : ''}`,
    `${t.calls} tool calls in ${t.turns} turns across ${t.sessions} sessions. Success rate ${pct(t.successRate)}, cost ${usd(t)}, ${t.questions} questions to the user, ${t.inputTokens} input / ${t.outputTokens} output tokens.`,
    '',
    'Kinds are wisp’s categories, not harness tool names: run = shell commands, read / edit / search = files, web = fetch and search, agent = subagents, tool = other (MCP) tools, ask = questions to the user, wait = waiting on the user or a background task.',
  ];
  if (!t.turns) return [...out, '', 'No finished turns in this range.'].join('\n');
  out.push('', '### By kind', '| kind | calls | share |', '|---|---:|---:|');
  for (const k of st.kinds) out.push(`| ${k.kind} | ${k.calls} | ${t.calls ? Math.round((k.calls / t.calls) * 100) : 0}% |`);
  out.push('', '### By harness', '| harness | calls | turns | success | cost | top kinds |', '|---|---:|---:|---:|---:|---|');
  for (const a of st.agents) out.push(`| ${a.agent} | ${a.calls} | ${a.turns} | ${pct(a.successRate)} | ${usd(a)} | ${kinds(a.kinds)} |`);
  out.push('', '### By project', '| project | calls | turns | success | cost | top kinds |', '|---|---:|---:|---:|---:|---|');
  for (const p of st.projects) out.push(`| ${p.name} | ${p.calls} | ${p.turns} | ${pct(p.successRate)} | ${usd(p)} | ${kinds(p.kinds)} |`);
  out.push('', '### By day (days with activity)', '| day | calls | kinds |', '|---|---:|---|');
  for (const d of st.daily.filter((d) => d.calls)) out.push(`| ${d.date} | ${d.calls} | ${kinds(d.kinds)} |`);
  return out.join('\n');
}

// How each crew member did, and where its usage went (design/crew.md → Track record): its jobs
// in the range, built from its job sessions like usage(). A job is one session; its outcome is its
// last finished turn's. Quiet check-ins (nothing to report) count as check-ins but not in Finished,
// nor do jobs you stopped. Usage: tokens and cost per day, per kind of job (its schedule and its
// triggers are the repeating work), its heaviest jobs, its share of everything wisp ran, and of
// each plan window (Claude's 5-hour and weekly, Codex's) since that window started. A member on
// another machine only has summaries there: outcomes and counts, no usage (remote: true).
const KIND = { checkin: 'checkin', task: 'task', mention: 'mention', delegated: 'delegated', trigger: 'trigger', event: 'trigger' };
const KINDS = ['checkin', 'trigger', 'task', 'mention', 'delegated'];
const quietJob = (s) => !!s.turns?.[0]?.quiet || ((s.crew?.job === 'checkin' || s.crew?.job === 'event') && !!s.archived && s.state === 'done' && !s.forLater);
const asked = (t) => !!t?.presentation?.blocks?.some((b) => b?.type === 'question');
const tokensOf = (t) => (t.stats?.inputTokens || 0) + (t.stats?.outputTokens || 0);
function jobOf(s) {
  const turns = s.turns || [];
  const ended = turns.filter((t) => t.status !== 'running');
  const last = ended.at(-1);
  let result;
  if (s.turns) result = turns.at(-1)?.status === 'running' || !last ? 'running' : outcome(last);
  else result = s.state === 'running' || s.status === 'running' ? 'running' : s.status === 'partial' || s.status === 'blocked' ? s.status : 'done';
  const acts = turns.flatMap((t) => t.activity || []).filter((a) => a?.kind === 'ask');
  const approvals = acts.filter((a) => /^Needs your OK/.test(a.label || '')).length;
  const j = {
    id: s.id,
    title: s.title || '',
    at: s.createdAt || turns[0]?.startedAt || 0,
    kind: KIND[s.crew?.job] || 'task',
    result,
    quiet: s.turns ? quietJob(s) : false,
    later: s.forLater?.by === 'crew',
    approvals,
    questions: acts.length - approvals + ended.filter(asked).length,
    // Yours, on its job: not wisp's own rounds, and not an answer to a question it asked.
    followups: s.turns ? turns.slice(1).filter((t, i) => t.by !== 'wisp' && t.by !== 'later' && !asked(turns[i])).length : s.followups || 0,
    pr: s.pr?.state === 'merged' ? 'merged' : s.pr?.state === 'open' ? 'open' : '',
    cost: 0,
    priced: false,
    tokens: 0,
    agent: s.agent || '',
  };
  for (const t of turns) {
    if (typeof t.stats?.costUsd === 'number') (j.cost += t.stats.costUsd), (j.priced = true);
    j.tokens += tokensOf(t);
  }
  return j;
}
const use = () => ({ runs: 0, tokens: 0, cost: 0, quiet: 0 });
const tallyJobs = () => ({ jobs: 0, counted: 0, done: 0, partial: 0, blocked: 0, failed: 0, stopped: 0, running: 0, kinds: { checkin: 0, task: 0, mention: 0, delegated: 0, trigger: 0 }, checkins: 0, quiet: 0, later: 0, questions: 0, approvals: 0, followups: 0, followedUp: 0, prs: { merged: 0, open: 0 }, cost: 0, priced: 0, unpriced: 0, tokens: 0, unpricedAgents: [], byKind: Object.fromEntries(KINDS.map((k) => [k, use()])) });
function addJob(b, j) {
  b.jobs++;
  b.kinds[j.kind]++;
  if (j.kind === 'checkin') {
    b.checkins++;
    if (j.quiet) b.quiet++;
    if (j.later) b.later++;
  }
  if (j.result === 'running') b.running++;
  else if (!j.quiet && j.result !== 'stopped') {
    b.counted++;
    b[j.result]++;
  } else if (j.result === 'stopped') b.stopped++;
  b.questions += j.questions;
  b.approvals += j.approvals;
  b.followups += j.followups;
  if (j.followups) b.followedUp++;
  if (j.pr) b.prs[j.pr]++;
  b.tokens += j.tokens;
  if (j.priced) (b.cost += j.cost), b.priced++;
  else if (j.result !== 'running') {
    b.unpriced++;
    if (j.agent && !b.unpricedAgents.includes(j.agent)) b.unpricedAgents.push(j.agent);
  }
  const k = b.byKind[j.kind];
  k.runs++;
  k.tokens += j.tokens;
  k.cost += j.cost;
  if (j.quiet) k.quiet++;
}
const cents = (v) => Math.round(v * 10000) / 10000;
const TOP = 8;

// members: [{ id, name, machine, createdAt }]; jobsOf(m) → its sessions (full records) or summaries.
// sessions: every session (for the crew's share of all usage and of the plan windows). budget: the
// Budget (server/budget.js), or null.
export function crewStats(members, jobsOf, { days = 30, now = Date.now(), sessions = [], budget = null } = {}) {
  days = Math.min(Math.max(Math.round(days) || 30, 1), 365);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const since = start.getTime() - (days - 1) * DAY;
  const out = members.map((m) => {
    const b = tallyJobs();
    const byDay = new Map();
    for (let i = 0; i < days; i++) {
      const t = new Date(since);
      t.setDate(t.getDate() + i);
      byDay.set(dayKey(t), { date: dayKey(t), done: 0, partial: 0, missed: 0, stopped: 0, quiet: 0, tokens: 0, cost: 0, kinds: {} }); // missed: blocked or failed
    }
    const list = [];
    let first = 0;
    for (const s of jobsOf(m) || []) {
      if (s.pending) continue;
      const j = jobOf(s);
      if (j.at < since) continue;
      first = first ? Math.min(first, j.at) : j.at;
      addJob(b, j);
      list.push(j);
      const d = byDay.get(dayKey(j.at));
      if (!d) continue;
      if (j.result !== 'running') d[j.quiet ? 'quiet' : ['done', 'partial', 'stopped'].includes(j.result) ? j.result : 'missed']++;
      d.tokens += j.tokens;
      d.cost += j.cost;
      d.kinds[j.kind] = (d.kinds[j.kind] || 0) + j.tokens;
    }
    for (const k of Object.values(b.byKind)) k.cost = cents(k.cost);
    // Its heaviest jobs, to open the one that cost the most.
    const top = list
      .filter((j) => j.tokens || j.cost)
      .sort((x, y) => y.tokens - x.tokens || y.cost - x.cost)
      .slice(0, TOP)
      .map(({ id, title, at, kind, tokens, cost, priced, result, quiet }) => ({ id, title, at, kind, tokens, cost: cents(cost), priced, result, quiet }));
    // Days it was around in the range: for "a day" figures, a member that joined last week isn't
    // averaged over a month.
    const from = Math.max(since, Math.min(m.createdAt || since, first || now));
    const span = Math.max(1, Math.ceil((now - from) / DAY));
    return { id: m.id, name: m.name, remote: !!m.machine, joined: m.createdAt || 0, span, ...b, cost: cents(b.cost), top, daily: [...byDay.values()].map((d) => ({ ...d, cost: cents(d.cost) })) };
  });

  // Everything wisp ran in the range, for the crew's share; and each plan window since it started.
  const crewOf = new Map();
  for (const m of members) for (const s of jobsOf(m) || []) if (s.turns) crewOf.set(s.id, m.id);
  const all = { tokens: 0, cost: 0 };
  for (const s of sessions) {
    if (s.agent === 'wisp') continue;
    for (const t of s.turns || []) {
      if (!t.startedAt || t.startedAt < since) continue;
      all.tokens += tokensOf(t);
      all.cost += t.stats?.costUsd || 0;
    }
  }
  all.cost = cents(all.cost);
  const windows = [];
  for (const agent of Object.keys(budget?.state || {})) {
    for (const acc of budget.view(agent)) {
      for (const w of acc.windows) {
        const ms = budget.state[agent]?.[acc.account]?.windows?.[w.id]?.ms;
        if (!w.resetsAt || !ms) continue;
        const from = w.resetsAt - ms;
        let total = 0;
        const by = {};
        for (const s of sessions) {
          for (const t of s.turns || []) {
            if (!t.startedAt || t.startedAt < from || (t.agent || s.agent) !== agent || ((t.account ?? s.account) || 'default') !== acc.account) continue;
            const n = tokensOf(t);
            total += n;
            const mid = crewOf.get(s.id);
            if (mid) by[mid] = (by[mid] || 0) + n;
          }
        }
        if (Object.keys(by).length) windows.push({ agent, account: acc.account, id: w.id, label: w.label, used: w.used, resetsAt: w.resetsAt, since: from, hitAt: w.hitAt, tokens: total, members: by });
      }
    }
  }
  return { days, since, all, windows, members: out };
}
