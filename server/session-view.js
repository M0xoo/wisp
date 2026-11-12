// What GET /sessions/:id?lean=1 sends: a task as the page needs it.
//
// A lead comes with its subagents' sessions, so its cards can show their reports and diffs.
// ?lean=1 (the page): without each edit's whole file from before it, which only rollback reads
// (on the server). A tenth or more of a big task.
// &turns=N (the page, desktop and phone): the latest N turns whole, older ones as stubs with what
// their folded row shows (prompt, time, result title, mode and account) and what the usage popover
// sums (stats). A task of 250 turns and 50 subagents was 68 MB whole, sent again on every refresh
// while it ran. &also=<turn id>,…: those turns whole too (an old turn unfolded by hand).
// &turns=0 or none: every turn whole (the Changes view, which lists every edit).

const leanTurns = (turns) => turns?.map((t) => (t.changes?.some((x) => 'beforeFile' in x) ? { ...t, changes: t.changes.map(({ beforeFile, ...x }) => x) } : t));
const STUB = ['id', 'prompt', 'by', 'goal', 'status', 'startedAt', 'endedAt', 'rolledBackAt', 'moved', 'mode', 'account', 'agent', 'model', 'effort', 'forked', 'shared', 'btw', 'held', 'attachments', 'stats', 'details'];
// A checkpoint's lists of untracked files are tens of KB on some turns; a folded row and Fork
// read only these.
const CHECKPOINT = ['commit', 'head', 'branch', 'dirty', 'at'];
const stub = (t) => {
  const out = { stub: true };
  for (const k of STUB) if (t[k] !== undefined) out[k] = t[k];
  if (t.checkpoint) out.checkpoint = Object.fromEntries(CHECKPOINT.filter((k) => t.checkpoint[k] !== undefined).map((k) => [k, t.checkpoint[k]]));
  const hero = t.presentation?.blocks?.find((b) => b.type === 'hero');
  // A Compact now row says what it did: its markdown (web/js/features/turns.js compactSaid).
  const said = t.by === 'compact' && t.presentation?.blocks?.find((b) => b.type === 'markdown');
  const blocks = [hero && { type: 'hero', title: hero.title }, said && { type: 'markdown', text: said.text }].filter(Boolean);
  if (blocks.length) out.presentation = { blocks };
  return out;
};

// The turns sent whole: the latest n, and the ones asked for by id.
const wholeTurns = (turns, n, also) => turns.filter((t, i) => i >= turns.length - n || also.has(t.id));

// The window shows cards for its whole turns' delegations only, and a card reads only the turn its
// subagent ran as (web/js/features/team.js delegationsOf). So only those go, each marked partial:
// opening the run fetches it whole. A lead with dozens of subagents sent them all, every turn, tens
// of MB for cards the stubs never draw.
const shownRuns = (s, turns, whole) => {
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

// n: the latest turns to send whole (0: all). whole(id): a child to send whole even in the window.
// also: ids of older turns to send whole as well.
export const leanSession = (s, n, { whole, also = [] } = {}) => {
  const turns = s.turns || [];
  const extra = new Set(also);
  const cut = n > 0 && turns.length > n;
  // Stubbed before leanTurns: a stub reads no heavy field, so a task loaded from its light file
  // (server/store.js) isn't read whole from disk for turns that aren't sent.
  const keep = cut ? new Set(wholeTurns(turns, n, extra)) : null;
  return {
    ...s,
    turns: s.turns && (cut ? turns.map((t) => (keep.has(t) ? leanTurns([t])[0] : stub(t))) : leanTurns(turns)),
    ...(s.childSessions && {
      childSessions: cut ? shownRuns(s, [...keep], whole) : Object.fromEntries(Object.entries(s.childSessions).map(([k, x]) => [k, { ...x, turns: leanTurns(x.turns) }])),
    }),
  };
};
