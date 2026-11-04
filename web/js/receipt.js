// A turn's usage receipt: the quiet line in its trail bar (web/js/features/turns.js) that says what
// the run took: "38k tokens · 71% cache · 3% of weekly", and Past your plan when it was billed
// beyond the plan (turn.overage, server/runner.js #pastPlan). DOM-free, so the tests read it as is.
//
// Tokens: everything the model read and wrote. Anthropic counts cache reads and writes apart from
// input_tokens (stats.cacheReadTokens / cacheWriteTokens); OpenAI's input_tokens already holds the
// cached ones (stats.cachedInputTokens). Cache: the share of what it read that came from the cache.
// Plan: the turn's share of its account's longest window (turn.plan, server/budget.js addShare),
// which lands with the next report, so a turn that just ended may not have it yet.

const DAY = 864e5;
const NAMES = { five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'weekly Opus', seven_day_sonnet: 'weekly Sonnet' };
// The longest window first: with the 5-hour one gone on some plans, the week is what people count.
const LENGTH = { seven_day: 7 * DAY, seven_day_opus: 7 * DAY - 1, seven_day_sonnet: 7 * DAY - 2, five_hour: 5 * 36e5 };
const lengthOf = (id) => LENGTH[id] ?? (Number(/^w(\d+)m$/.exec(id)?.[1]) * 60_000 || 0);

export function windowName(id) {
  if (NAMES[id]) return NAMES[id];
  const mins = Number(/^w(\d+)m$/.exec(id)?.[1]) || 0;
  return !mins ? 'plan' : mins >= 1440 ? `${Math.round(mins / 1440)}-day` : `${Math.round(mins / 60)}-hour`;
}

export const OVERAGE = {
  extra: { label: 'Past your plan', tip: 'Billed as extra usage: the plan’s windows were used up, so the provider charged this run on top' },
  credits: { label: 'Past your plan', tip: 'Billed to your Codex credits: the plan’s windows were used up, so this run took credits' },
  api: { label: 'API credit', tip: 'Billed to an API key, not your plan: Claude Code found an API key (ANTHROPIC_API_KEY or an apiKeyHelper) and used it' },
};

// What a turn read (its cache reads and writes counted in), of that from the cache, and wrote.
export function turnTokens(t) {
  const st = t?.stats || {};
  const n = (x) => (Number.isFinite(x) && x > 0 ? x : 0);
  const anthropic = 'cacheReadTokens' in st || 'cacheWriteTokens' in st;
  const read = anthropic ? n(st.inputTokens) + n(st.cacheReadTokens) + n(st.cacheWriteTokens) : n(st.inputTokens);
  const cached = anthropic ? n(st.cacheReadTokens) : Math.min(n(st.cachedInputTokens), read);
  // Claude's modelUsage (stats.models) counts every model the run used, its subagents' included,
  // which usage can leave out: the larger of the two is the turn's.
  if (st.models?.length) {
    const m = st.models.reduce((a, x) => ({ read: a.read + n(x.input) + n(x.cacheRead) + n(x.cacheWrite), cached: a.cached + n(x.cacheRead), output: a.output + n(x.output) }), { read: 0, cached: 0, output: 0 });
    if (m.read + m.output > read + n(st.outputTokens)) return m;
  }
  return { read, cached, output: n(st.outputTokens) };
}

// → { tokens, cache, plan: [{ window, used }] longest first, overage } or null when there's nothing to say.
export function receiptOf(t) {
  const { read, cached, output } = turnTokens(t);
  const tokens = read + output;
  const by = {};
  for (const p of t?.plan || []) if (p?.window && p.used > 0) by[p.window] = (by[p.window] || 0) + p.used;
  const plan = Object.entries(by)
    .map(([window, used]) => ({ window, used }))
    .sort((a, b) => lengthOf(b.window) - lengthOf(a.window));
  const overage = OVERAGE[t?.overage?.kind] ? t.overage.kind : '';
  if (!tokens && !plan.length && !overage) return null;
  return { tokens, cache: read && cached ? cached / read : null, plan, overage };
}

