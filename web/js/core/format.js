// Small display formatters shared across the page.

// The agent's own verdict. Not "Done": that's the list a task goes to when you mark it done.
export const STATUS_LABEL = { done: 'Finished', partial: 'Partial', blocked: 'Blocked', failed: 'Failed', limit: 'At limit', refused: 'Refused', signedOut: 'Signed out', info: 'Report', held: 'Held' };

// Blocked is the agent's own word: it stopped and says why. A run that never got that far gets
// wisp's: it failed, hit a usage limit, was signed out or was refused. Each one needs something else from you, so
// the list says which (`halt` on a task's summary); `status` stays 'blocked' for spells and panes.
export const haltOf = (t) => (t?.limit ? 'limit' : t?.signedOut && !t.signedOut.stillIn ? 'signedOut' : t?.refusal || t?.devices ? 'refused' : t?.status === 'error' ? 'failed' : '');
export const statusKey = (s) => (s.status === 'blocked' && s.halt) || s.status || 'done';
export const statusPill = (s) => `<span class="pill st-${statusKey(s)}"><i></i>${STATUS_LABEL[statusKey(s)] || STATUS_LABEL.done}</span>`;

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
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
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
// A turn's time: today's is just "23:42" (the date said nothing and pushed the prompt over); the tip has it all.
export const turnTime = (t) => `<time ${timeAttrs(t)}>${fmtDate(t, new Date().toDateString() === new Date(t).toDateString() ? SHORT_TIME : DAY_TIME)}</time>`;

export const whenLabel = (t) => {
  if (!t) return '';
  const today = new Date().toDateString() === new Date(t).toDateString();
  return fmtDate(t, today ? SHORT_TIME : { weekday: 'short', ...DAY_TIME });
};

// What a turn has done so far, for the working panel and a judge's run.
export const actionCount = (t) => {
  const n = t.activity.filter((a) => a.kind !== 'text').length;
  return `${n} action${n === 1 ? '' : 's'}`;
};
export const money = (v) => (v >= 100 ? `$${Math.round(v)}` : `$${(v || 0).toFixed(2)}`);
export const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
