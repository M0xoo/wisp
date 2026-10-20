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

// A task in several repos (also) has a PR per repo: its own first, then the others', each { repo, pr }.
export const prsOf = (s) => [...(s?.pr ? [{ repo: s.project, pr: s.pr }] : []), ...(s?.also || []).filter((a) => a.pr).map((a) => ({ repo: a.project, pr: a.pr }))];
export const prOf = (s) => prsOf(s)[0]?.pr || null; // the one the card's pill shows
const branches = (s) => [s?.branch, ...(s?.also || []).map((a) => a.branch)].filter(Boolean);
const severalRepos = (s) => branches(s).length > 1;

// Ship it only makes sense on a finished worktree task with something to ship: uncommitted
// changes, or commits its open PR (or a new one) doesn't have yet. Unchecked yet: assume it might.
// Several repos: the server counts the ones with something new (toShip.repos).
export function shippable(s) {
  if (!branches(s).length || s.agent === 'wisp' || s.state === 'running' || s.state === 'waiting' || shipping(s)) return false;
  const t = s.toShip;
  if (t?.repos !== undefined) return t.repos > 0;
  if (s.pr?.state === 'MERGED') return false;
  return !t || !!(t.dirty || (s.pr?.state === 'OPEN' ? t.unpushed : t.ahead));
}
export const shipLabel = (s) => (severalRepos(s) ? (prsOf(s).some((x) => x.pr.state === 'OPEN') ? 'Push to the PRs…' : 'Ship it…') : s.pr?.state === 'OPEN' ? `Push to PR #${s.pr.number}` : 'Ship it…');

export const shipPill = (s) => (s.shipping ? `<span class="pill ship-pill" title="Shipping: ${esc(STEP_DOING[s.shipping.step] || 'Starting')}${s.shipping.repo ? ` ${esc(s.shipping.repo)}` : ''}…"><i></i>Shipping</span>` : '');

export const prPill = (pr, fix) => `<span class="pill pr pr-${prTone(pr, fix)}" title="PR #${pr.number}: ${esc(prLine(pr, fix))}"><i></i>#${pr.number}</span>`;

