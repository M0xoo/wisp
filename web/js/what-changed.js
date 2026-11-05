// What moved in the CLI since the task's last comparable turn, from stats.cli (server/runner.js):
// { version?: [from, to], tools?: { added, removed } | true, catalog?: true }, or null. DOM-free.
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
    ...(moved('catalog') && { catalog: true }),
  };
  return Object.keys(out).length ? out : null;
}
