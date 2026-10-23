// Compare: one task, several harnesses, side by side.

import { countChanges, fmtDuration, renderPresentation } from '../blocks.js';
import { esc } from '../md.js';
import { mentionHtml } from '../mention-text.js';
import { api } from '../core/api.js';
import { $, el, icon } from '../core/dom.js';
import { STATUS_LABEL } from '../core/format.js';
import { S } from '../core/state.js';
import { overlay } from '../ui/overlay.js';
import { toast, toastError } from '../ui/toast.js';
import { renderFeed, reveal } from './feed.js';
import { loadSessions } from './live.js';
import { agentName, effortLabel, harnessLogo } from './runners.js';
import { ctxFor } from './turns.js';
import { ask } from '../ui/confirm.js';

function turnMetrics(t) {
  const lines = (t?.changes || []).reduce((acc, c) => {
    const n = countChanges(c.edits);
    return { add: acc.add + n.add, del: acc.del + n.del };
  }, { add: 0, del: 0 });
  const tests = (t?.presentation?.blocks || []).filter((b) => b?.type === 'tests');
  return {
    time: t?.endedAt ? t.endedAt - t.startedAt : null,
    cost: t?.stats?.costUsd,
    files: t?.changes?.length || 0,
    ...lines,
    tests: tests.length ? { passed: tests.reduce((a, b) => a + (Number(b.passed) || 0), 0), failed: tests.reduce((a, b) => a + (Number(b.failed) || 0), 0) } : null,
    asks: (t?.activity || []).filter((a) => a.kind === 'ask').length,
  };
}

export async function compareView(id) {
  const s0 = S.sessions.get(id);
  if (!s0?.groupId) return;
  const group = [...S.sessions.values()].filter((x) => x.groupId === s0.groupId).sort((a, b) => a.createdAt - b.createdAt);
  const fulls = (await Promise.all(group.map((g) => api(`/sessions/${g.id}`).catch(() => null)))).filter(Boolean);
  const node = el(`
    <div class="modal compare-modal">
      <header><h2>Compare</h2><button class="icon-btn close">${icon('x')}</button></header>
      <p class="cmp-prompt">${mentionHtml(esc(fulls[0]?.turns[0]?.prompt || ''))}</p>
      <div class="cmp-grid" style="--n:${fulls.length}"></div>
    </div>`);
  const close = overlay(node);
  $('.close', node).onclick = close;
  const grid = $('.cmp-grid', node);
  for (const f of fulls) {
    const sum = S.sessions.get(f.id) || {};
    const t = f.turns.at(-1);
    const mx = turnMetrics(t);
    const live = f.state === 'running' || f.state === 'waiting';
    const col = el(`
      <section class="cmp-col" data-id="${f.id}">
        <div class="cmp-head">
          <span class="rb-logo">${harnessLogo(f.agent)}</span>
          <span class="cmp-who"><b>${esc(agentName(f.agent))}</b><small>${esc(f.model || 'Default model')}${f.effort ? ` · ${esc(effortLabel(f.effort))}` : ''}</small></span>
          ${live ? `<span class="pill st-waiting"><i></i>${f.state === 'waiting' ? 'Asking' : 'Working'}</span>` : `<span class="pill st-${sum.status || 'info'}"><i></i>${STATUS_LABEL[sum.status] || STATUS_LABEL.done}</span>`}
        </div>
        <dl class="cmp-stats">
          <div><dt>Time</dt><dd>${mx.time !== null ? fmtDuration(mx.time) : '—'}</dd></div>
          <div><dt>Cost</dt><dd>${typeof mx.cost === 'number' ? `$${mx.cost.toFixed(2)}` : '—'}</dd></div>
          <div><dt>Files</dt><dd>${mx.files} <span class="plus">+${mx.add}</span> <span class="minus">−${mx.del}</span></dd></div>
          <div><dt>Tests</dt><dd>${mx.tests ? `<span class="${mx.tests.failed ? 'minus' : 'plus'}">${mx.tests.passed} ✓ ${mx.tests.failed ? `${mx.tests.failed} ✗` : ''}</span>` : '—'}</dd></div>
          <div><dt>Asked</dt><dd>${mx.asks}</dd></div>
        </dl>
        <div class="cmp-body"></div>
        <div class="cmp-foot">
          <button class="ghost xs" data-a="open">${icon('chevron')}Open card</button>
          <span class="grow"></span>
          <button class="primary sm" data-a="keep" ${live ? 'disabled title="Still working"' : ''}>${icon('check')}Keep this</button>
        </div>
      </section>`);
    $('.cmp-body', col).append(live ? el(`<p class="muted xs">${esc(sum.live || 'Working…')}</p>`) : renderPresentation(t?.presentation, ctxFor(f, t, false)));
    grid.append(col);
  }
  grid.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    const keep = e.target.closest('.cmp-col')?.dataset.id;
    if (!a || !keep) return;
    if (a === 'open') return close(), reveal(keep);
    const others = group.filter((g) => g.id !== keep);
    if (!(await ask(`Keep ${agentName(S.sessions.get(keep)?.agent)}'s result?\n\nThe other ${others.length === 1 ? 'run is' : `${others.length} runs are`} archived, and ${others.length === 1 ? 'its worktree is' : 'their worktrees are'} deleted with their changes.`, { ok: 'Keep this one', danger: true, anchor: e.target.closest('[data-a]') }))) return;
    // Optimistic: the others leave the feed now; stopping and cleaning them up goes on behind.
    for (const o of others) S.sessions.set(o.id, { ...S.sessions.get(o.id), archived: true });
    close();
    renderFeed();
    reveal(keep);
    toast(`Kept ${esc(agentName(S.sessions.get(keep)?.agent))}'s run. Ship it when you're ready.`);
    let failed = false;
    for (const o of others) {
      if (o.state === 'running' || o.state === 'waiting') {
        await api(`/sessions/${o.id}/stop`, { method: 'POST', body: {} }).catch(() => {});
        await until(() => S.sessions.get(o.id)?.state !== 'running', 5000);
      }
      await api(`/sessions/${o.id}`, { method: 'PATCH', body: { archived: true, discardWorktree: true } }).catch((err) => ((failed = true), toastError(err)));
    }
    if (failed) loadSessions(); // show what really got archived
  };
}

// Poll a condition for up to `ms` (used after asking the server to stop something).
async function until(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end && !fn()) await new Promise((r) => setTimeout(r, 150));
}
