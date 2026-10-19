// Ship it: worktree → commit → PR → checks → merge.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import { $, $$, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { overlay } from '../ui/overlay.js';
import { toast, toastError } from '../ui/toast.js';

// fix: the session's conflictFix ({ step, why }) while wisp resolves the PR's merge conflicts itself.
const fixing = (fix) => fix?.step === 'fixing' || fix?.step === 'pushing';
const prTone = (pr, fix) =>
  pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.conflict ? (fixing(fix) ? 'pending' : 'fail') : pr.checks?.fail ? 'fail' : pr.checks?.pending ? 'pending' : pr.review === 'CHANGES_REQUESTED' ? 'fail' : 'pass';
const REVIEW = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required' };
function prLine(pr, fix) {
  if (pr.state === 'OPEN' && (pr.conflict || fixing(fix))) {
    const what = fix?.step === 'pushing' ? 'Pushing the conflict fix' : fixing(fix) ? 'Fixing merge conflicts' : fix?.step === 'failed' ? `Conflicts not fixed: ${fix.why}` : 'Merge conflicts';
    return `Open · ${what}`;
  }
  const c = pr.checks || {};
  const checks = c.fail ? `${c.fail} check${c.fail > 1 ? 's' : ''} failing` : c.pending ? `${c.pending} check${c.pending > 1 ? 's' : ''} running` : c.pass ? `${c.pass} check${c.pass > 1 ? 's' : ''} passed` : 'No checks';
  const state = pr.state === 'MERGED' ? 'Merged' : pr.state === 'CLOSED' ? 'Closed' : pr.draft ? 'Draft' : 'Open';
  return [state, pr.state === 'OPEN' ? checks : '', pr.state === 'OPEN' ? REVIEW[pr.review] : ''].filter(Boolean).join(' · ');
}

// A ship in flight, per session: { steps, step, update, route, error, values }. The dialog closes
// on confirm and the card follows along here (the server sends the live stage as `shipping`);
// a failure stays on the card with Retry, which reopens the dialog with what was typed.
const ships = new Map();
const STEP_LABEL = { commit: 'Commit', push: 'Push', pr: 'Open PR' };
const STEP_DOING = { commit: 'Committing', push: 'Pushing', pr: 'Opening the PR' };
const shipping = (s) => !!(s?.shipping || (ships.has(s?.id) && !ships.get(s.id).error));

// Ship it only makes sense on a finished worktree task with something to ship: uncommitted
// changes, or commits its open PR (or a new one) doesn't have yet. Unchecked yet: assume it might.
export function shippable(s) {
  if (!s?.branch || s.agent === 'wisp' || s.state === 'running' || s.state === 'waiting' || s.pr?.state === 'MERGED' || shipping(s)) return false;
  const t = s.toShip;
  return !t || !!(t.dirty || (s.pr?.state === 'OPEN' ? t.unpushed : t.ahead));
}
export const shipLabel = (s) => (s.pr?.state === 'OPEN' ? `Push to PR #${s.pr.number}` : 'Ship it…');

export const shipPill = (s) => (s.shipping ? `<span class="pill ship-pill" title="Shipping: ${esc(STEP_DOING[s.shipping.step] || 'Starting')}…"><i></i>Shipping</span>` : '');

export const prPill = (pr, fix) => `<span class="pill pr pr-${prTone(pr, fix)}" title="PR #${pr.number}: ${esc(prLine(pr, fix))}"><i></i>#${pr.number}</span>`;

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
  // Started here, or elsewhere (another tab, the API): the server's stage moves the track along.
  const run = ships.get(id) || (s.shipping && { steps: s.shipping.update ? ['push', 'pr'] : ['commit', 'push', 'pr'], step: 'push' });
  if (run && STEP_LABEL[s.shipping?.step] && !run.error) run.step = s.shipping.step;
  if (run) return renderShipRun(node, id, run);
  const landed = node.classList.contains('ship-run') && !node.classList.contains('failed');
  node.hidden = !pr;
  if (!pr) return;
  const tone = prTone(pr, s.conflictFix);
  node.className = `pr-strip pr-${tone}${landed ? ' landed' : ''}`;
  node.innerHTML = `
    <span class="pr-dot"></span>
    <a href="${esc(pr.url)}" target="_blank" class="pr-num">PR #${pr.number}</a>
    <span class="pr-line">${esc(prLine(pr, s.conflictFix))}</span>
    <span class="grow"></span>
    ${pr.state === 'OPEN' && pr.conflict && s.conflictFix?.step === 'failed' ? `<button class="ghost xs" data-pr="fix" title="Ask the agent to merge the base in and resolve the conflicts again">${icon('replay')}<span>Fix conflicts</span></button>` : ''}
    ${pr.state === 'OPEN' ? `<button class="ghost xs" data-pr="refresh" title="Check now (wisp also checks every minute)">${icon('replay')}</button>` : ''}
    <a class="ghost xs" href="${esc(pr.url)}" target="_blank">${icon('external')}<span>GitHub</span></a>
    ${pr.state === 'OPEN' && !pr.conflict ? `<button class="ghost xs pr-merge" data-pr="merge" title="Squash-merge, then fast-forward your local ${esc(s.branch ? 'base branch' : 'checkout')}">${icon('check')}<span>Merge</span></button>` : ''}`;
  node.onclick = (e) => {
    const a = e.target.closest('[data-pr]')?.dataset.pr;
    if (a === 'refresh') api(`/sessions/${id}/pr`, { method: 'POST', body: {} }).catch(toastError);
    if (a === 'merge') mergePr(id);
    if (a === 'fix') api(`/sessions/${id}/fix-conflicts`, { method: 'POST', body: {} }).catch(toastError);
  };
}

