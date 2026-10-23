// Small display formatters shared across the page.

// The agent's own verdict. Not "Done": that's the list a task goes to when you mark it done.
export const STATUS_LABEL = { done: 'Finished', partial: 'Partial', blocked: 'Blocked', info: 'Report' };

export function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// A date in the user's locale. toLocaleString with options builds a new formatter on every call
// (about 150 times slower than reusing one), and lists and turns format many dates per render.
const formats = new Map();
export function fmtDate(t, opts) {
  const key = JSON.stringify(opts);
  let f = formats.get(key);
  if (!f) formats.set(key, (f = new Intl.DateTimeFormat([], opts)));
  return f.format(new Date(t));
}
export const SHORT_TIME = { hour: '2-digit', minute: '2-digit' };
const FULL_TIME = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
// "28m" says how long ago; its tooltip says when, and the details column spells out "ago" so it
// isn't read as how long the task ran.
export const agoLong = (t) => (ago(t) === 'now' ? 'just now' : `${ago(t)} ago`);
export const timeAttrs = (t) => `title="${fmtDate(t, FULL_TIME)}"`;
export const DAY_TIME = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };

export const whenLabel = (t) => {
  if (!t) return '';
  const today = new Date().toDateString() === new Date(t).toDateString();
  return fmtDate(t, today ? SHORT_TIME : { weekday: 'short', ...DAY_TIME });
};

export const money = (v) => (v >= 100 ? `$${Math.round(v)}` : `$${(v || 0).toFixed(2)}`);
export const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
