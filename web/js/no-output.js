// *No output for 12 min* in the working panel: a plain fact about a running turn, words only, that
// counts up and clears by itself. DOM-free: turns.js paints it, app.js's 1 s tick keeps it current.

// Measured on 2,583 stored turns: Bash's 10-minute cap makes a cliff at 10.5 min.
export const NO_OUTPUT_MS = 12 * 60_000;

// Past this with no event, the stream only looks open: the server pings every 25 s (server/index.js).
export const QUIET_STREAM_MS = 60_000;

// When the turn last showed a sign of life. All the steps, newest first: a call's result can land
// on an older step when calls overlap. No allocation, at most a few hundred steps: fine every second.
export function lastOutputAt(t) {
  let newest = t.startedAt;
  const steps = t.activity || [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const a = steps[i];
    if (a.t > newest) newest = a.t;
    if (a.outAt > newest) newest = a.outAt;
  }
  return newest;
}

// A delegate of this turn still runs (its live row is in the same panel): delegationsOf in
// features/team.js, whose missing child or turn counts as running too.
const delegateRunning = (s, t) =>
  (t.delegations || []).some((d) => {
    const ct = s.childSessions?.[d.sessionId]?.turns?.find((x) => x.id === d.turnId);
    return !ct || ct.status === 'running';
  });

// A built-in subagent (Claude's Task) is a call that stays open while it works. Its result stamps
// or fills the step; a harness with no call id can't tell, and counts as no call.
const subagentOpen = (t) => (t.activity || []).some((a) => a.kind === 'agent' && a.call && !a.outAt && !a.output);

// The words for this turn at `now`, or ''.
export function noOutputLine(s, t, now) {
  if (t.status !== 'running' || s.ask || s.state === 'waiting') return '';
  const quiet = now - lastOutputAt(t);
  if (quiet < NO_OUTPUT_MS || delegateRunning(s, t) || subagentOpen(t)) return '';
  const min = Math.floor(quiet / 60_000);
  if (min < 60) return `No output for ${min} min`;
  const rest = min % 60;
  return `No output for ${Math.floor(min / 60)} h${rest ? ` ${rest} min` : ''}`;
}

// Whether the page's copy of a task can back that line: its clock runs on while the stream is down
// and events are lost, so from a drop on a task counts only once it's been read again after `hello`.
// A page that never lost its stream has missed nothing (its first paint needs no hello).
export function freshness() {
  let lost = false;
  let down = false;
  let lastHeard = 0;
  const read = new Set();
  return {
    drop() {
      lost = down = true;
      read.clear();
    },
    hello(now) {
      down = false;
      lastHeard = now;
    },
    heard(now) {
      lastHeard = now;
    },
    read(id) {
      if (!down) read.add(id);
    },
    ok(id, now) {
      if (down || (lastHeard && now - lastHeard > QUIET_STREAM_MS)) return false;
      return !lost || read.has(id);
    },
  };
}

// The page's own: live.js tells it about the stream, turns.js asks before it paints.
export const stream = freshness();
