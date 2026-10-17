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
