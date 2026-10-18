// Usage: spend and outcomes.

import { fmtDuration } from '../blocks.js';
import { esc } from '../md.js';
import { api } from '../core/api.js';
import { $, $$, el, icon } from '../core/dom.js';
import { money, pct } from '../core/format.js';
import { present } from '../ui/overlay.js';
import { toastError } from '../ui/toast.js';
import { agentName, harnessLogo } from './runners.js';

export async function openUsage({ days = 30, host } = {}) {
  const node = el(`<div class="modal usage-modal">
      <header><h2>Usage</h2><div class="mem-tabs us-range">${[7, 30, 90].map((d) => `<button data-days="${d}">${d} days</button>`).join('')}</div><button class="icon-btn close">${icon('x')}</button></header>
      <div class="us-body"><div class="it-loading"><span class="orb tiny"></span>Adding it up…</div></div>
    </div>`);
  const close = present(node, host);
  const render = async () => {
    $$('.us-range button', node).forEach((b) => b.classList.toggle('on', Number(b.dataset.days) === days));
    const u = await api(`/usage?days=${days}`).catch((err) => (toastError(err), null));
    if (!u || !node.isConnected) return;
    const t = u.total;
    const unpriced = t.turns - t.priced;
    // Cost when any harness reports it, else turns: one measure per chart, never two axes.
    const byCost = t.priced > 0;
    const val = (d) => (byCost ? d.cost : d.turns);
    const max = Math.max(...u.daily.map(val), 0) || 1;
    const fmtDay = (k) => new Date(`${k}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
    const table = (rows, label) =>
      rows.length
        ? `<table class="us-table"><thead><tr><th></th><th>Spend</th><th>Turns</th><th>Worked</th><th>Asked</th><th>Avg time</th></tr></thead><tbody>${rows
            .map((r) => `<tr><td>${label(r)}</td><td>${r.priced ? money(r.cost) : '—'}</td><td>${r.turns}</td><td>${pct(r.successRate)}</td><td>${r.questions}</td><td>${fmtDuration(r.avgMs)}</td></tr>`)
            .join('')}</tbody></table>`
        : '<p class="mem-empty">Nothing in this range.</p>';
    $('.us-body', node).innerHTML = `
      <div class="us-tiles">
        <div><span>Spend</span><b>${byCost ? money(t.cost) : '—'}</b><small>${unpriced ? `${unpriced} turn${unpriced > 1 ? 's' : ''} without a price` : 'all turns priced'}</small></div>
        <div><span>Turns</span><b>${t.turns}</b><small>in ${t.sessions} session${t.sessions === 1 ? '' : 's'}</small></div>
        <div><span>Worked</span><b>${pct(t.successRate)}</b><small>finished, not partial or blocked</small></div>
        <div><span>Questions</span><b>${t.questions}</b><small>times an agent needed you</small></div>
      </div>
      <h4>${byCost ? 'Spend per day' : 'Turns per day'}</h4>
      <div class="us-chart" role="img" aria-label="${byCost ? 'Spend' : 'Turns'} per day">${u.daily
        .map((d) => `<div class="us-bar" data-tip="${esc(fmtDay(d.date))}: ${byCost ? money(d.cost) : ''}${byCost ? ' · ' : ''}${d.turns} turn${d.turns === 1 ? '' : 's'}"><i style="height:${val(d) ? Math.max(2, (val(d) / max) * 100) : 0}%"></i></div>`)
        .join('')}</div>
      <div class="us-axis"><span>${esc(fmtDay(u.daily[0].date))}</span><span>${byCost ? `max ${money(max)}/day` : `max ${max}/day`}</span><span>today</span></div>
      <h4>By project</h4>${table(u.projects, (r) => `<span class="us-proj c-${esc(r.color)}"><i class="p-dot"></i>${esc(r.name)}</span>`)}
      <h4>By harness · model</h4>${table(u.runners, (r) => `<span class="us-runner"><span class="model-logo">${harnessLogo(r.agent)}</span>${esc(agentName(r.agent))} · ${esc(r.model || 'default')}</span>`)}
      ${unpriced ? '<p class="hint">Codex, Cursor and Antigravity report tokens but not cost, so their turns count in turns and outcomes but not in spend.</p>' : ''}`;
  };
  // One floating tooltip for the bars (they are too thin to label).
  const tip = el('<div class="us-tip" hidden></div>');
  node.append(tip);
  node.addEventListener('mousemove', (e) => {
    const b = e.target.closest('.us-bar');
    tip.hidden = !b;
    if (!b) return;
    tip.textContent = b.dataset.tip;
    const r = b.getBoundingClientRect();
    const m = node.getBoundingClientRect();
    tip.style.left = `${Math.min(r.left - m.left + r.width / 2, m.width - 90)}px`;
    tip.style.top = `${r.top - m.top + node.scrollTop - 6}px`;
  });
  node.addEventListener('mouseleave', () => (tip.hidden = true));
  $('.us-range', node).onclick = (e) => {
    const d = Number(e.target.closest('[data-days]')?.dataset.days);
    if (d) (days = d), render();
  };
  render();
}

function usageSummary(u) {
  if (!u) return '';
  return u.total.turns ? `${u.total.priced ? `${money(u.total.cost)} · ` : ''}${u.total.turns} turns · ${pct(u.total.successRate)} worked, last 7 days` : 'Nothing in the last 7 days';
}
