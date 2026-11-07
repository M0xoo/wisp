// "This Mac" (design/machine-page.md): the words and numbers the pane, the top-bar chip and the
// task rows show from GET /machine and GET /load. DOM-free, so test/machine-view.test.js reads it.

const GB = 1024 ** 3;
export const HOUR = 3600_000;
export const TIGHT = 10; // the chip shows once free memory is under the floor plus this
export const FLOOR_DEFAULT = 15; // server/load.js LOAD_DEFAULTS

// The pane's name, by the OS wisp runs on (not the browser's: a phone looks at the computer).
export const machineLabel = (platform) => (platform === 'darwin' ? 'This Mac' : platform === 'win32' ? 'This PC' : 'This computer');

export function size(n) {
  if (!(n >= 0)) return '';
  if (n < 1024 ** 2) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < GB) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${(n / GB).toFixed(n < 10 * GB ? 1 : 0)} GB`;
}
export const pctText = (v) => (v == null || !Number.isFinite(v) ? '—' : `${Math.round(v)}%`);
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// 2 h 10 min, 25 min, under a minute.
export function span(ms) {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

const floorOf = (load) => load?.limits?.floor ?? load?.guard?.floor ?? FLOOR_DEFAULT;

// The top-bar chip: shown only when it matters (memory tight, work held, automations paused, or
// something left behind). { lead, rest, text, tone, why } or null. load is GET /load (or /machine's
// mem and guard), pausedUntil from config, left the count of processes left behind.
export function chipOf({ load, pausedUntil = 0, left = 0, now = Date.now() } = {}) {
  if (!load && !left && !(pausedUntil > now)) return null;
  const free = load?.memFreePct ?? load?.mem?.freePct ?? null;
  const runs = load?.runs ?? load?.guard?.runs ?? 0;
  const floor = floorOf(load);
  // Work waiting for the computer: GET /load's { kind, why }, or /machine's guard.held kind. A pause
  // has its own words, from pausedUntil.
  const gh = load?.held ?? load?.guard?.held;
  const held = gh && gh !== 'paused' && gh.kind !== 'paused' ? gh : null;
  const tight = free != null && floor != null && free < floor + TIGHT;
  const paused = pausedUntil > now;
  if (!tight && !held && !paused && !left) return null;
  // lead is the number that always shows (the phone shows only it), rest the words after it.
  const [lead, rest] = tight || held ? [pctText(free), ` memory${runs ? ` · ${runs} running` : ''}`] : paused ? ['Paused', ` until ${clock(pausedUntil, now)}`] : [String(left), ' left behind'];
  const why = [held && (typeof held === 'object' ? held.why : load?.guard?.why), paused && `Automations paused until ${clock(pausedUntil, now)}`, left && `${plural(left, 'process', 'processes')} left behind by finished runs`].filter(Boolean);
  return { lead, rest, text: lead + rest, tone: free != null && floor != null && free < floor ? 'bad' : tight || held ? 'warn' : '', why: why.join('. ') };
}

// 20:00 today, Tue 8:00 later.
export function clock(t, now = Date.now()) {
  const d = new Date(t);
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  return new Date(now).toDateString() === d.toDateString() ? hm : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${hm}`;
}

// The task row's RAM column: only for a running task the server marked heavy (summary res).
export const resText = (s) => (s?.state === 'running' && s.res?.rss > 0 ? size(s.res.rss) : '');

// What's using it: running tasks outside the crew and crew members (their jobs summed), by RAM.
export function usingRows(m) {
  const crewIds = new Set((m?.crew || []).map((c) => c.id));
  const jobsOf = (c) => (Array.isArray(c.jobs) ? c.jobs : (m.tasks || []).filter((t) => t.crew === c.id).map((t) => t.id));
  const tasks = (m?.tasks || []).filter((t) => !t.crew || !crewIds.has(t.crew)).map((t) => ({ key: `t:${t.id}`, kind: 'task', id: t.id, title: t.title || 'Task', rss: t.rss || 0, cpu: t.cpu || 0, procs: t.procs || 0, bytes: t.worktreeBytes ?? null, ids: [t.id] }));
  const crew = (m?.crew || []).map((c) => {
    const ids = jobsOf(c);
    const bytes = (m.tasks || []).filter((t) => ids.includes(t.id)).reduce((n, t) => n + (t.worktreeBytes || 0), 0);
    return { key: `c:${c.id}`, kind: 'crew', id: c.id, title: c.name || 'Crew member', rss: c.rss || 0, cpu: c.cpu || 0, procs: ids.length, bytes: ids.length ? bytes : null, ids };
  });
  return [...tasks, ...crew].sort((a, b) => b.rss - a.rss || a.title.localeCompare(b.title));
}

