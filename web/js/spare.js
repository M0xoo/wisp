// Spare allowance (design/budget.md): a long usage window (weekly, 30-day) that resets soon with a
// good share still unused. What's left at the reset is gone, so split view's home says so, with a
// way to start a task on that account. Advice only: wisp never switches accounts or spends a banked
// reset for you; the card only fills the launcher when you click it. DOM-free, so the tests read it.

const H = 3600_000;
export const SPARE_HOURS = 24; // resets within this many hours (spell prop split.spare.hours, 1–40)
export const SPARE_LEFT = 0.2; // with at least this share of the window left
const LONG = 24 * H; // a 5-hour window always resets soon: only windows of a day or more count
const samePeriod = (a, b) => Math.abs(a - b) < 10 * 60_000; // Codex's reset drifts a little

// The key a dismissal is kept under: one window of one account, until its next period.
export const spareKey = (x) => `${x.agent}:${x.account}:${x.window}`;

// agents: GET /agents (each { id, name, available, accounts?, budget? }). seen: { [spareKey]: resetsAt }
// for the cards dismissed this period. → [{ agent, name, account, accountLabel, window, label, left,
// resetsAt, at }], soonest reset first.
export function spareOf(agents = [], { now = Date.now(), hours = SPARE_HOURS, left: min = SPARE_LEFT, seen = {} } = {}) {
  const out = [];
  for (const a of agents) {
    if (!a?.available || !Array.isArray(a.budget)) continue;
    const many = (a.accounts?.length || 0) > 1;
    for (const b of a.budget) {
      // Its account as the launcher names it: '' for the CLI's own login.
      const acc = many ? a.accounts.find((x) => x.id === b.account) : null;
      if (many ? !acc : b.account !== 'default') continue; // an account since removed
      const live = (b.windows || []).filter((w) => w.resetsAt > now);
      // Used up somewhere (the 5-hour window): a task started now would just wait.
      if (live.some((w) => w.used >= 0.995)) continue;
      for (const w of live) {
        if (!(w.ms >= LONG) || w.resetsAt - now > hours * H || 1 - w.used < min - 1e-9) continue;
        if (w.hitAt) continue; // at this pace it runs out before the reset: nothing to spare
        const x = { agent: a.id, name: a.name || a.id, account: acc ? acc.id : '', accountLabel: acc?.label || '', window: w.id, label: w.label, left: 1 - w.used, resetsAt: w.resetsAt, at: b.at || null };
        const s = seen[spareKey(x)];
        if (s && samePeriod(s, w.resetsAt)) continue;
        out.push(x);
      }
    }
  }
  return out.sort((p, q) => p.resetsAt - q.resetsAt);
}

// Whose window, in words: "Codex (work)’s weekly window".
export function spareWhose(x) {
  const win = x.label.charAt(0).toLowerCase() + x.label.slice(1);
  return `${x.name}${x.accountLabel ? ` (${x.accountLabel})` : ''}’s ${win} window`;
}

// The card in one sentence (its label for screen readers): "38% of Codex’s weekly window left,
// resets Thu 21:00" (the page formats the time).
export const spareWords = (x, when) => `${Math.round(x.left * 100)}% of ${spareWhose(x)} left, resets ${when}`;

// Dismissals for windows that have since reset are let go, so the store doesn't grow.
export function pruneSeen(seen = {}, now = Date.now()) {
  return Object.fromEntries(Object.entries(seen).filter(([, t]) => t > now - 10 * 60_000));
}
