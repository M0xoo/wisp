// What GET /sessions/:id?lean=1 sends: a task as the page needs it.
//
// A lead comes with its subagents' sessions, so its cards can show their reports and diffs.
// ?lean=1 (the page): without each edit's whole file from before it, which only rollback reads
// (on the server). A tenth or more of a big task, and the phone fetches it through a tunnel.
// &turns=N (the phone): the latest N turns whole, older ones as stubs with what their folded row
// shows (prompt, time, result title, mode and account); unfolding one fetches the task whole.

const leanTurns = (turns) => turns?.map((t) => (t.changes?.some((x) => 'beforeFile' in x) ? { ...t, changes: t.changes.map(({ beforeFile, ...x }) => x) } : t));
const STUB = ['id', 'prompt', 'by', 'goal', 'status', 'startedAt', 'endedAt', 'rolledBackAt', 'moved', 'mode', 'account', 'agent', 'model', 'effort', 'forked', 'shared', 'btw', 'checkpoint', 'held', 'attachments'];
const stub = (t) => {
  const out = { stub: true };
  for (const k of STUB) if (t[k] !== undefined) out[k] = t[k];
  const hero = t.presentation?.blocks?.find((b) => b.type === 'hero');
  if (hero) out.presentation = { blocks: [{ type: 'hero', title: hero.title }] };
  return out;
};
const windowed = (turns, n) => (n > 0 && turns?.length > n ? turns.map((t, i) => (i < turns.length - n ? stub(t) : t)) : turns);

// The phone's window shows cards for its whole turns' delegations only, and a card reads only the
// turn its subagent ran as (web/js/features/team.js delegationsOf). So only those go, each marked
// partial: opening the run fetches it whole. A lead with dozens of subagents sent them all, every
// turn, tens of MB through the tunnel for cards the stubs never draw.
const shownRuns = (s, n, whole) => {
  const turns = s.turns.slice(-n);
  const want = new Map(); // child id -> the turn ids its delegations ran as
  for (const d of turns.flatMap((t) => t.delegations || [])) {
    if (!want.has(d.sessionId)) want.set(d.sessionId, new Set());
    want.get(d.sessionId).add(d.turnId);
  }
  const out = {};
  for (const [id, ids] of want) {
    const x = s.childSessions[id];
    // A crew job on another machine (whole: as last fetched from there) goes whole: opening it
    // must not depend on that machine answering now.
    if (x) out[id] = whole?.(id) ? { ...x, turns: leanTurns(x.turns) } : { ...x, partial: true, turns: leanTurns(x.turns?.filter((t) => ids.has(t.id)) || []) };
  }
  return out;
};

// whole(id): a child to send whole even in the window.
export const leanSession = (s, n, { whole } = {}) => {
  const cut = n > 0 && s.turns?.length > n;
  return {
    ...s,
    turns: windowed(leanTurns(s.turns), n),
    ...(s.childSessions && {
      childSessions: cut ? shownRuns(s, n, whole) : Object.fromEntries(Object.entries(s.childSessions).map(([k, x]) => [k, { ...x, turns: leanTurns(x.turns) }])),
    }),
  };
};
