// Small display formatters shared across the page.

export const STATUS_LABEL = { done: 'Done', partial: 'Partial', blocked: 'Blocked', info: 'Report' };

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

export const whenLabel = (t) => {
  if (!t) return '';
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString([], today ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export const money = (v) => (v >= 100 ? `$${Math.round(v)}` : `$${(v || 0).toFixed(2)}`);
export const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
