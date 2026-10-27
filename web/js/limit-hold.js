// Ask near the limit (design/hold.md): the rule that decides whether a task or a follow-up would
// take an account's 5-hour or weekly window past the line you set (Settings → Usage). DOM-free and
// shared: the page holds a send before it goes, the server checks the same rule (server/guard.js).

// Settings → Usage → Ask near the limit. Off, or the share of a window wisp asks at.
export const HOLD_LINES = ['off', '80', '90', '95'];
export const HOLD_DEFAULT = '90';
// After a yes, the next ask for that window comes at these, then not until the reset.
const STEPS = [0.95, 0.99];

// The setting as a share (0.9), or null when it's off.
export function holdLine(setting) {
  const v = HOLD_LINES.includes(String(setting)) ? String(setting) : HOLD_DEFAULT;
  return v === 'off' ? null : Number(v) / 100;
}

// The line for a window you already said yes to (at `acked`): the next step above it, or null.
export function nextLine(line, acked) {
  if (line === null || line === undefined) return null;
  if (!(acked > 0)) return line;
  return [line, ...STEPS].find((x) => x > acked + 1e-9) ?? null;
}

// windows: an account's, as the server shows them (server/guard.js view): [{ id, label, used,
// resetsAt, line, est: { first: [lo, mid, hi], followUp: [lo, mid, hi] } }], shares of the window
// a run like this adds (the running ones on the account included). kind: 'first' | 'followUp'.
// The window that would cross its line, the one nearest its limit when several would, as
// { id, label, used, to: [lo, hi], resetsAt, line }, or null.
export function holdFor(windows, kind = 'first') {
  let out = null;
  for (const w of windows || []) {
    if (!(w?.line > 0) || !Number.isFinite(w.used)) continue;
    const [lo = 0, mid = 0, hi = 0] = w.est?.[kind] || [];
    const at = w.used + mid;
    if (at < w.line || (out && at <= out.at)) continue;
    out = { id: w.id, label: w.label, used: w.used, to: [Math.min(1, w.used + lo), Math.min(1, w.used + hi)], resetsAt: w.resetsAt || null, line: w.line, at };
  }
  if (!out) return null;
  delete out.at;
  return out;
}

// How the page says where a window would end up: "about 93%", "88–96%" or "past the limit".
export function holdTo(h) {
  const [lo, hi] = (h?.to || []).map((x) => Math.floor(x * 100));
  if (lo >= 100) return 'past the limit';
  if (hi - lo > 2) return `${lo}–${Math.min(hi, 100)}%`;
  return `about ${Math.min(hi, 99)}%`;
}
