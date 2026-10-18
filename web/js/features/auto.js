// Auto: what the router (server/router.js) learned about which harness and model work for you.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { present } from '../ui/overlay.js';
import { toastError } from '../ui/toast.js';
import { AUTO_GOALS, harnessLogo } from './runners.js';

const ARM_STATE = { ready: ['Ready', 'ok'], new: ['Trying out', 'warn'], untried: ['No data yet', ''], gone: ['Not installed', 'bad'] };
export async function openRouter({ host } = {}) {
  const node = el(`<div class="modal router-modal">
      <header><h2>Auto</h2><button class="icon-btn close">${icon('x')}</button></header>
      <div class="ro-body"><div class="it-loading"><span class="orb tiny"></span>Loading…</div></div>
    </div>`);
  const close = present(node, host);
  const pctOf = (x) => `${Math.round(x * 100)}%`;
  const outcome = (r) => (r === null ? '<span class="dim">waiting</span>' : r >= 0.9 ? '<span class="ok">worked</span>' : r >= 0.5 ? '<span>finished</span>' : r >= 0.25 ? '<span class="warn">partly</span>' : '<span class="bad">didn’t work</span>');
  const render = async () => {
    const r = await api('/router').catch((err) => (toastError(err), null));
    if (!r || !node.isConnected) return;
    const arms = r.arms.filter((a) => a.state !== 'gone' || a.n);
    $('.ro-body', node).innerHTML = `
      <p class="hint">For each task Auto estimates every harness · model’s chance of doing it well, from wisp-bench (${esc(r.priors.version)}) and then more and more from your own tasks: merged PRs, 👍 / 👎, rollbacks, follow-ups and how the run ended. It picks the best value for your goal (<b>${esc(AUTO_GOALS.find((g) => g.id === r.goal)?.label || '')}</b>), now and then trying an alternative so the estimates stay honest.</p>
      <h4>Harness · model</h4>
      <table class="us-table ro-table"><thead><tr><th></th><th>Works</th><th>Your tasks</th><th>~Cost</th><th>~Time</th><th></th></tr></thead><tbody>${arms
        .map((a) => {
          const [state, tone] = ARM_STATE[a.state] || ARM_STATE.ready;
          const types = Object.entries(a.byType).map(([t, x]) => `${t} ${pctOf(x.chance)} (${x.n})`).join(' · ');
          return `<tr><td><span class="us-runner"><span class="model-logo">${harnessLogo(a.agent)}</span>${esc(a.label)}</span>${types ? `<small class="ro-types">${esc(types)}</small>` : ''}</td>${a.state === 'untried' ? '<td>—</td><td>—</td><td>—</td><td>—</td>' : `<td><b>${pctOf(a.chance)}</b></td><td>${a.n || '—'}</td><td>${a.usd ? `$${a.usd.toFixed(2)}` : '$0'}</td><td>${a.minutes}m</td>`}<td><span class="sx-state ${tone}"><i class="dot ${tone}"></i>${state}</span></td></tr>`;
        })
        .join('')}</tbody></table>
      <h4>Recent picks</h4>
      ${r.recent.length
        ? `<ul class="ro-recent">${r.recent
            .map((x) => {
              const s = S.sessions.get(x.id);
              return `<li><span class="model-logo">${harnessLogo(x.key.split(':')[0])}</span><span class="ro-title">${esc(s?.title || 'Task')}</span><small>${esc(x.label)} · ${esc(x.type)}${x.trying ? ' · trying' : x.explored ? ' · exploring' : ''}</small>${outcome(x.r)}</li>`;
            })
            .join('')}</ul>`
        : '<p class="mem-empty">Nothing yet. Launch with Auto and its picks show up here.</p>'}
      <div class="ro-foot"><button class="ghost sm danger" id="roReset">Forget what Auto learned</button><span class="hint">The wisp-bench starting point stays.</span></div>`;
    $('#roReset', node).onclick = async () => {
      if (!confirm('Forget what Auto learned from your tasks?')) return;
      await api('/router/reset', { method: 'POST', body: {} }).catch(toastError);
      render();
    };
  };
  bus.on('router', render, { node });
  render();
  return close;
}
