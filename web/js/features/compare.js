// Compare: one task, several harnesses, side by side.

import { renderPresentation } from '../blocks.js';
import { compareRows, compareSentence, differsWords, planShares } from '../compare-metrics.js';
import { esc } from '../md.js';
import { mentionHtml } from '../mention-text.js';
import { api } from '../core/api.js';
import { on } from '../core/bus.js';
import { $, $$, el, icon } from '../core/dom.js';
import { STATUS_LABEL, statusKey } from '../core/format.js';
import { S } from '../core/state.js';
import { overlay } from '../ui/overlay.js';
import { toast, toastError } from '../ui/toast.js';
import { renderFeed, reveal } from './feed.js';
import { loadSessions } from './live.js';
import { accountOf, agentById, agentName, effortLabel, harnessLogo, runVariant } from './runners.js';
import { ctxFor } from './turns.js';
import { ask } from '../ui/confirm.js';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const REFETCH_MS = 250; // a burst of summaries is one fetch
const isLive = (x) => x?.state === 'running' || x?.state === 'waiting';
const fetchRun = (id) => api(`/sessions/${id}?lean=1`); // the plain URL sends every edit's whole file for nothing

// A summary changing any of this means the numbers moved. A share lands with a later report, so
// plan is the signal for those; a run's live line isn't in it and fetches nothing.
const metricsKey = (x) => JSON.stringify([x?.state, x?.status, x?.turnCount, x?.plan || null]);

function pillOf(f, sum) {
  return isLive(f) ? { cls: 'pill st-waiting', text: f.state === 'waiting' ? 'Asking' : 'Working' } : { cls: `pill st-${statusKey(sum)}`, text: STATUS_LABEL[statusKey(sum)] || STATUS_LABEL.done };
}

const modelName = (f, id) => (id && agentById(f.agent)?.models?.find((m) => m.id === id)?.label) || id;

// Try it two ways: what differed, against run A.
function trialLine(fulls) {
  const trial = fulls.find((f) => f.trial)?.trial;
  if (!trial) return '';
  const a = fulls[0];
  const names = { agent: agentName, model: (id) => modelName(a, id), account: (id) => accountOf(a.agent, id)?.label || id || 'Default', ...(a.model && { taskModel: modelName(a, a.model) }) };
  return `<p class="cmp-diff${trial.differs?.length ? '' : ' same'}">${esc(differsWords(trial.differs, names))}</p>`;
}

