// Plan budget in Settings → Usage: how much of each account's 5-hour and weekly windows is gone,
// as its CLI last reported it (server/budget.js, on the harness list as `budget`), when each window
// resets and, when that comes first, when it runs out at this pace. The server broadcasts 'agents'
// when a number moves, so the pane repaints with the harness list.
// With Automations stop at set, each bar marks that line and a window past it says automations
// wait; under each account, Where it went: the tasks that used most of its longest window.
// A harness can have its own line (autoStopClaude, autoStopCodex), else it follows Automations stop at.
// Drain watch (defaults.drainWatch): a card on an account whose plan moves much faster than usual for
// the same work (server/budget.js drain()), with Copy report and Dismiss.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { icon } from '../core/dom.js';
import { fmtDate, SHORT_TIME, whenLabel } from '../core/format.js';
import { S } from '../core/state.js';
import { tryApi } from '../ui/toast.js';
import { noticeWords } from '../window-notice.js';
import { harnessLogo } from './runners.js';
import { holdLine } from '../limit-hold.js';
import { bankedSoon, bankedWords } from '../banked.js';
import { COMPARE_DAYS, COMPARE_MIN, compareParts, compareWords, insteadWords, modelWords, tokenWords } from '../receipt.js';

const REPORTS = new Set(['claude', 'codex']); // harnesses whose CLI says how much is gone
export const STOP_AT = ['off', '50', '75', '90']; // Automations stop at (server/budget.js STOP_AT)
export const STOP_KEYS = { claude: 'autoStopClaude', codex: 'autoStopCodex' }; // its own line (STOP_BY)
export const STOP_BY = ['same', ...STOP_AT];

// The share of a window where automations stop on this harness (0.75), or null when they never do.
export function stopAt(agent) {
  const d = S.config.defaults || {};
  const v = STOP_AT.includes(d[STOP_KEYS[agent]]) ? d[STOP_KEYS[agent]] : d.autoStop;
  return STOP_AT.includes(v) && v !== 'off' ? Number(v) / 100 : null;
}

// Window changes (web/js/window-notice.js): a reset in words is its weekday and time ("Sun 09:00"),
// the tooltip has the dates. Shown unless Settings → Usage → Window changes is off.
export const noticeWhen = (t) => fmtDate(t, { weekday: 'short', ...SHORT_TIME });
export const noticeTip = (n) =>
  [n.resetsAt && `Resets ${whenLabel(n.resetsAt)}`, n.wasResetsAt && `before, ${whenLabel(n.wasResetsAt)}`].filter(Boolean).join(', ') + `${n.resetsAt ? '. ' : ''}Seen ${whenLabel(n.at)}. wisp never switches accounts for you.`;
export const noticesOn = () => S.config.defaults?.windowNotice !== 'off';

// × on a window change, here or on home: gone at once from both, back with a toast if the server refuses.
export async function dismissNotice(agentId, account, window) {
  const b = S.agents.find((x) => x.id === agentId)?.budget?.find((x) => x.account === account);
  const i = b?.notices?.findIndex((x) => x.window === window) ?? -1;
  if (i < 0) return;
  const [was] = b.notices.splice(i, 1);
  bus.emit('agents');
  const ok = await tryApi(() => api(`/agents/${encodeURIComponent(agentId)}/windows/dismiss`, { method: 'POST', body: { account, window } }));
  if (!ok) {
    b.notices.splice(i, 0, was);
    bus.emit('agents');
  }
}

function noticesHtml(a, b, acc) {
  if (!noticesOn() || !b.notices?.length) return '';
  return b.notices
    .map((n) => {
      const x = { ...n, name: a.name, accountLabel: acc?.label || '' };
      return `<div class="bg-note" role="status"><span class="bg-nt" title="${esc(noticeTip(x))}">${esc(noticeWords(x, noticeWhen))}</span><button type="button" class="icon-btn bg-nx" data-wnote="${esc(n.window)}" title="Hide until this window changes again" aria-label="Hide until this window changes again">${icon('x')}</button></div>`;
    })
    .join('');
}

// Units of work as the CLI reports them: Claude Code's cost, else tokens (server/budget.js unitsOf).
const unitWords = (agent, u) => (agent === 'claude' ? `$${u.toFixed(2)}` : `${u >= 0.1 ? u.toFixed(1) : u.toFixed(2)}M tokens`);
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

// "18%", and "<1%" for a share too small to round to one.
export const pct = (x) => (x > 0 && x < 0.005 ? '<1%' : `${Math.round(x * 100)}%`);