// 38400 → "38k", 1250000 → "1.3M", 820 → "820".
export function tokenWords(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

// "<1%" for a share too small to round to one, and never "100%" for one that isn't all of it.
const pct = (x) => (x > 0 && x < 0.005 ? '<1%' : x < 1 && x > 0.99 ? '99%' : `${Math.round(x * 100)}%`);

// The line's parts, in order: ["38k tokens", "71% cache", "3% of weekly"]. Only the longest window
// is on the line; the tooltip has every window.
export function receiptParts(r) {
  if (!r) return [];
  return [r.tokens ? `${tokenWords(r.tokens)} tokens` : '', r.cache != null && r.tokens ? `${pct(r.cache)} cache` : '', r.plan[0] ? `${pct(r.plan[0].used)} of ${windowName(r.plan[0].window)}` : ''].filter(Boolean);
}

export function receiptTip(r) {
  if (!r) return '';
  const plan = r.plan.map((p) => `${pct(p.used)} of the ${windowName(p.window)} window`).join(', ');
  return [
    r.tokens ? `${r.tokens.toLocaleString('en-US')} tokens read and written` : '',
    r.cache != null && r.tokens ? `${pct(r.cache)} of what it read came from the cache` : '',
    plan ? `This turn took ${plan}, as wisp traced it from what the CLI reports` : '',
  ].filter(Boolean).join('. ');
}

// Account comparison (server/budget.js compareAccounts, on the harness list as `compare`): per
// model, each account's median turn over the last 7 days, once each has COMPARE_MIN turns on it.
// A diagnostic, in numbers only: it never says which account to use, and wisp never switches.
export const COMPARE_MIN = 5;
export const COMPARE_DAYS = 7;

export function median(xs) {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// How many times the most output per turn is the least's: 1.9, or null under 1.2× (about the same).
export function compareRatio(c) {
  const outs = (c?.accounts || []).map((x) => x.output).filter((x) => x > 0);
  if (outs.length < 2) return null;
  const r = Math.max(...outs) / Math.min(...outs);
  return r >= 1.2 ? r : null;
}

// "Work uses 1.9× the output tokens per turn of Personal (n=14 / 11)", or "about the same".
// labelOf(account id) → its name.
export function compareWords(c, labelOf) {
  const list = c?.accounts || [];
  if (list.length < 2) return '';
  const r = compareRatio(c);
  const hi = list.reduce((a, b) => (b.output > a.output ? b : a));
  const lo = list.reduce((a, b) => (b.output < a.output ? b : a));
  const n = `(n=${list.map((x) => x.turns).join(' / ')})`;
  const tools = list.filter((x) => x.missing?.length).map((x) => `${labelOf(x.account)} has no ${toolWords(x.missing)}`);
  const more = tools.length ? `; ${tools.join('; ')}` : '';
  if (!r) return `${list.map((x) => labelOf(x.account)).join(' and ')} use about the same output tokens per turn ${n}${more}`;
  return `${labelOf(hi.account)} uses ${r.toFixed(1)}× the output tokens per turn of ${labelOf(lo.account)} ${n}${more}`;
}

// Tools an account lacks, in words: "WebFetch", "WebFetch or the github MCP tools", "A, B, C and 4 more".
// An MCP server's tools go under its name (mcp__github__create_issue → the github MCP tools).
export function toolWords(names) {
  const out = [];
  for (const n of names || []) {
    const srv = /^mcp__(.+?)__/.exec(n)?.[1];
    const w = srv ? `the ${srv} MCP tools` : n;
    if (!out.includes(w)) out.push(w);
  }
  if (out.length > 3) return `${out.slice(0, 3).join(', ')} and ${out.length - 3} more`;
  return out.length > 1 ? `${out.slice(0, -1).join(', ')} or ${out.at(-1)}` : out[0] || '';
}

// One account's numbers in words: "4.1k out · 52k in · 81% cache · 14 turns".
export function compareParts(x) {
  return [`${tokenWords(x.output)} out`, `${tokenWords(x.input)} in`, ...(x.cache != null ? [`${pct(x.cache)} cache`] : []), `${x.turns} turns`];
}

// The receipt's tooltip line for a turn on `model` with `account`: the other accounts' median turn
// beside this one's, or '' when the comparison isn't there (fewer than COMPARE_MIN turns each).
export function compareTip(compare, model, account, labelOf) {
  const c = (compare || []).find((x) => x.model === (model || ''));
  if (!c || !c.accounts.some((x) => x.account === (account || 'default'))) return '';
  return `Median turn on this model over the last ${COMPARE_DAYS} days: ${c.accounts.map((x) => `${labelOf(x.account)} ${tokenWords(x.output)} out / ${tokenWords(x.input)} in`).join(', ')}. Settings → Usage compares the accounts`;
}

// Where a turn's tokens went (server/adapters/claude.js: stats.models from the result's modelUsage,
// stats.subagents from each Agent call's messages). claude-opus-5-5 → "Opus 5.5", opus → "Opus".
export function modelWords(id) {
  const s = String(id || '');
  const m = /^claude-(?:(\d+)-(?:(\d)-)?)?(opus|sonnet|haiku|fable)(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:-\d{8})?(\[1m\])?$/i.exec(s);
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  if (m) {
    const v = m[4] ? `${m[4]}${m[5] ? `.${m[5]}` : ''}` : m[1] ? `${m[1]}${m[2] ? `.${m[2]}` : ''}` : '';
    return `${cap(m[3])}${v ? ` ${v}` : ''}${m[6] ? ' (1M)' : ''}`;
  }
  return /^(opus|sonnet|haiku|fable)$/i.test(s) ? cap(s) : s;
}

// All the output the turn wrote, its subagents' included (modelUsage has them; usage may not).
export function turnOutput(t) {
  const st = t?.stats || {};
  const n = (x) => (Number.isFinite(x) && x > 0 ? x : 0);
  const models = (st.models || []).reduce((a, m) => a + n(m.output), 0);
  const subs = (st.subagents || []).reduce((a, x) => a + n(x.output), 0);
  return Math.max(models, n(st.outputTokens), subs);
}

const agentsWord = (x) => `${x.calls} ${x.type} agent${x.calls === 1 ? '' : 's'}`;

// "Claude Code ran page reads as an agent on Opus 5.5 on this account": a web-fetch agent ran on a
// run whose tools had no WebFetch (CC#106743), or ''.
export function insteadWords(x) {
  return x?.instead === 'WebFetch' ? `Claude Code ran page reads as an agent${x.model ? ` on ${modelWords(x.model)}` : ''} on this account` : '';
}

// The receipt's subagent line, for the subagent type that wrote most: "3 web-fetch agents · Opus 5.5 ·
// 27k of 41k output", or '' when no subagent ran.
export function subagentParts(t) {
  const x = t?.stats?.subagents?.[0];
  if (!x) return [];
  const total = turnOutput(t);
  return [agentsWord(x), x.model ? modelWords(x.model) : '', x.output ? `${tokenWords(x.output)} of ${tokenWords(total)} output` : ''].filter(Boolean);
}

// Subagents on Haiku (Settings → Usage, defaults.subagentModel). The share of the turn's output
// written by subagents on the task's own model (stats.subagents[].same), 0–1.
export const SUBAGENT_OFFER_AT = 0.4;
export function sameModelShare(t) {
  const total = turnOutput(t);
  if (!total) return 0;
  return (t?.stats?.subagents || []).filter((x) => x.same).reduce((a, x) => a + (Number.isFinite(x.output) && x.output > 0 ? x.output : 0), 0) / total;
}
// Offer "Run subagents on Haiku" on a Claude turn whose same-model subagents wrote ≥40% of its
// output, when the setting is still the task's model and this turn ran that way.
export function offerSubagentModel(t, setting = '', agent = t?.agent) {
  return agent === 'claude' && !setting && !t?.run?.subagentModel && sameModelShare(t) >= SUBAGENT_OFFER_AT;
}
const SUBAGENT_NAMES = { haiku: 'Haiku', sonnet: 'Sonnet' };

// Its tooltip: every subagent type, the tokens per model, the page-reads note, and the subagent
// model the turn ran with.
export function subagentTip(t) {
  const st = t?.stats || {};
  const total = turnOutput(t);
  const subs = (st.subagents || []).map((x) => `${agentsWord(x)}${x.model ? ` on ${modelWords(x.model)}` : ''}: ${tokenWords(x.output)} of ${tokenWords(total)} output tokens, ${tokenWords(x.read)} read`);
  const models = (st.models || []).map((m) => `${modelWords(m.model)} ${tokenWords(m.output)} out / ${tokenWords(m.input + m.cacheRead + m.cacheWrite)} in`);
  const notes = [...new Set((st.subagents || []).map(insteadWords).filter(Boolean))];
  const on = SUBAGENT_NAMES[t?.run?.subagentModel];
  return [subs.length ? `Subagents: ${subs.join('; ')}` : '', models.length ? `By model: ${models.join(', ')}` : '', ...notes, on ? `Subagents on ${on} (Settings → Usage)` : ''].filter(Boolean).join('. ');
}