export async function compareView(id) {
  const s0 = S.sessions.get(id);
  if (!s0?.groupId) return;
  const group = [...S.sessions.values()].filter((x) => x.groupId === s0.groupId).sort((a, b) => a.createdAt - b.createdAt);
  // Read before fetching: a summary that lands during the fetch shows as a change once it's open.
  const keys = new Map(group.map((g) => [g.id, metricsKey(g)]));
  const fulls = (await Promise.all(group.map((g) => fetchRun(g.id).catch(() => null)))).filter(Boolean).sort((a, b) => a.createdAt - b.createdAt);
  const runs = fulls.map((f, i) => ({ id: f.id, full: f, letter: LETTERS[i] || '', key: keys.get(f.id), shown: null, seq: 0, timer: null }));
  const n = fulls.length;
  const prompt = fulls[0]?.turns[0]?.prompt || '';
  const node = el(`
    <div class="modal compare-modal" data-n="${Math.min(n, 4)}" style="--n:${n}">
      <header><h2>Compare</h2><button class="icon-btn close" title="Close" aria-label="Close">${icon('x')}</button></header>
      <p class="cmp-prompt"${prompt.length > 240 ? ' tabindex="0"' : ''}>${mentionHtml(esc(prompt))}</p>
      ${trialLine(fulls)}
      <div class="cmp-scroll"${n > 3 ? ' tabindex="0" role="region" aria-label="Each run\'s numbers"' : ''}>
      <table class="cmp-table">
        <thead><tr><td></td>${runs.map((r) => `<th scope="col"><span class="cmp-run"><b class="cmp-letter">${r.letter}</b><span title="${esc(agentName(r.full.agent))}">${esc(agentName(r.full.agent))}</span></span></th>`).join('')}</tr></thead>
        <tbody>${compareRows(fulls)
          .map((row) => `<tr><th scope="row"${row.tip ? ` title="${esc(row.tip)}"` : ''}>${esc(row.label)}</th>${runs.map((r) => `<td data-row="${row.key}" data-run="${r.id}"></td>`).join('')}</tr>`)
          .join('')}</tbody>
      </table>
      </div>
      <p class="cmp-note"><span class="cmp-total"></span> <span class="cmp-sentence"></span></p>
      <div class="cmp-grid"></div>
    </div>`);
  let closed = false;
  const close = overlay(node, {
    onClose: () => {
      closed = true;
      for (const r of runs) clearTimeout(r.timer);
    },
  });
  $('.close', node).onclick = close;
  const grid = $('.cmp-grid', node);
  for (const r of runs) {
    const f = r.full;
    const base = [modelName(f, f.model) || 'Default model', f.effort && effortLabel(f.effort)].filter(Boolean).join(' · ');
    const variant = runVariant(f).join(' · ');
    const who = esc(variant ? `${base} · ${variant}` : base);
    r.col = el(`
      <section class="cmp-col" data-id="${f.id}">
        <div class="cmp-head">
          <b class="cmp-letter">${r.letter}</b>
          <span class="rb-logo">${harnessLogo(f.agent)}</span>
          <span class="cmp-who"><b>${esc(agentName(f.agent))}</b><small title="${who}"><span class="cmp-base">${esc(base)}</span>${variant ? `<span> · ${esc(variant)}</span>` : ''}</small></span>
          <span class="pill"><i></i> </span>
        </div>
        <div class="cmp-body"><p class="muted xs cmp-live"></p></div>
        <div class="cmp-foot">
          <button class="ghost xs" data-a="open">${icon('chevron')}Open card</button>
          <span class="grow"></span>
          <button class="primary sm" data-a="keep">${icon('check')}Keep this</button>
        </div>
      </section>`);
    grid.append(r.col);
  }
  const cells = new Map($$('td[data-row]', node).map((td) => [`${td.dataset.row} ${td.dataset.run}`, td]));
  const shown = new Map(); // td → the html it holds (reading innerHTML back gives the browser's spelling)

  // A run's head and live line, from its summary or the last fetch when it has none (a task removed).
  const paintRun = (r) => {
    const sum = S.sessions.get(r.id) || {};
    const f = sum.state ? { ...r.full, state: sum.state } : r.full;
    const live = isLive(f);
    const pill = $('.pill', r.col);
    const { cls, text } = pillOf(f, sum);
    if (pill.className !== cls) pill.className = cls;
    if (pill.lastChild.nodeValue !== text) pill.lastChild.nodeValue = text;
    const keep = $('[data-a="keep"]', r.col);
    if (keep.disabled !== live) keep.disabled = live;
    const title = live ? 'Still working' : '';
    if (keep.title !== title) keep.title = title;
    if (r.shown !== null) return;
    const line = $('.cmp-live', r.col);
    const words = sum.live || 'Working…';
    if (line && line.textContent !== words) line.textContent = words;
  };

  // The report goes in once per finished turn: a body the reader is scrolling isn't rebuilt. Waits
  // for the fetch, not the summary: only the fetch has the report.
  const paintBody = (r) => {
    const f = r.full;
    const t = f.turns.at(-1);
    if (isLive(f) || t?.status === 'running' || r.shown === (t?.id ?? '')) return;
    r.shown = t?.id ?? '';
    $('.cmp-body', r.col).replaceChildren(renderPresentation(t?.presentation, ctxFor(f, t, false)));
  };

  const paint = () => {
    const list = runs.map((r) => r.full);
    for (const row of compareRows(list)) {
      row.cells.forEach((c, i) => {
        const td = cells.get(`${row.key} ${runs[i].id}`);
        if (shown.get(td) !== c.html) {
          shown.set(td, c.html);
          td.innerHTML = c.html;
        }
        if (td.title !== (c.tip || '')) td.title = c.tip || '';
      });
    }
    const set = (sel, text) => {
      const n = $(sel, node);
      if (n.textContent !== text) n.textContent = text;
    };
    set('.cmp-total', planShares(list).total);
    set('.cmp-sentence', compareSentence(list));
    for (const r of runs) {
      paintRun(r);
      paintBody(r);
    }
  };

  const refetch = async (r) => {
    r.timer = null;
    if (closed || !node.isConnected) return;
    const seq = ++r.seq;
    const f = await fetchRun(r.id).catch(() => null); // a failed fetch keeps the last numbers
    if (seq !== r.seq || !f || closed || !node.isConnected) return;
    r.full = f;
    paint();
  };
  const onSummary = (sid) => {
    const r = runs.find((x) => x.id === sid);
    const sum = S.sessions.get(sid);
    if (!r || !sum || closed) return;
    paintRun(r);
    const key = metricsKey(sum);
    if (key === r.key) return;
    r.key = key;
    r.timer ??= setTimeout(() => refetch(r), REFETCH_MS);
  };
  paint();
  on('summary', onSummary, { node });
  for (const r of runs) onSummary(r.id);
  grid.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    const keep = e.target.closest('.cmp-col')?.dataset.id;
    if (!a || !keep) return;
    if (a === 'open') return close(), reveal(keep);
    const others = group.filter((g) => g.id !== keep);
    // Both runs of a Try it two ways are on one harness: only the letter tells them apart.
    const run = runs.find((r) => r.id === keep);
    const trial = run?.full.trial && `run ${run.letter}`;
    if (!(await ask(`Keep ${trial || `${agentName(S.sessions.get(keep)?.agent)}'s result`}?\n\nThe other ${others.length === 1 ? 'run is' : `${others.length} runs are`} archived, and ${others.length === 1 ? 'its worktree is deleted with its changes' : 'their worktrees are deleted with their changes'}.`, { ok: 'Keep this one', danger: true, anchor: e.target.closest('[data-a]') }))) return;
    // Optimistic: the others leave the feed now; stopping and cleaning them up goes on behind.
    for (const o of others) S.sessions.set(o.id, { ...S.sessions.get(o.id), archived: true });
    close();
    renderFeed();
    reveal(keep);
    toast(`Kept ${trial || `${esc(agentName(S.sessions.get(keep)?.agent))}'s run`}. Ship it when you're ready.`);
    // Try it two ways remembers which it was; missing that doesn't undo the keep.
    if (runs.some((r) => r.id === keep && r.full.trial)) await api(`/sessions/${keep}`, { method: 'PATCH', body: { trialKept: true } }).catch(toastError);
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
