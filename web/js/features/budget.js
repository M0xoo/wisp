// Plan budget in Settings → Usage: how much of each account's 5-hour and weekly windows is gone,
// as its CLI last reported it (server/budget.js, on the harness list as `budget`), when each window
// resets and, when that comes first, when it runs out at this pace. The server broadcasts 'agents'
// when a number moves, so the pane repaints with the harness list.
// With Automations stop at set, each bar marks that line and a window past it says automations
// wait; under each account, Where it went: the tasks that used most of its longest window.

import { esc } from '../md.js';
import { icon } from '../core/dom.js';
import { whenLabel } from '../core/format.js';
import { S } from '../core/state.js';
import { harnessLogo } from './runners.js';
import { holdLine } from '../limit-hold.js';

const REPORTS = new Set(['claude', 'codex']); // harnesses whose CLI says how much is gone
export const STOP_AT = ['off', '50', '75', '90']; // Automations stop at (server/budget.js STOP_AT)

// The share of a window where automations stop (0.75), or null when they never do.
export const stopAt = () => (STOP_AT.includes(S.config.defaults?.autoStop) && S.config.defaults.autoStop !== 'off' ? Number(S.config.defaults.autoStop) / 100 : null);

// "18%", and "<1%" for a share too small to round to one.
export const pct = (x) => (x > 0 && x < 0.005 ? '<1%' : `${Math.round(x * 100)}%`);

// One line under a window's bar. Each says something the others don't: no time twice.
function windowLine(w, stop) {
  if (!w.resetsAt) return 'New window';
  if (w.used >= 1) return `Used up · resets ${whenLabel(w.resetsAt)}`;
  if (stop && w.used >= stop) return `Automations wait · resets ${whenLabel(w.resetsAt)}`;
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

// agents: S.agents. '' when no harness here reports its windows (the pane hides the group).
export function budgetHtml(agents) {
  const stop = stopAt();
  const out = [];
  for (const a of agents) {
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
      out.push(`<div class="bg-acct" data-agent="${esc(a.id)}" data-acc="${esc(b.account)}">
        <b class="bg-name"><span class="model-logo">${harnessLogo(a.id)}</span>${esc(a.name)}${acc ? `<span class="bg-acc">${esc(acc.label)}</span>` : ''}</b>
        ${wins}
        ${whereHtml(b.where)}
      </div>`);
    }
  }
  if (out.length) return out.join('');
  // Nothing reported yet: say where the numbers will come from, once a run tells us.
  const can = agents.filter((a) => REPORTS.has(a.id) && a.available);
  return can.length ? `<p class="bg-empty">Shows each account’s 5-hour and weekly windows after its next ${can.map((a) => esc(a.name)).join(' or ')} run.</p>` : '';
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