// The in-flight row: the stages as a track that fills in as the server reports them. Built once
// and updated in place, so its entry animation and shimmer don't restart with every summary.
function renderShipRun(node, id, run) {
  const at = Math.max(run.steps.indexOf(run.step), 0);
  if (!node.classList.contains('ship-run') || node.dataset.steps !== run.steps.join()) {
    node.dataset.steps = run.steps.join();
    node.innerHTML = `
      <span class="ship-icon">${icon('send')}</span>
      <span class="ship-what"></span>
      <ol class="ship-track">${run.steps.map((k) => `<li data-step="${k}"><i>${icon('check')}</i><span>${STEP_LABEL[k]}</span></li>`).join('')}</ol>
      <span class="grow"></span>
      <span class="ship-acts"></span>
      <span class="ship-bar"></span>`;
    node.onclick = (e) => {
      const a = e.target.closest('[data-ship]')?.dataset.ship;
      if (a === 'retry') shipDialog(id);
      if (a === 'dismiss') {
        ships.delete(id);
        renderPrStrip(id);
      }
    };
  }
  const failed = !!run.error;
  node.hidden = false;
  node.className = `pr-strip ship-run${failed ? ' failed pr-fail' : ''}`;
  node.title = failed ? run.error : '';
  $$('.ship-track li', node).forEach((li, i) => (li.className = i < at ? 'done' : i === at ? (failed ? 'bad' : 'now') : ''));
  const what = failed ? `Ship failed at ${STEP_LABEL[run.steps[at]] || 'start'}: <span class="ship-err">${esc(run.error)}</span>` : `${STEP_DOING[run.steps[at]]}<span class="dots"></span>`;
  if ($('.ship-what', node).innerHTML !== what) $('.ship-what', node).innerHTML = what;
  const acts = failed ? `<button class="ghost xs" data-ship="retry">${icon('replay')}<span>Retry</span></button><button class="ghost xs" data-ship="dismiss" title="Dismiss">${icon('x')}</button>` : '';
  if ($('.ship-acts', node).innerHTML !== acts) $('.ship-acts', node).innerHTML = acts;
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
  const typed = ships.get(id)?.values; // a failed ship's message, back for Retry
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
  if (title) title.value = typed?.title || info.title;
  if (body) body.value = typed?.body ?? info.body;
  if (typed?.draft && $('[name="draft"]', node)) $('[name="draft"]', node).checked = true;
  // Confirm closes the dialog at once; the card's PR row shows the stages, then the PR itself.
  const go = () => {
    if (title && !title.value.trim()) {
      title.focus();
      return toast('A commit message is required.', { tone: 'bad' });
    }
    const values = { title: title?.value || info.title, body: body?.value ?? info.body, draft: !!$('[name="draft"]', node)?.checked };
    close();
    ships.set(id, { steps: [...(info.dirty ? ['commit'] : []), 'push', 'pr'], step: info.dirty ? 'commit' : 'push', update: open, values });
    renderPrStrip(id);
    const strip = S.nodes.get(id)?.body?.querySelector('.pr-strip');
    if (strip && !strip.hidden) strip.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    api(`/sessions/${id}/ship`, { method: 'POST', body: values }).then(
      (pr) => {
        const s = S.sessions.get(id);
        // Everything just went up: no Push to #n until the server's recheck finds something new.
        if (s) S.sessions.set(id, { ...s, pr: { ...s.pr, ...pr }, shipping: null, toShip: s.toShip && { ...s.toShip, dirty: 0, unpushed: 0 } });
        ships.delete(id);
        renderPrStrip(id);
        toast(`${icon('branch')} ${open ? 'Pushed to' : 'Opened'} <b>PR #${pr.number}</b>`, { action: { label: 'Open', run: () => window.open(pr.url, '_blank') }, timeout: 8000 });
      },
      (err) => {
        if (ships.has(id)) ships.get(id).error = err.message;
        const s = S.sessions.get(id);
        if (s) S.sessions.set(id, { ...s, shipping: null });
        renderPrStrip(id);
        toastError(err, { timeout: 10_000 });
      },
    );
  };
  $('[data-a="go"]', node).onclick = () => {
    go();
  };
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