// The PR row under a card's bar; reads the live summary, so polled check results show up.
export function renderPrStrip(id) {
  const n = S.nodes.get(id);
  const node = n?.body && $('.pr-strip', n.body);
  const s = S.sessions.get(id);
  if (!node || !s) return;
  const prs = prsOf(s);
  const pr = prs[0]?.pr;
  const several = prs.length > 1;
  $$('[data-a="ship"]', n.body).forEach((b) => {
    b.hidden = !shippable(s);
    $('span', b).textContent = severalRepos(s) ? (prs.some((x) => x.pr.state === 'OPEN') ? 'Push to PRs' : prs.length ? 'Ship again' : 'Ship it') : pr?.state === 'OPEN' ? `Push to #${pr.number}` : pr ? 'Ship again' : 'Ship it';
  });
  // Started here, or elsewhere (another tab, the API): the server's stage moves the track along.
  const run = ships.get(id) || (s.shipping && { steps: s.shipping.update ? ['push', 'pr'] : ['commit', 'push', 'pr'], step: 'push' });
  if (run && STEP_LABEL[s.shipping?.step] && !run.error) Object.assign(run, { step: s.shipping.step, repo: s.shipping.repo, at: s.shipping.at, of: s.shipping.of });
  if (run) return renderShipRun(node, id, run);
  const landed = node.classList.contains('ship-run') && !node.classList.contains('failed');
  node.hidden = !pr;
  if (!pr) return;
  // Several repos: the first PR leads the row and the others follow as small links, each in its
  // own tone; the row takes the worst of them, and Merge merges them all.
  const fix = s.pr ? s.conflictFix : null; // wisp fixes conflicts on the task's own PR only
  const TONES = ['fail', 'pending', 'pass', 'merged', 'closed'];
  const tone = prs.map((x, i) => prTone(x.pr, i ? null : fix)).sort((a, b) => TONES.indexOf(a) - TONES.indexOf(b))[0];
  const open = prs.filter((x) => x.pr.state === 'OPEN');
  const conflict = open.some((x) => x.pr.conflict);
  node.className = `pr-strip pr-${tone}${landed ? ' landed' : ''}`;
  node.innerHTML = `
    <span class="pr-dot"></span>
    <a href="${esc(pr.url)}" target="_blank" class="pr-num">${several ? `${esc(prs[0].repo)} #${pr.number}` : `PR #${pr.number}`}</a>
    ${prs
      .slice(1)
      .map((x) => `<a href="${esc(x.pr.url)}" target="_blank" class="pr-also pr-${prTone(x.pr)}" title="${esc(`${x.repo}: PR #${x.pr.number} · ${prLine(x.pr)}`)}"><i></i>${esc(x.repo)} #${x.pr.number}</a>`)
      .join('')}
    <span class="pr-line">${esc(prLine(pr, fix))}</span>
    <span class="grow"></span>
    ${pr.state === 'OPEN' && pr.conflict && s.pr && !fixing(fix) && s.state !== 'running' ? `<button class="ghost xs pr-fix" data-pr="fix" title="Send the task a follow-up to merge the base in and resolve the conflicts; wisp pushes the fix to the PR">${icon('merge')}<span>Fix conflicts</span></button>` : ''}
    ${open.length ? `<button class="ghost xs" data-pr="refresh" title="Check now (wisp also checks every minute)">${icon('replay')}</button>` : ''}
    ${several ? '' : `<a class="ghost xs" href="${esc(pr.url)}" target="_blank">${icon('external')}<span>GitHub</span></a>`}
    ${open.length && !conflict ? `<button class="ghost xs pr-merge" data-pr="merge" title="Squash-merge${open.length > 1 ? ` all ${open.length} PRs` : ''}, then fast-forward your local base branch${open.length > 1 ? 'es' : ''}">${icon('check')}<span>Merge${open.length > 1 ? ' all' : ''}</span></button>` : ''}`;
  node.onclick = (e) => {
    const a = e.target.closest('[data-pr]')?.dataset.pr;
    if (a === 'refresh') refreshPr(id, e.target.closest('[data-pr]'));
    if (a === 'merge') mergePr(id);
    if (a === 'fix') fixPr(id);
  };
}

// Check now: the button spins at once and stops when the answer (pushed as a summary) is in.
function refreshPr(id, btn) {
  btn.classList.add('busy');
  btn.disabled = true;
  api(`/sessions/${id}/pr`, { method: 'POST', body: {} })
    .catch(toastError)
    .finally(() => {
      btn.classList.remove('busy');
      btn.disabled = false;
    });
}

// Fix conflicts: the row flips to "Fixing merge conflicts" at once; a refusal puts it back.
function fixPr(id) {
  const s = S.sessions.get(id);
  if (!s) return;
  const was = s.conflictFix;
  s.conflictFix = { ...was, step: 'fixing', why: '' };
  renderPrStrip(id);
  api(`/sessions/${id}/fix-conflicts`, { method: 'POST', body: {} }).catch((err) => {
    const now = S.sessions.get(id);
    if (now?.conflictFix?.step === 'fixing') now.conflictFix = was;
    renderPrStrip(id);
    toastError(err);
  });
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
  const repo = !failed && run.repo ? ` ${esc(run.repo)}${run.of > 1 ? ` <span class="muted">(${run.at} of ${run.of})</span>` : ''}` : '';
  const what = failed ? `Ship failed at ${STEP_LABEL[run.steps[at]] || 'start'}: <span class="ship-err">${esc(run.error)}</span>` : `${STEP_DOING[run.steps[at]]}${repo}<span class="dots"></span>`;
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
  // Several repos: a route line each, and the PRs open or update together.
  const repos = info.repos || [info];
  const open = repos.every((r) => r.pr?.state === 'OPEN');
  const typed = ships.get(id)?.values; // a failed ship's message, back for Retry
  const nothing = !info.dirty && !info.ahead;
  const noRemote = repos.every((r) => !r.remote);
  const route = (r) => `<p class="ship-route">${icon('branch')}${info.repos ? `<b class="ship-repo">${esc(r.repo)}</b>` : ''}<code>${esc(r.branch)}</code>${icon('arrow')}<code>${esc(r.remote || 'no remote')}/${esc(r.base)}</code>
        <span class="muted">${r.dirty ? `${r.dirty} uncommitted change${r.dirty > 1 ? 's' : ''}` : 'Nothing uncommitted'} · ${r.ahead} commit${r.ahead === 1 ? '' : 's'} on the branch${info.repos && r.pr ? ` · PR #${r.pr.number}` : ''}</span></p>`;
  const node = el(`
    <div class="modal ship-modal">
      <header><h2>${open ? (info.repos ? `Push to ${repos.length} PRs` : `Push to PR #${info.pr.number}`) : info.repos ? `Ship it to ${repos.length} repos` : 'Ship it'}</h2><button class="icon-btn close">${icon('x')}</button></header>
      ${repos.map(route).join('')}
      ${info.dirty ? `<label class="ship-field"><span>Commit message${open ? '' : ' · PR title'}</span><input class="input" name="title" spellcheck="false" maxlength="100"></label>` : ''}
      ${open ? '' : `<label class="ship-field"><span>Pull request description</span><textarea class="textarea mono" name="body" rows="9" spellcheck="false"></textarea></label>
      <label class="check ship-check"><input type="checkbox" name="draft"> Open as a draft</label>`}
      ${noRemote ? `<p class="hint bad">${info.repos ? 'These repos have' : 'This repo has'} no <code>origin</code> remote, so there is nowhere to push.</p>` : nothing ? '<p class="hint">Nothing to ship yet: the branch has no changes.</p>' : ''}
      <div class="ship-foot"><span class="muted xs">Runs <code>git commit</code>, <code>git push</code>${open ? '' : ' and <code>gh pr create</code>'} in ${info.repos ? 'each worktree with changes, one PR per repo' : 'the worktree'}.</span><button class="primary sm" data-a="go" ${nothing || noRemote ? 'disabled' : ''}>${icon('send')}${open ? 'Commit & push' : info.repos ? 'Commit, push & open PRs' : 'Commit, push & open PR'}</button></div>
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
        // Several repos: their PRs come with the server's next summary.
        if (s) S.sessions.set(id, { ...s, ...(!pr.prs && { pr: { ...s.pr, ...pr } }), shipping: null, toShip: s.toShip && { ...s.toShip, dirty: 0, unpushed: 0, ...(s.toShip.repos !== undefined && { repos: 0 }) } });
        ships.delete(id);
        renderPrStrip(id);
        const what = pr.prs ? pr.prs.map((x) => `<b>${esc(x.repo)} #${x.number}</b>`).join(', ') : `<b>PR #${pr.number}</b>`;
        toast(`${icon('branch')} ${open ? 'Pushed to' : pr.prs ? 'PRs:' : 'Opened'} ${what}`, { action: { label: 'Open', run: () => window.open(pr.url, '_blank') }, timeout: 8000 });
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
  const open = prsOf(s).filter((x) => x.pr.state === 'OPEN');
  if (!open.length) return;
  const several = open.length > 1;
  const warn = open
    .map(({ repo, pr }) => {
      const c = pr.checks || {};
      const where = several ? ` in ${repo}` : '';
      return c.fail ? `⚠ ${c.fail} check${c.fail > 1 ? 's are' : ' is'} failing${where}.` : c.pending ? `⚠ ${c.pending} check${c.pending > 1 ? 's are' : ' is'} still running${where}.` : '';
    })
    .filter(Boolean)
    .join('\n');
  const what = several ? `these ${open.length} PRs (${open.map((x) => `${x.repo} #${x.pr.number}`).join(', ')})` : `PR #${open[0].pr.number}${open[0].pr.draft ? ' (marks it ready first)' : ''}`;
  if (!confirm(`Squash-merge ${what}, then fast-forward your local base branch${several ? 'es' : ''} and remove the worktree${several ? 's' : ''}?${warn ? `\n\n${warn}` : ''}`)) return;
  toast(several ? `Merging ${open.length} PRs…` : `Merging PR #${open[0].pr.number}…`);
  try {
    const r = await api(`/sessions/${id}/merge`, { method: 'POST', body: {} });
    const merged = r.prs ? r.prs.filter((x) => x.state === 'MERGED').map((x) => `${esc(x.repo)} #${x.number}`).join(', ') : `PR #${r.pr.number}`;
    toast(`${icon('check')} Merged <b>${merged}</b>. ${esc(r.sync.text)}`, { tone: r.sync.ok ? '' : 'bad', timeout: 10_000 });
  } catch (err) {
    toastError(err, { timeout: 12_000 });
  }
}
