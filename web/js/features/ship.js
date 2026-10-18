// Ship it: worktree → commit → PR → checks → merge.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import { $, $$, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { overlay } from '../ui/overlay.js';
import { toast, toastError } from '../ui/toast.js';

const prTone = (pr) =>
  pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.checks?.fail ? 'fail' : pr.checks?.pending ? 'pending' : pr.review === 'CHANGES_REQUESTED' ? 'fail' : 'pass';
const REVIEW = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required' };
function prLine(pr) {
  const c = pr.checks || {};
  const checks = c.fail ? `${c.fail} check${c.fail > 1 ? 's' : ''} failing` : c.pending ? `${c.pending} check${c.pending > 1 ? 's' : ''} running` : c.pass ? `${c.pass} check${c.pass > 1 ? 's' : ''} passed` : 'No checks';
  const state = pr.state === 'MERGED' ? 'Merged' : pr.state === 'CLOSED' ? 'Closed' : pr.draft ? 'Draft' : 'Open';
  return [state, pr.state === 'OPEN' ? checks : '', pr.state === 'OPEN' ? REVIEW[pr.review] : ''].filter(Boolean).join(' · ');
}

// Ship it only makes sense on a finished worktree task with something to ship: uncommitted
// changes, or commits its open PR (or a new one) doesn't have yet. Unchecked yet: assume it might.
export function shippable(s) {
  if (!s?.branch || s.agent === 'wisp' || s.state === 'running' || s.state === 'waiting' || s.pr?.state === 'MERGED') return false;
  const t = s.toShip;
  return !t || !!(t.dirty || (s.pr?.state === 'OPEN' ? t.unpushed : t.ahead));
}
export const shipLabel = (s) => (s.pr?.state === 'OPEN' ? `Push to PR #${s.pr.number}` : 'Ship it…');

export const prPill = (pr) => `<span class="pill pr pr-${prTone(pr)}" title="PR #${pr.number}: ${esc(prLine(pr))}"><i></i>#${pr.number}</span>`;

// The PR row under a card's bar; reads the live summary, so polled check results show up.
export function renderPrStrip(id) {
  const n = S.nodes.get(id);
  const node = n?.body && $('.pr-strip', n.body);
  const s = S.sessions.get(id);
  if (!node || !s) return;
  const pr = s.pr;
  $$('[data-a="ship"]', n.body).forEach((b) => {
    b.hidden = !shippable(s);
    $('span', b).textContent = pr?.state === 'OPEN' ? `Push to #${pr.number}` : pr ? 'Ship again' : 'Ship it';
  });
  node.hidden = !pr;
  if (!pr) return;
  const tone = prTone(pr);
  node.className = `pr-strip pr-${tone}`;
  node.innerHTML = `
    <span class="pr-dot"></span>
    <a href="${esc(pr.url)}" target="_blank" class="pr-num">PR #${pr.number}</a>
    <span class="pr-line">${esc(prLine(pr))}</span>
    <span class="grow"></span>
    ${pr.state === 'OPEN' ? `<button class="ghost xs" data-pr="refresh" title="Check now (wisp also checks every minute)">${icon('replay')}</button>` : ''}
    <a class="ghost xs" href="${esc(pr.url)}" target="_blank">${icon('external')}<span>GitHub</span></a>
    ${pr.state === 'OPEN' ? `<button class="ghost xs pr-merge" data-pr="merge" title="Squash-merge, then fast-forward your local ${esc(s.branch ? 'base branch' : 'checkout')}">${icon('check')}<span>Merge</span></button>` : ''}`;
  node.onclick = (e) => {
    const a = e.target.closest('[data-pr]')?.dataset.pr;
    if (a === 'refresh') api(`/sessions/${id}/pr`, { method: 'POST', body: {} }).catch(toastError);
    if (a === 'merge') mergePr(id);
  };
}

