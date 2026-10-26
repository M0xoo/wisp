// Plan budget in Settings → Usage: how much of each account's 5-hour and weekly windows is gone,
// as its CLI last reported it (server/budget.js, on the harness list as `budget`), when each window
// resets and, when that comes first, when it runs out at this pace. The server broadcasts 'agents'
// when a number moves, so the pane repaints with the harness list.

import { esc } from '../md.js';
import { whenLabel } from '../core/format.js';
import { harnessLogo } from './runners.js';

const REPORTS = new Set(['claude', 'codex']); // harnesses whose CLI says how much is gone

// One line under a window's bar. Each says something the others don't: no time twice.
function windowLine(w) {
  if (!w.resetsAt) return 'New window';
  if (w.used >= 1) return `Used up · resets ${whenLabel(w.resetsAt)}`;
  if (w.hitAt) return `Resets ${whenLabel(w.resetsAt)} · at this pace, runs out ${whenLabel(w.hitAt)}`;
  return `Resets ${whenLabel(w.resetsAt)}`;
}

const tone = (w) => (w.used >= 1 ? 'full' : w.hitAt || w.used >= 0.9 ? 'warn' : '');

// agents: S.agents. '' when no harness here reports its windows (the pane hides the group).
export function budgetHtml(agents) {
  const out = [];
  for (const a of agents) {
    const many = a.accounts?.length > 1;
    for (const b of a.budget || []) {
      const acc = many ? a.accounts.find((x) => x.id === b.account) : null;
      if (many ? !acc : b.account !== 'default') continue; // an account since removed
      const wins = b.windows
        .map((w) => {
          const p = Math.round(w.used * 100);
          return `<div class="bg-win ${tone(w)}">
            <span class="bg-l">${esc(w.label)}</span>
            <span class="bg-bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}" aria-label="${esc(`${w.label} window used`)}"><i style="--p:${p}%"></i></span>
            <b class="bg-p">${p}%</b>
            <small class="bg-t">${esc(windowLine(w))}</small>
          </div>`;
        })
        .join('');
      out.push(`<div class="bg-acct" data-agent="${esc(a.id)}" data-acc="${esc(b.account)}">
        <b class="bg-name"><span class="model-logo">${harnessLogo(a.id)}</span>${esc(a.name)}${acc ? `<span class="bg-acc">${esc(acc.label)}</span>` : ''}</b>
        ${wins}
      </div>`);
    }
  }
  if (out.length) return out.join('');
  // Nothing reported yet: say where the numbers will come from, once a run tells us.
  const can = agents.filter((a) => REPORTS.has(a.id) && a.available);
  return can.length ? `<p class="bg-empty">Shows each account’s 5-hour and weekly windows after its next ${can.map((a) => esc(a.name)).join(' or ')} run.</p>` : '';
}