// Free up space: the reclaim groups, in the order a person would clear them (safest first).
export const RECLAIM = {
  merged: { one: 'folder of a merged or closed PR', many: 'folders of merged or closed PRs', safe: true },
  done: { one: 'folder of a Done task', many: 'folders of Done tasks', safe: true },
  crew: { one: 'folder of a finished crew job', many: 'folders of finished crew jobs', safe: true },
  leftover: { one: 'folder no task knows', many: 'folders no task knows', safe: false },
};
export const reclaimRows = (m) =>
  (m?.reclaim || [])
    .filter((g) => RECLAIM[g.kind] && g.count > 0)
    .sort((a, b) => Object.keys(RECLAIM).indexOf(a.kind) - Object.keys(RECLAIM).indexOf(b.kind))
    .map((g) => ({ ...g, label: `${g.count} ${g.count === 1 ? RECLAIM[g.kind].one : RECLAIM[g.kind].many}`, safe: RECLAIM[g.kind].safe }));

// Last 24 h, from the 1-min history: lowest free memory, most runs at once, how long automations
// waited (minutes with something held) and what the disk got back (every drop in wisp's folders).
export function dayStats(history = [], now = Date.now()) {
  const h = history.filter((p) => p && p.at > now - 24 * HOUR);
  if (!h.length) return null;
  const frees = h.map((p) => p.freePct).filter((v) => v != null);
  let freed = 0;
  let waited = 0;
  for (let i = 1; i < h.length; i++) {
    const d = (h[i - 1].worktreeBytes ?? 0) - (h[i].worktreeBytes ?? 0);
    if (h[i - 1].worktreeBytes != null && h[i].worktreeBytes != null && d > 0) freed += d;
    if (h[i].held) waited += Math.min(h[i].at - h[i - 1].at, 5 * 60_000);
  }
  return { lowFree: frees.length ? Math.min(...frees) : null, peakRuns: Math.max(0, ...h.map((p) => p.runs || 0)), waited, freed };
}

// A gauge's sparkline over the last hour: points scaled into a w×h box, and the line to mark.
export function spark(history = [], key, { now = Date.now(), w = 120, h = 32, max = null, mark = null } = {}) {
  const pts = history.filter((p) => p && p.at > now - HOUR && p[key] != null);
  if (pts.length < 2) return { d: '', mark: null };
  const top = max ?? Math.max(1, mark ?? 0, ...pts.map((p) => p[key])) * 1.1;
  const x = (t) => (((t - (now - HOUR)) / HOUR) * w).toFixed(1);
  const y = (v) => (h - Math.min(1, Math.max(0, v / top)) * (h - 2) - 1).toFixed(1);
  return { d: pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.at)} ${y(p[key])}`).join(' '), mark: mark == null ? null : Number(y(mark)) };
}

// Pause automations ▾: for an hour, or until tomorrow 8:00.
export function pauseChoices(now = Date.now()) {
  const t = new Date(now);
  t.setDate(t.getDate() + 1);
  t.setHours(8, 0, 0, 0);
  return [
    ['For 1 hour', now + HOUR],
    ['Until tomorrow 8:00', t.getTime()],
  ];
}

// Later ▾ on a running row: stop now and carry on in an hour, tonight (20:00, while that's ahead
// by an hour) or tomorrow at 9:00.
export function laterChoices(now = Date.now()) {
  const tonight = new Date(now);
  tonight.setHours(20, 0, 0, 0);
  const morning = new Date(now);
  morning.setDate(morning.getDate() + 1);
  morning.setHours(9, 0, 0, 0);
  return [['In 1 hour', now + HOUR], ...(tonight.getTime() - now > HOUR ? [['Tonight', tonight.getTime()]] : []), ['Tomorrow morning', morning.getTime()]];
}
export const LATER_TEXT = 'Carry on where you stopped.';

// The automations line: what waits and why, or that they run as usual. guard.held is null or the
// kind holding them ('paused' | 'battery' | 'memory' | 'cpu' | 'runs'), guard.why its sentence.
export function automationsLine(m, pausedUntil = 0, now = Date.now()) {
  const g = m?.guard || {};
  const until = Math.max(pausedUntil || 0, g.pausedUntil || 0);
  if (until > now) return `Automations paused until ${clock(until, now)}`;
  if (g.held && g.held !== 'paused') return g.why || (typeof g.held === 'object' && g.held.why) || 'Waiting for the computer';
  return 'Running as usual';
}