export async function shipDialog(id) {
  const s = S.sessions.get(id);
  if (!s) return;
  if (s.state === 'running' || s.state === 'waiting') return toast('Still working: let it finish first.');
  let info;
  try {
    info = await api(`/sessions/${id}/ship`);
  } catch (err) {
    return toastError(err);
  }
  const open = info.pr?.state === 'OPEN';
  const nothing = !info.dirty && !info.ahead;
  const node = el(`
    <div class="modal ship-modal">
      <header><h2>${open ? `Push to PR #${info.pr.number}` : 'Ship it'}</h2><button class="icon-btn close">${icon('x')}</button></header>
      <p class="ship-route">${icon('branch')}<code>${esc(info.branch)}</code>${icon('arrow')}<code>${esc(info.remote || 'no remote')}/${esc(info.base)}</code>
        <span class="muted">${info.dirty ? `${info.dirty} uncommitted change${info.dirty > 1 ? 's' : ''}` : 'Nothing uncommitted'} · ${info.ahead} commit${info.ahead === 1 ? '' : 's'} on the branch</span></p>
      ${info.dirty ? `<label class="ship-field"><span>Commit message${open ? '' : ' · PR title'}</span><input class="input" name="title" spellcheck="false" maxlength="100"></label>` : ''}
      ${open ? '' : `<label class="ship-field"><span>Pull request description</span><textarea class="textarea mono" name="body" rows="9" spellcheck="false"></textarea></label>
      <label class="check ship-check"><input type="checkbox" name="draft"> Open as a draft</label>`}
      ${!info.remote ? '<p class="hint bad">This repo has no <code>origin</code> remote, so there is nowhere to push.</p>' : nothing ? '<p class="hint">Nothing to ship yet: the branch has no changes.</p>' : ''}
      <div class="ship-foot"><span class="muted xs">Runs <code>git commit</code>, <code>git push</code>${open ? '' : ' and <code>gh pr create</code>'} in the worktree.</span><button class="primary sm" data-a="go" ${nothing || !info.remote ? 'disabled' : ''}>${icon('send')}${open ? 'Commit & push' : 'Commit, push & open PR'}</button></div>
    </div>`);
  const close = overlay(node);
  $('.close', node).onclick = close;
  const title = $('[name="title"]', node);
  const body = $('[name="body"]', node);
  if (title) title.value = info.title;
  if (body) body.value = info.body;
  const go = async () => {
    const btn = $('[data-a="go"]', node);
    btn.disabled = true;
    btn.lastChild.textContent = 'Shipping…';
    try {
      const pr = await api(`/sessions/${id}/ship`, { method: 'POST', body: { title: title?.value || info.title, body: body?.value ?? info.body, draft: !!$('[name="draft"]', node)?.checked } });
      close();
      toast(`${icon('branch')} ${open ? 'Pushed to' : 'Opened'} <b>PR #${pr.number}</b>`, { action: { label: 'Open', run: () => window.open(pr.url, '_blank') }, timeout: 8000 });
    } catch (err) {
      btn.disabled = false;
      btn.lastChild.textContent = open ? 'Commit & push' : 'Commit, push & open PR';
      toastError(err, { timeout: 10_000 });
    }
  };
  $('[data-a="go"]', node).onclick = go;
  requestAnimationFrame(() => (title || $('[data-a="go"]', node)).focus());
}

export async function mergePr(id) {
  const s = S.sessions.get(id);
  const pr = s?.pr;
  if (!pr || pr.state !== 'OPEN') return;
  const c = pr.checks || {};
  const warn = c.fail ? `\n\n⚠ ${c.fail} check${c.fail > 1 ? 's are' : ' is'} failing.` : c.pending ? `\n\n⚠ ${c.pending} check${c.pending > 1 ? 's are' : ' is'} still running.` : '';
  if (!confirm(`Squash-merge PR #${pr.number}${pr.draft ? ' (marks it ready first)' : ''}, then fast-forward your local base branch and remove the worktree?${warn}`)) return;
  toast(`Merging PR #${pr.number}…`);
  try {
    const r = await api(`/sessions/${id}/merge`, { method: 'POST', body: {} });
    toast(`${icon('check')} Merged <b>PR #${r.pr.number}</b>. ${esc(r.sync.text)}`, { tone: r.sync.ok ? '' : 'bad', timeout: 10_000 });
  } catch (err) {
    toastError(err, { timeout: 12_000 });
  }
}
