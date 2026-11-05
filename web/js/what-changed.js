// What moved in the CLI since the task's last comparable turn, from stats.cli (server/runner.js):
// { version?: [from, to], tools?: { added, removed } | true, catalog?: { added, removed, changed } | true },
// or null. DOM-free.
// A field counts only when both turns have it, so a first turn, an old turn or a failed probe says
// nothing. Another harness or account has its own catalog and tools: skipped past, never compared.

const accountOf = (t) => t.stats.cli.account || 'default';

// The list is stored once per task, on the first turn that had that hash (server/budget.js toolSet).
const toolList = (session, hash) => session.turns.find((t) => t.details?.tools?.hash === hash && Array.isArray(t.details.tools.list))?.details.tools.list;

function toolsMoved(session, from, to) {
  const was = toolList(session, from);
  const now = toolList(session, to);
  if (!was || !now) return true;
  const added = now.filter((n) => !was.includes(n));
  const removed = was.filter((n) => !now.includes(n));
  return added.length || removed.length ? { added, removed } : true;
}

// Per model when both turns have the hashes (stats.cli.models, Codex); older turns have one hash.
function catalogMoved(was, now) {
  if (!was || !now) return true;
  const added = Object.keys(now).filter((m) => !(m in was));
  const removed = Object.keys(was).filter((m) => !(m in now));
  const changed = Object.keys(now).filter((m) => m in was && was[m] !== now[m]);
  return added.length || removed.length || changed.length ? { added, removed, changed } : true;
}

export function whatChanged(session, turn) {
  const cur = turn?.stats?.cli;
  const turns = session?.turns;
  if (!cur || !turns) return null;
  const at = turns.findIndex((t) => t === turn || (turn.id && t.id === turn.id));
  const agent = turn.agent || session.agent;
  const prev = turns.slice(0, Math.max(at, 0)).findLast((t) => t.stats?.cli && (t.agent || session.agent) === agent && accountOf(t) === accountOf(turn))?.stats.cli;
  if (!prev) return null;
  const moved = (key) => !!prev[key] && !!cur[key] && prev[key] !== cur[key];
  const out = {
    ...(moved('version') && { version: [prev.version, cur.version] }),
    ...(moved('tools') && { tools: toolsMoved(session, prev.tools, cur.tools) }),
    ...(moved('catalog') && { catalog: catalogMoved(prev.models, cur.models) }),
  };
  return Object.keys(out).length ? out : null;
}