// One line under a window's bar. Each says something the others don't: no time twice.
function windowLine(w, stop) {
  if (!w.resetsAt) return 'New window';
  if (w.used >= 1) return `Used up · resets ${whenLabel(w.resetsAt)}`;
  if (stop && w.used >= stop) return `Automations wait · resets ${whenLabel(w.resetsAt)}`;
  if (w.earlyAt) return `Reset early ${whenLabel(w.earlyAt)} · resets ${whenLabel(w.resetsAt)}`;
  if (w.hitAt) return `Resets ${whenLabel(w.resetsAt)} · at this pace, runs out ${whenLabel(w.hitAt)}`;
  return `Resets ${whenLabel(w.resetsAt)}`;
}

// Warn at the line you set to be asked at (Ask near the limit, else 90%) or at Automations stop at.
const tone = (w, stop) => (w.used >= 1 ? 'full' : w.hitAt || w.used >= (holdLine(S.config?.defaults?.limitHold) ?? 0.9) || (stop && w.used >= stop) ? 'warn' : '');

// Where the account's longest window went this period: its top tasks (each opens), the rest of the
// tasks wisp traced in one row, and what it couldn't trace to a task.
function whereHtml(w) {
  if (!w?.tasks?.length) return '';
  const label = w.label.charAt(0).toLowerCase() + w.label.slice(1);
  const rest = w.traced - w.tasks.reduce((t, x) => t + x.used, 0);
  const outside = Math.max(0, w.used - w.traced);
  const rows = w.tasks.map((t) => `<button type="button" class="bg-task" data-session="${esc(t.id)}" title="${esc(`Open “${t.title}”`)}"><span class="bg-tt">${esc(t.title)}</span><b class="bg-p">${pct(t.used)}</b></button>`);
  if (w.more && rest > 0) rows.push(`<div class="bg-task muted"><span class="bg-tt">${w.more} other task${w.more === 1 ? '' : 's'}</span><b class="bg-p">${pct(rest)}</b></div>`);
  if (outside >= 0.005) rows.push(`<div class="bg-task muted" title="Runs of the CLI outside wisp, other apps on the same plan, and anything from before wisp kept track"><span class="bg-tt">Outside wisp or earlier</span><b class="bg-p">${pct(outside)}</b></div>`);
  return `<div class="bg-where"><small class="bg-wh">Where the ${esc(label)} window went</small>${rows.join('')}</div>`;
}

// Beside it, what of that window went to subagents (server/budget.js whereSubagents), by type: "3
// web-fetch agents · Opus 5.5 · 27k out" and its share; and, when Claude Code ran page reads as an
// agent because the account had no WebFetch (CC#106743), that in words.
function subagentsHtml(w) {
  if (!w?.subagents?.length) return '';
  const rows = w.subagents.map((x) => {
    const words = [`${x.calls} ${x.type} agent${x.calls === 1 ? '' : 's'}`, x.model ? modelWords(x.model) : '', x.output ? `${tokenWords(x.output)} out` : ''].filter(Boolean).join(' · ');
    return `<div class="bg-task" title="${esc(words)}"><span class="bg-tt">${esc(words)}</span><b class="bg-p">${pct(x.used)}</b></div>`;
  });
  const notes = [...new Set(w.subagents.map(insteadWords).filter(Boolean))].map((t) => `<div class="bg-task muted bg-inst"><span class="bg-tt">${esc(t)}</span></div>`);
  return `<div class="bg-sub"><small class="bg-wh">Where it went: subagents</small>${rows.join('')}${notes.join('')}</div>`;
}

// Drain watch's card on an account: how much faster, since when, and what that much work usually takes.
function drainHtml(a, b) {
  const d = b.drain;
  if (!d || S.config.defaults?.drainWatch !== 'on') return '';
  const failed = d.failed?.runs ? ` ${d.failed.runs} of them ended in an error and still took ${pct(d.failed.du)}.` : '';
  return `<div class="bg-drain" role="status">
    <span class="bg-di">${icon('warn')}</span>
    <div class="bg-dt">
      <b>Using your plan ${d.ratio.toFixed(1)}× faster than usual</b>
      <small>Since ${esc(whenLabel(d.since))}, ${d.runs} runs took ${pct(d.du)} of the ${esc(lower(d.label))} window for ${esc(unitWords(a.id, d.units))} of work. That much work usually takes ${pct(d.usual * d.units)}.${failed}</small>
      <span class="bg-da"><button type="button" class="ghost sm" data-drain="copy" data-window="${esc(d.id)}">${icon('copy')}Copy report</button><button type="button" class="ghost sm" data-drain="dismiss" data-window="${esc(d.id)}">Dismiss</button></span>
    </div>
  </div>`;
}

