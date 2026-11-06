// Home's overview (design/today.md): the words and numbers, from data wisp has (no model calls).
// DOM-free, so the tests read it; the page is features/today.js.

// How far a piece of work has come. Derived from the task's state and its PR, nothing finer: a
// task with no PR yet is Working however long it has run.
export const STAGES = ['Asked', 'Working', 'Checks', 'Your review', 'Merged'];
export function stageOf(s) {
  const pr = s.pr || s.prs?.[0]?.pr;
  if (pr?.state === 'MERGED') return 4;
  if (pr?.state === 'OPEN' && !pr.draft) {
    const c = pr.checks || {};
    return c.pass && !c.fail && !c.pending ? 3 : 2;
  }
  if (s.state === 'review' || s.state === 'done') return 3; // finished: yours to read
  return s.pending || s.live === 'Starting up' ? 0 : 1;
}

// An open PR that isn't a draft, on the task or attached by its agent.
export const openPr = (s) => [s.pr, ...(s.prs || []).map((x) => x.pr)].some((p) => p?.state === 'OPEN' && !p.draft);

// A fact, never a verdict: a long test run is quiet too. updatedAt moves with every action, so a
// running task with nothing for this long has said nothing. Never one that's asking, or a terminal
// (its work doesn't report here).
const QUIET = 10 * 60_000;
export function quietFor(s, now = Date.now()) {
  if (s.state !== 'running' || s.tui || s.asks || s.pending || now - s.updatedAt < QUIET) return '';
  const min = Math.round((now - s.updatedAt) / 60_000);
  return min < 120 ? `Quiet for ${min} min` : `Quiet for ${Math.round(min / 60)} h`;
}

// Cards are for what asks something of you; the rest of Needs you is reading.
export const isAsk = (s) => s.state === 'waiting' || !!s.reminder || s.status === 'held';

// A title short enough for a sentence, cut between words. Titles are often raw prompts.
export function shortName(title = '', max = 32) {
  const t = String(title).replace(/\s+/g, ' ').trim().replace(/[.:;,!?]+$/, '');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[.:;,!?-]+$/, '')}…`;
}


// The sentence and the line under it. It names what needs you, then says what's left:
// asks: titles, nearest first. last: { title, ago } of what finished last today.
export function sentenceOf({ asks = [], ready = 0, working = 0, last = null } = {}) {
  const names = asks.slice(0, 2).map((t) => shortName(t));
  const rest = asks.length - names.length;
  let line;
  if (asks.length === 1) line = `${names[0]} needs you.`;
  else if (asks.length === 2) line = `${names[0]} and ${names[1]} need you.`;
  else if (asks.length) line = `${names[0]}, ${names[1]} and ${rest} more need you.`;
  else if (working) line = `${working} working.`;
  else if (ready) line = `${ready} ready for review.`;
  else line = 'All quiet.';
  const sub = [];
  if (asks.length && working) sub.push(`${working} working.`);
  if (last) sub.push(`Last done ${last.ago === 'now' ? 'just now' : `${last.ago} ago`}: ${shortName(last.title, 48)}.`);
  return { line, sub: sub.join(' ') };
}

// Left in your plans: each usage window as Settings → Usage shows it, turned around: there 38%
// used, here 62% left, from the same rounded number. Accounts since removed and windows that have
// ended stay out, as they do for the spare card.
export function plansOf(agents = [], now = Date.now()) {
  const out = [];
  for (const a of agents) {
    const many = (a.accounts?.length || 0) > 1;
    for (const b of a.budget || []) {
      const acc = many ? a.accounts.find((x) => x.id === b.account) : null;
      if (many ? !acc : b.account !== 'default') continue;
      for (const w of b.windows || []) {
        if (!(w.resetsAt > now)) continue;
        out.push({ key: `${a.id}:${b.account}:${w.id}`, agent: a.id, name: a.name || a.id, account: acc?.label || '', label: w.label, left: 100 - Math.round(w.used * 100), resetsAt: w.resetsAt });
      }
    }
  }
  return out;
}

// …as one quiet line: each account's tightest window. The tooltip has the rest.
export function plansLine(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = `${r.agent}:${r.account}`;
    if (!by.has(k) || r.left < by.get(k).left) by.set(k, r);
  }
  const win = (r) => r.label.charAt(0).toLowerCase() + r.label.slice(1);
  return [...by.values()].map((r) => `${r.name}${r.account ? ` (${r.account})` : ''} ${r.left}% ${win(r)}`).join(' · ');
}