// What Copy report puts on the clipboard: the numbers in words, for a support ticket.
export function drainReport(a, b, acc) {
  const d = b.drain;
  const w = b.windows.find((x) => x.id === d.id);
  return [
    `Plan usage report (from wisp, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC)`,
    `Harness: ${a.name}${acc ? ` (${acc.label})` : ''}`,
    `Window: ${d.label}${w ? `, now at ${pct(w.used)}${w.resetsAt ? `, resets ${new Date(w.resetsAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}` : ''}`,
    `Since ${new Date(d.since).toISOString().slice(0, 16).replace('T', ' ')} UTC: ${d.runs} runs, ${unitWords(a.id, d.units)} of work${a.id === 'claude' ? ' (the cost Claude Code reports)' : ''}, took ${pct(d.du)} of the window.`,
    `Over the 14 days before, the same amount of work took ${pct(d.usual * d.units)}: these runs used the window ${d.ratio.toFixed(1)}× faster per unit of work.`,
    ...(d.failed?.runs ? [`${d.failed.runs} of these runs ended in an error and still took ${pct(d.failed.du)}.`] : []),
    'Measured from the usage percentages the CLI reports on each run (whole percents). Use of the same plan outside wisp in that time counts too.',
  ].join('\n');
}

// Past your plan: the account's runs billed beyond its plan this week (server/budget.js overage()),
// and the last one's task, which opens.
const OVER_WORDS = { extra: 'billed as extra usage', credits: 'billed to Codex credits', api: 'billed to an API key, not the plan', profile: 'billed to a Console sign-in, not the plan' };
function overHtml(b) {
  const o = b.overage;
  if (!o?.runs) return '';
  const task = o.sid && S.sessions?.get?.(o.sid);
  return `<div class="bg-over" role="status">
    <span class="bg-di">${icon('warn')}</span>
    <span class="bg-nt"><b>Past your plan:</b> ${o.runs} run${o.runs === 1 ? '' : 's'} in the last 7 days ${esc(OVER_WORDS[o.kind] || OVER_WORDS.extra)} (last: ${esc(whenLabel(o.at))}).</span>
    ${task ? `<button type="button" class="ghost sm bg-ol" data-session="${esc(o.sid)}" title="${esc(`Open “${task.title || 'Untitled'}”`)}">Open it</button>` : ''}
  </div>`;
}

// Banked resets (Codex's reset credits, from a read): words only, wisp never redeems one.
function bankedHtml(b) {
  const words = bankedWords(b.banked);
  if (!words) return '';
  const tip = `Reset credits on this plan, as Codex last said${b.banked.at ? ` (${whenLabel(b.banked.at)})` : ''}. wisp never redeems one: that’s yours to do in Codex`;
  return `<div class="bg-bank${bankedSoon(b.banked) ? ' warn' : ''}" title="${esc(tip)}">${icon('rotate')}<span>${esc(words)}</span></div>`;
}

// Tokens per turn by account (server/budget.js compareAccounts): one row per model this harness ran
// on two or more accounts this week, each account's median turn, and Copy report for a bug report to
// the vendor. Numbers only: it never suggests an account, and wisp never switches.
export const accountLabel = (a, id) => a.accounts?.find((x) => x.id === id)?.label || (id === 'default' ? 'Default account' : id);
export const modelLabel = (a, id) => (id && a.models?.find((m) => m.id === id)?.label) || id || 'Default model';
// The full list behind "Personal has no WebFetch, … and 4 more" (the words stop at three).
const missingTip = (c, label) => {
  const t = c.accounts.filter((x) => x.missing?.length).map((x) => `${label(x.account)} had no ${x.missing.join(', ')} on its latest turn`).join('. ');
  return t ? ` title="${esc(t)}"` : '';
};
function compareHtml(a) {
  if (!a.compare?.length) return '';
  const label = (id) => accountLabel(a, id);
  const rows = a.compare
    .map(
      (c) => `<div class="bg-cr" data-model="${esc(c.model)}">
        <span class="bg-cm">${esc(modelLabel(a, c.model))}</span>
        <span class="bg-cw"${missingTip(c, label)}>${esc(compareWords(c, label))}</span>
        ${c.accounts.map((x) => `<span class="bg-ca"><span class="bg-acc">${esc(label(x.account))}</span><span class="bg-cn">${compareParts(x).map(esc).join('<span class="tb-dot" aria-hidden="true">·</span>')}</span></span>`).join('')}
      </div>`,
    )
    .join('');
  return `<div class="bg-cmp" data-agent="${esc(a.id)}">
    <b class="bg-name"><span class="model-logo">${harnessLogo(a.id)}</span>${esc(a.name)}<span class="bg-ch">tokens per turn by account</span></b>
    <small class="bg-wh" title="${esc(`Median finished turn per account over the last ${COMPARE_DAYS} days, shown once each account has ${COMPARE_MIN} turns on that model. Input counts cache reads and writes. From what the CLI reports on each turn.`)}">Median turn, last ${COMPARE_DAYS} days</small>
    ${rows}
    <span class="bg-da"><button type="button" class="ghost sm" data-cmp="copy">${icon('copy')}Copy report</button></span>
  </div>`;
}

// What Copy report puts on the clipboard: both accounts' numbers side by side, for the vendor.
export function compareReport(a) {
  const label = (id) => accountLabel(a, id);
  const lines = [`Tokens per turn by account (from wisp, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC)`, `Harness: ${a.name}${a.version ? ` ${a.version}` : ''}`];
  for (const c of a.compare || []) {
    lines.push('', `Model: ${modelLabel(a, c.model)}${c.model ? ` (${c.model})` : ''}`);
    for (const x of c.accounts) lines.push(`- ${label(x.account)}: ${x.turns} turns, median ${x.output.toLocaleString('en-US')} output / ${x.input.toLocaleString('en-US')} input tokens per turn${x.cache != null ? `, ${Math.round(x.cache * 100)}% of input from the cache` : ''}${x.missing?.length ? `; without ${x.missing.join(', ')}` : ''}`);
    lines.push(compareWords(c, label) + '.');
  }
  lines.push('', `Median of each finished turn over the last ${COMPARE_DAYS} days, as the CLI reported it. Input counts cache reads and writes. Same machine, same wisp; only the signed-in account differs.`);
  return lines.join('\n');
}

// agents: S.agents. '' when no harness here reports its windows (the pane hides the group).
export function budgetHtml(agents) {
  const out = [];
  for (const a of agents) {
    const stop = stopAt(a.id);
    const many = a.accounts?.length > 1;
    for (const b of a.budget || []) {
      const acc = many ? a.accounts.find((x) => x.id === b.account) : null;
      if (many ? !acc : b.account !== 'default') continue; // an account since removed
      const wins = b.windows
        .map((w) => {
          const p = Math.round(w.used * 100);
          return `<div class="bg-win ${tone(w, stop)}">
            <span class="bg-l">${esc(w.label)}</span>
            <span class="bg-bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}" aria-label="${esc(`${w.label} window used`)}"><i style="--p:${p}%"></i></span>
            <b class="bg-p">${p}%</b>
            <small class="bg-t">${esc(windowLine(w, stop))}</small>
          </div>`;
        })
        .join('');
      out.push(`<div class="bg-acct${stop ? ' stops' : ''}" data-agent="${esc(a.id)}" data-acc="${esc(b.account)}"${stop ? ` style="--stop:${stop * 100}%"` : ''}>
        <b class="bg-name"><span class="model-logo">${harnessLogo(a.id)}</span>${esc(a.name)}${acc ? `<span class="bg-acc">${esc(acc.label)}</span>` : ''}</b>
        ${wins}
        ${bankedHtml(b)}
        ${overHtml(b)}
        ${noticesHtml(a, b, acc)}
        ${drainHtml(a, b)}
        ${whereHtml(b.where)}
        ${subagentsHtml(b.where)}
      </div>`);
    }
    out.push(compareHtml(a));
  }
  if (out.some(Boolean)) return out.join('');
  // Nothing reported yet: say where the numbers will come from, once a run tells us.
  const can = agents.filter((a) => REPORTS.has(a.id) && a.available);
  return can.length ? `<p class="bg-empty">Shows each account’s usage windows after its next ${can.map((a) => esc(a.name)).join(' or ')} run.</p>` : '';
}

// A window by its id, in words for a sentence: "weekly", "5-hour", "30-day".
const WIN_WORDS = { five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'weekly Opus', seven_day_sonnet: 'weekly Sonnet' };
function windowWords(id) {
  if (WIN_WORDS[id]) return WIN_WORDS[id];
  const m = /^w(\d+)m$/.exec(id);
  const mins = m ? Number(m[1]) : 0;
  return !mins ? 'usage' : mins >= 1440 ? `${Math.round(mins / 1440)}-day` : `${Math.round(mins / 60)}-hour`;
}
const RANK = ['seven_day', 'seven_day_opus', 'seven_day_sonnet', 'five_hour'];

// The task's share of its plan, for its details: "4% of weekly · 18% of 5-hour", longest first.
// '' when wisp traced none of it (a harness that doesn't report, or nothing measured yet).
export function planLine(s) {
  const p = s.plan && Object.entries(s.plan).filter(([, x]) => x > 0);
  if (!p?.length) return '';
  const rank = (id) => (RANK.includes(id) ? RANK.indexOf(id) : -1); // unknown lengths (30-day) lead
  const text = p
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([id, x]) => `${pct(x)} of ${windowWords(id)}`)
    .join(' · ');
  return `<span class="plan-used" title="${esc('How much of its plan’s usage windows this task used, as wisp traced it from what the CLI reports. Settings → Usage shows where the rest went')}">${icon('stats')}<span>${esc(text)}</span></span>`;
}
