// The side panel: a third column beside the open task, on the far side from the list, for doing
// things with what the agent made without leaving wisp (design/side-panel.md). Two tabs:
//
//   Shell  your shell in the folder the task was built in (its worktree), on whichever computer
//          ran it: here, a machine over SSH, a cloud computer. The server runs it on a pty
//          (routes/workspace.js); a machine's or the grid's wisp runs it there, through the proxy.
//   PR     the task's pull request without the noise: the verdict and its one next step, each
//          check (failing first), where reviewers stand, the conversation (bots and outdated
//          threads folded), the files. Ask to fix and Send to agent fill the task's reply box.
//
// It goes with the task: home or a crew member's thread puts it away, and the next task opens it
// on the tab it had. Each task keeps its own shell while you look at others. From 1180px it's a
// column of its own; narrower (900–1179px) it takes the list's place while open; stacked (and in
// the phone app) it's a page over the task with Back.

import { esc } from '../md.js';
import { copy } from '../blocks.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, el, icon } from '../core/dom.js';
import { ago } from '../core/format.js';
import { HERE, inGrid, load, MOBILE, S, save } from '../core/state.js';
import { ask } from '../ui/confirm.js';
import { keyHint } from '../ui/kbd.js';
import { popover } from '../ui/popover.js';
import { toast, toastError } from '../ui/toast.js';
import { draftInto } from './composer.js';
import { expand } from './feed.js';
import { agentName } from './runners.js';
import { fixPr, mergePr, prsOf, shipDialog, shippable } from './ship.js';
import { slotHtml, spellProp } from './spells.js';
import { isSplit, isStacked, relayout, splitOpen } from './split.js';
import { connect, SCREEN_HTML, termState, TermView, TOUCH } from './term-view.js';

const PANEL_W = 480;
const MIN_W = 360;
const TASK_MIN = 480; // the task beside it never gets narrower
export const PANEL_WIDE = 1180; // narrower than this, the panel takes the list's place while open

// Yours, in this browser: open or not, the last tab, the width you dragged it to.
const pref = { open: false, tab: null, ...load('wisp.panel', {}) };
const keep = () => save('wisp.panel', pref);
// Stacked (a phone), the task page's segments pick it instead: { id, tab } while Shell or PR shows
// on that task's page, null on Task. Not kept: a task page always opens on Task.
let seg = null;
const segOn = () => isStacked() && !!seg && seg.id === target();
const tabOf = () => (segOn() ? seg.tab : pref.tab || spellProp('panel', 'tab') || 'shell');

const shells = new Map(); // task id -> its shell (term-view state), kept while it runs
const spaces = new Map(); // task id -> the last workspace seen ({ dir, worktree, status, shell, … } or { error })
const details = new Map(); // task id -> { prs, at, error } the last PR detail seen
const picked = new Map(); // task id -> which of its PRs the PR tab shows
const folds = new Map(); // task id -> Set of folds opened (passed, bots, outdated, files)
let shown = null; // the task the panel shows now

// --- the DOM ---------------------------------------------------------------------------------

const panel = el(`
  <aside class="side-panel" id="sidePanel" hidden aria-label="Side panel">
    <div class="pn-grip" role="separator" aria-orientation="vertical" aria-label="Resize the side panel" title="Drag to resize · double-click to reset"></div>
    <header class="pn-head">
      <div class="pn-tabs" role="tablist">
        <button role="tab" data-tab="shell">${icon('shell')}<span>Shell</span></button>
        <button role="tab" data-tab="pr">${icon('merge')}<span class="pn-pr-name">PR</span></button>
      </div>
      <span class="pn-acts"></span>
      <button class="icon-btn pn-close" title="Hide side panel (])" aria-label="Hide side panel">${icon('x')}</button>
    </header>
    <div class="pn-place"></div>
    <p class="pn-note" hidden></p>
    <section class="pn-shell" role="tabpanel" hidden>
      ${SCREEN_HTML}
      <div class="pn-msg" hidden></div>
      <div class="pn-ended" hidden><span></span><button class="ghost xs" data-a="restart">${icon('replay')}<span>Start again</span></button></div>
    </section>
    <section class="pn-pr" role="tabpanel" hidden></section>
  </aside>`);
$('#stage').append(panel);
const view = new TermView($('.pn-shell', panel), { shown: () => !panel.hidden && $('.pn-shell', panel).hidden === false });

// --- where it shows -------------------------------------------------------------------------

const squeezed = () => !isStacked() && innerWidth < PANEL_WIDE;
// The task the panel is for now: the one open in the main pane (none on home, a crew thread).
const target = () => (isSplit() ? splitOpen() : null);
export const panelShown = () => !panel.hidden;

let fresh = false; // opened by you just now: the one time it animates in
function paint() {
  const id = (isStacked() ? segOn() : pref.open) ? target() : null;
  const on = !!id;
  const was = !panel.hidden;
  if (on !== was || document.body.classList.contains('panel-open') !== on) {
    panel.hidden = !on;
    document.body.classList.toggle('panel-open', on);
    document.body.classList.toggle('panel-squeeze', on && squeezed());
    panel.classList.toggle('pn-in', on && fresh);
    relayout(); // the grid gets its third column, the details column folds, the list may make way
  } else document.body.classList.toggle('panel-squeeze', on && squeezed());
  fresh = false;
  panel.classList.toggle('stacked', on && isStacked());
  panel.classList.toggle('touch', TOUCH.matches || MOBILE);
  // The PR tab shows the PR in full: the task's own PR row would say it twice.
  document.body.classList.toggle('panel-pr', on && tabOf() === 'pr');
  paintWidth();
  paintBtn();
  paintSegs(on ? tabOf() : 'task');
  if (!on) {
    if (shown) view.blur();
    shown = null;
    return;
  }
  if (!was || shown !== id) freshShell(id);
  if (shown !== id) {
    shown = id;
    panel.dataset.id = id;
    loadSpace(id);
  }
  paintTabs();
  paintPlace();
  paintBody();
}

function paintWidth() {
  const max = Math.max(MIN_W, innerWidth - (isStacked() ? 0 : parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--side-w')) || 340) * (squeezed() ? 0 : 1) - TASK_MIN);
  const w = Math.round(Math.min(Math.max(pref.w ?? spellProp('panel', 'width') ?? PANEL_W, MIN_W), max));
  document.documentElement.style.setProperty('--panel-w', `${w}px`);
}

// Stacked: the segments under the task head (split.js draws them) show which is picked.
function paintSegs(at) {
  document.body.dataset.seg = at;
  for (const b of document.querySelectorAll('#splitHead [data-seg]')) b.setAttribute('aria-selected', b.dataset.seg === at);
}

// The task head's toggle (split.js draws it): pressed while the panel is open.
function paintBtn() {
  const b = $('#splitHead .sh-panel');
  if (!b) return;
  const on = !panel.hidden;
  b.setAttribute('aria-pressed', on);
  b.title = `${on ? 'Hide' : 'Show'} side panel (])`;
  b.setAttribute('aria-label', b.title);
}

function paintTabs() {
  const s = S.sessions.get(shown);
  const prs = prsOf(s);
  const n = prs.length;
  $('.pn-pr-name', panel).textContent = n > 1 ? 'PRs' : n ? `PR #${prs[0].pr.number}` : 'PR';
  const tab = tabOf();
  for (const b of panel.querySelectorAll('[data-tab]')) {
    b.setAttribute('aria-selected', b.dataset.tab === tab);
    b.tabIndex = b.dataset.tab === tab ? 0 : -1;
  }
  $('.pn-shell', panel).hidden = tab !== 'shell';
  $('.pn-pr', panel).hidden = tab !== 'pr';
  const acts = $('.pn-acts', panel);
  const html = slotHtml('panel.head', s);
  if (acts.dataset.h !== html) (acts.innerHTML = html), (acts.dataset.h = html);
}

function paintBody() {
  if (tabOf() === 'shell') paintShell();
  else paintPr();
}

// --- the place line: which computer, which folder, what's not shipped ------------------------

// Where the task runs: { icon, name } for this computer, a machine, or a cloud computer.
function placeOf(s) {
  if (s?.machine) return { icon: s.machine.kind === 'grid' ? 'cloud' : 'server', name: s.machine.name };
  return { icon: inGrid() ? 'cloud' : 'laptop', name: HERE };
}
const folderName = (dir) => String(dir || '').split(/[\\/]/).filter(Boolean).pop() || '~';

function paintPlace() {
  const s = S.sessions.get(shown);
  const w = spaces.get(shown);
  const where = placeOf(s);
  const st = w?.status;
  const counts = [st?.ahead ? `<span title="${st.ahead} commit${st.ahead > 1 ? 's' : ''} past ${esc(w.worktree?.base || 'the base')}">↑${st.ahead}</span>` : '', st?.dirty ? `<span title="Uncommitted changes">${st.dirty} changed</span>` : ''].filter(Boolean).join('<i>·</i>');
  const what = !w || w.error ? '<i class="sk pn-sk-branch"></i>' : w.worktree && !w.gone ? `<code class="pn-branch" title="${esc(w.dir)}">${esc(w.worktree.branch)}</code>` : `<code class="pn-branch" title="${esc(w.dir)}">${esc(folderName(w.dir))}</code>`;
  const shellOn = tabOf() === 'shell' && shells.get(shown)?.code === null;
  const html = `
    <span class="pn-where" title="Runs on ${esc(where.name)}">${icon(where.icon)}<span>${esc(where.name)}</span></span>
    <i>·</i>${what}${counts ? `<span class="pn-counts">${counts}</span>` : ''}
    <span class="grow"></span>
    <button class="icon-btn xs pn-more" title="Copy the path, open it elsewhere" aria-label="More">${icon('dots')}</button>
    ${shellOn ? `<button class="icon-btn xs pn-end" title="End shell" aria-label="End shell">${icon('stop')}</button>` : ''}`;
  const node = $('.pn-place', panel);
  if (node.dataset.h !== html) (node.innerHTML = html), (node.dataset.h = html);
  // One line under it when the folder needs a word: not a worktree, gone with its merge, shared with the agent.
  const note = $('.pn-note', panel);
  const live = s?.state === 'running' || s?.state === 'waiting';
  const text =
    w && !w.error
      ? !w.worktree
        ? `${icon('warn')}Not a worktree: commands here change your project folder.`
        : w.gone
          ? `${icon('info')}The worktree went with the merge: the shell opens in the project folder.`
          : live
            ? `${esc(agentName(s.agent))} is working in this folder too.`
            : ''
      : '';
  if (note.dataset.h !== text) (note.innerHTML = text), (note.dataset.h = text);
  note.hidden = !text;
}

async function loadSpace(id) {
  try {
    const w = await api(`/sessions/${id}/workspace`);
    spaces.set(id, w);
  } catch (err) {
    spaces.set(id, { error: err.message, status: err.status });
  }
  if (shown === id) (paintPlace(), paintBody());
}

// --- Shell -----------------------------------------------------------------------------------

// Start the task's shell, or show the one running (after a reload: the server's, replayed). At
// the size the screen has now; restart: a fresh one.
async function startShell(id, { restart = false } = {}) {
  let t = shells.get(id);
  if (restart || !t || t.code !== null) {
    t = termState(id, `/sessions/${id}/shell`, {
      onHello: () => shown === id && paintShell(),
      onExit: () => shown === id && (paintShell(), paintPlace()),
    });
    shells.set(id, t);
  }
  view.show(t);
  if (t.es || t.starting) return;
  t.starting = true;
  try {
    const out = await api(`/sessions/${id}/shell`, { method: 'POST', body: { ...view.size(), ...(restart && { restart: true }) } });
    if (out.gone && !spaces.get(id)?.gone) loadSpace(id);
    connect(t);
  } catch (err) {
    if (shells.get(id) === t) shells.delete(id);
    spaces.set(id, { ...(spaces.get(id) || {}), error: err.message, status: err.status });
    if (shown === id) paintShell();
    return;
  } finally {
    t.starting = false;
  }
  if (shown === id) (paintShell(), paintPlace(), view.focus());
}

// Coming to a task's shell (the panel opens, another task, the Shell tab) whose shell has ended
// (exited, or the server lost it: forgotten 10 minutes after, wisp restarted): a new one starts,
// never the dead screen. Watching it end, its last screen and Start again stay.
function freshShell(id) {
  if (shells.get(id)?.code !== null) shells.delete(id);
}

function paintShell() {
  const id = shown;
  const box = $('.pn-shell', panel);
  const w = spaces.get(id);
  const s = S.sessions.get(id);
  const msg = $('.pn-msg', box);
  const ended = $('.pn-ended', box);
  const where = placeOf(s).name;
  // Can't run here: one sentence and at most one way on, never an empty black box.
  const why = !w ? null : w.error ? blockFor(w, s) : !w.shell?.supported ? { text: 'No shell on Windows yet: wisp’s terminal needs macOS or Linux on the computer the task runs on.', btn: w.shell?.app ? ['app', 'Open in terminal app'] : null } : null;
  if (why) {
    view.show(null);
    msg.innerHTML = `${icon(why.icon || 'shell')}<p>${esc(why.text)}</p>${why.btn ? `<button class="ghost sm" data-a="${why.btn[0]}">${why.btn[1]}</button>` : ''}`;
    msg.hidden = false;
    ended.hidden = true;
    box.classList.add('blocked');
    return;
  }
  msg.hidden = true;
  box.classList.remove('blocked');
  const t = shells.get(id);
  // Starting: the shimmer, with what's starting where.
  $('.tm-wait-l', box).textContent = w ? `Starting ${w.shell?.name || 'a shell'} in ${folderName(w.dir)} on ${where}` : `Finding the task’s folder on ${where}`;
  if (!w) {
    view.show(null);
    $('.tm-wait', box).hidden = false;
    ended.hidden = true;
    return;
  }
  if (!t) return void startShell(id);
  view.show(t);
  ended.hidden = t.code === null;
  if (t.code !== null) $('span', ended).textContent = `Shell ended${t.code ? ` (exit ${t.code})` : ''}`;
}

function blockFor(w, s) {
  const m = s?.machine;
  if (w.status === 404 && m) return { icon: 'update', text: `${m.name} runs an older wisp: update it to open a shell there.`, btn: ['retry', 'Try again'] };
  if (m && (w.status === 502 || w.status === 503 || w.status === 504 || /offline|not connected|ECONN|timed out/i.test(w.error))) return { icon: m.kind === 'grid' ? 'cloud' : 'server', text: `${m.name} isn’t answering right now.`, btn: ['retry', 'Try again'] };
  return { icon: 'warn', text: w.error, btn: ['retry', 'Try again'] };
}

async function endShell() {
  const t = shells.get(shown);
  if (!t || t.code !== null) return;
  if (!(await ask('End the shell?\n\nWhatever runs in it stops with it.', { ok: 'End shell', danger: true }))) return;
  const id = t.id;
  // Ended, not forgotten: dropped from shells, the repaint would start a new one at once, racing
  // the DELETE (it came back, or attached to the old one as it went). Start again starts it.
  t.code = 0;
  t.es?.close();
  t.es = null;
  t.view?.schedule(t);
  if (shown === id) (paintShell(), paintPlace());
  api(`/sessions/${id}/shell`, { method: 'DELETE' }).catch(toastError);
}

// --- PR --------------------------------------------------------------------------------------

let pollTimer = null;
const loading = new Set();
async function loadPrs(id, { quiet = true } = {}) {
  if (loading.has(id)) return;
  loading.add(id);
  clearTimeout(pollTimer);
  const btn = $('.pn-refresh', panel);
  btn?.classList.add('busy');
  try {
    const { prs } = await api(`/sessions/${id}/prs`);
    details.set(id, { prs, at: Date.now() });
  } catch (err) {
    const was = details.get(id);
    details.set(id, { ...(was || { prs: [] }), error: err.message, at: Date.now() });
    if (!quiet) toastError(err);
  }
  loading.delete(id);
  $('.pn-refresh', panel)?.classList.remove('busy');
  if (shown === id && tabOf() === 'pr') paintPr();
  schedulePoll(id);
}
// While the PR tab shows: every 20s while a check runs, else every minute. Hidden, it doesn't poll.
function schedulePoll(id) {
  clearTimeout(pollTimer);
  const d = details.get(id);
  const running = d?.prs?.some((p) => p.state === 'OPEN' && (p.checks?.pending || !p.checkList));
  pollTimer = setTimeout(() => {
    if (shown === id && tabOf() === 'pr' && !panel.hidden && document.visibilityState === 'visible') loadPrs(id);
  }, running ? 20_000 : 60_000);
}

const fold = (id, k) => folds.get(id)?.has(k);
const STATE = { OPEN: 'Open', MERGED: 'Merged', CLOSED: 'Closed' };
const VERDICT_ICON = { pass: 'check', fail: 'x', pending: 'clock', merged: 'merge', closed: 'x', draft: 'pen' };
const dur = (ms) => (ms === null || ms === undefined ? '' : ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`);
const initial = (who) => esc(String(who || '?').replace(/\[bot\]$/, '').slice(0, 1).toUpperCase());
const who = (n) => `<span class="pn-av" aria-hidden="true">${initial(n.author)}</span><b>${esc(n.author || 'someone')}</b>${n.bot ? '<small>bot</small>' : ''}`;
// A comment's text, short: the first lines, no markdown noise (images, HTML comments, badges).
function gist(body, max = 420) {
  const t = String(body || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return esc(t.length > max ? `${t.slice(0, max).trimEnd()}…` : t);
}

// The one sentence about where the PR stands, and its one next step.
function verdict(p, s) {
  const c = p.checks || {};
  const base = esc(p.base || 'main');
  if (p.state === 'MERGED') return { tone: 'merged', text: `Merged into ${base}${p.mergedAt ? ` · ${ago(Date.parse(p.mergedAt))} ago` : ''}` };
  if (p.state === 'CLOSED') return { tone: 'closed', text: 'Closed without merging' };
  const fixing = s?.conflictFix?.step === 'fixing' || s?.conflictFix?.step === 'pushing';
  if (p.conflict) return { tone: fixing ? 'pending' : 'fail', text: fixing ? 'The agent is resolving the conflicts' : `Conflicts with ${base}`, btn: fixing || !s?.pr || s.pr.number !== p.number || s.state === 'running' ? null : ['fix', 'Fix conflicts', 'ghost'] };
  const changes = (p.reviewers || []).find((r) => r.state === 'CHANGES_REQUESTED');
  if (c.fail) return { tone: 'fail', text: `${c.fail} check${c.fail > 1 ? 's' : ''} failing`, btn: null };
  if (changes) return { tone: 'fail', text: `Changes requested by ${esc(changes.author)}` };
  if (c.pending) return { tone: 'pending', text: `Waiting on ${c.pending} check${c.pending > 1 ? 's' : ''}`, btn: ['merge', 'Merge', 'ghost'] };
  if (p.draft) return { tone: 'draft', text: 'Draft: merging marks it ready first', btn: ['merge', 'Merge', 'ghost'] };
  if (p.review === 'REVIEW_REQUIRED') return { tone: 'pending', text: 'Needs a review before it can merge', btn: ['merge', 'Merge', 'ghost'] };
  return { tone: 'pass', text: 'Ready to merge', btn: ['merge', 'Merge', 'primary'] };
}

function checksHtml(id, p, canAsk) {
  const list = p.checkList || [];
  if (!list.length) return `<section class="pn-checks"><h4>Checks</h4><p class="pn-none">No checks on this PR.</p></section>`;
  const row = (c) => `
    <li class="pn-check ${c.state}">
      ${icon(c.state === 'fail' ? 'x' : c.state === 'pending' ? 'clock' : c.state === 'skip' ? 'skip' : 'check')}
      <span class="pn-cname" title="${esc(c.workflow ? `${c.workflow} / ${c.name}` : c.name)}">${esc(c.name)}</span>
      <span class="pn-dur">${c.state === 'pending' ? 'running' : c.state === 'skip' ? 'skipped' : dur(c.ms)}</span>
      ${c.state === 'fail' && canAsk ? `<button class="ghost xs" data-a="fix-check" data-url="${esc(c.url)}" data-name="${esc(c.name)}" title="Put the failing log in the reply box for the agent">${icon('spark')}<span>Ask to fix</span></button>` : ''}
      ${c.url ? `<a class="icon-btn xs" href="${esc(c.url)}" target="_blank" rel="noopener" title="Logs" aria-label="Logs for ${esc(c.name)}">${icon('external')}</a>` : ''}
    </li>`;
  const bad = list.filter((c) => c.state === 'fail' || c.state === 'pending');
  const ok = list.filter((c) => c.state === 'pass' || c.state === 'skip');
  const passed = ok.filter((c) => c.state === 'pass').length;
  const skipped = ok.length - passed;
  const okLine = [passed && `${passed} passed`, skipped && `${skipped} skipped`].filter(Boolean).join(' · ');
  const open = fold(id, 'passed') || !bad.length;
  return `
    <section class="pn-checks"><h4>Checks</h4>
      <ul>${bad.map(row).join('')}</ul>
      ${ok.length ? (open ? `<ul>${ok.map(row).join('')}</ul>${bad.length ? `<button class="pn-fold" data-fold="passed">${icon('chevron')}Fold the ${ok.length} that passed</button>` : ''}` : `<button class="pn-fold shut" data-fold="passed">${icon('check')}${okLine}${icon('chevron', 'chev')}</button>`) : ''}
    </section>`;
}

function reviewersHtml(p) {
  const rs = p.reviewers || [];
  if (!rs.length) return '';
  const label = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', COMMENTED: 'Commented' };
  return `<section class="pn-reviews"><h4>Reviews</h4><ul>${rs.map((r) => `<li class="rv-${r.state.toLowerCase()}">${who(r)}<span class="grow"></span><span class="pn-rv">${icon(r.state === 'APPROVED' ? 'check' : 'warn')}${label[r.state] || esc(r.state)}</span></li>`).join('')}</ul></section>`;
}

function talkHtml(id, p, canAsk) {
  const showBots = spellProp('panel.pr', 'bots') === true || fold(id, 'bots');
  const live = (p.threads || []).filter((t) => !t.outdated);
  const outdated = (p.threads || []).filter((t) => t.outdated);
  const notes = (p.notes || []).filter((n) => String(n.body || '').trim());
  const people = notes.filter((n) => !n.bot);
  const bots = notes.filter((n) => n.bot);
  const send = (i, kind) => (canAsk ? `<button class="ghost xs pn-send" data-a="send" data-kind="${kind}" data-i="${i}" title="Put it in the reply box for the agent">${icon('send')}<span>Send to agent</span></button>` : '');
  const thread = (t, i) => `
    <li class="pn-thread">
      <div class="pn-where-line"><code>${esc(t.path)}${t.line ? `:${t.line}` : ''}</code>${t.notes.length > 1 ? `<small>${t.notes.length - 1} repl${t.notes.length > 2 ? 'ies' : 'y'}</small>` : ''}</div>
      <div class="pn-note-h">${who(t.notes[0])}<span class="pn-ago">${t.notes[0].at ? ago(t.notes[0].at) : ''}</span></div>
      <div class="pn-text">${gist(t.notes[0].body)}</div>
      ${t.notes.length > 1 ? `<div class="pn-reply">${who(t.notes.at(-1))}<span class="pn-text">${gist(t.notes.at(-1).body, 200)}</span></div>` : ''}
      ${send(i, 'thread')}
    </li>`;
  const note = (n, i) => `
    <li class="pn-comment${n.bot ? ' bot' : ''}">
      <div class="pn-note-h">${who(n)}${n.kind === 'review' ? `<small>${n.state === 'APPROVED' ? 'approved' : n.state === 'CHANGES_REQUESTED' ? 'asked for changes' : 'reviewed'}</small>` : ''}<span class="pn-ago">${n.at ? ago(n.at) : ''}</span></div>
      <div class="pn-text">${gist(n.body)}</div>
      ${n.bot ? '' : send(i, 'note')}
    </li>`;
  if (!live.length && !outdated.length && !notes.length) return '';
  const idx = (n) => notes.indexOf(n);
  return `
    <section class="pn-talk"><h4>Conversation</h4>
      ${live.length ? `<ul>${live.map((t) => thread(t, p.threads.indexOf(t))).join('')}</ul>` : ''}
      ${people.length ? `<ul>${people.map((n) => note(n, idx(n))).join('')}</ul>` : ''}
      ${outdated.length ? (fold(id, 'outdated') ? `<ul class="pn-faded">${outdated.map((t) => thread(t, p.threads.indexOf(t))).join('')}</ul>` : `<button class="pn-fold shut" data-fold="outdated">${outdated.length} outdated thread${outdated.length > 1 ? 's' : ''}${icon('chevron', 'chev')}</button>`) : ''}
      ${bots.length ? (showBots ? `<ul class="pn-faded">${bots.map((n) => note(n, idx(n))).join('')}</ul>` : `<button class="pn-fold shut" data-fold="bots">${bots.length} from bots${icon('chevron', 'chev')}</button>`) : ''}
    </section>`;
}

function filesHtml(id, p) {
  const files = [...(p.files || [])].sort((a, b) => a.path.localeCompare(b.path));
  if (!files.length) return '';
  const all = fold(id, 'files');
  const shownFiles = all ? files : files.slice(0, 8);
  const more = (p.changedFiles || files.length) - shownFiles.length;
  return `
    <section class="pn-files"><h4>Files<span class="n">+${p.additions} −${p.deletions}</span></h4>
      <ul>${shownFiles.map((f) => `<li><a href="${esc(p.url)}/files" target="_blank" rel="noopener" title="${esc(f.path)}"><span class="pn-path">${esc(f.path)}</span></a><span class="add">+${f.additions}</span><span class="del">−${f.deletions}</span></li>`).join('')}</ul>
      ${more > 0 ? `<button class="pn-fold shut" data-fold="files">and ${more} more${icon('chevron', 'chev')}</button>` : ''}
    </section>`;
}

// The real shapes while the first answer comes: a title, the verdict, three checks, two comments.
const PR_SKEL = `
  <div class="pn-skel" aria-hidden="true">
    <i class="sk sk-t1"></i><i class="sk sk-t2"></i>
    <i class="sk sk-verdict"></i>
    <i class="sk sk-h"></i><i class="sk sk-row"></i><i class="sk sk-row"></i><i class="sk sk-row"></i>
    <i class="sk sk-h"></i><i class="sk sk-note"></i><i class="sk sk-note"></i>
  </div>`;

function paintPr() {
  const id = shown;
  const s = S.sessions.get(id);
  const box = $('.pn-pr', panel);
  const d = details.get(id);
  if (!d) loadPrs(id);
  const list = d?.prs || [];
  const canAsk = !!s && s.agent !== 'wisp' && !s.archived && !s.pending && !s.delegated;
  let html;
  if (!d && prsOf(s).length) html = PR_SKEL;
  else if (!list.length) {
    // Not shipped yet: what Ship it would take, and Ship it.
    const w = spaces.get(id);
    const st = w?.status;
    const bits = [st?.ahead && `${st.ahead} commit${st.ahead > 1 ? 's' : ''}`, st?.dirty && `${st.dirty} changed file${st.dirty > 1 ? 's' : ''}`].filter(Boolean).join(' and ');
    const can = s && shippable(s);
    html = `<div class="pn-empty">${icon('merge')}<p>${w?.worktree ? (bits ? `Not shipped yet: ${bits} on <code>${esc(w.worktree.branch)}</code>.` : `Nothing on <code>${esc(w.worktree.branch)}</code> to ship yet.`) : 'This task has no pull request.'}</p>${can ? `<button class="primary sm" data-a="ship">${icon('send')}Ship it…</button>` : ''}</div>`;
  } else {
    const i = Math.min(picked.get(id) || 0, list.length - 1);
    const p = list[i];
    const v = verdict(p, s);
    const open = list.filter((x) => x.state === 'OPEN');
    // On a phone the verdict and its button are a bar pinned at the bottom, where the reply box sits on Task.
    const bar = isStacked();
    const verdictHtml = `<div class="pn-verdict ${v.tone}${bar ? ' pn-bar' : ''}">${icon(VERDICT_ICON[v.tone] || 'info')}<span>${v.text}</span>${v.btn && (list.length === 1 || v.btn[0] !== 'merge') ? `<button class="${v.btn[2]} sm" data-a="${v.btn[0]}">${v.btn[0] === 'merge' ? icon('check') : icon('merge')}${v.btn[1]}</button>` : ''}</div>`;
    html = `
      ${list.length > 1 ? `<div class="pn-chips">${list.map((x, k) => `<button class="pn-chip${k === i ? ' on' : ''}" data-pick="${k}"><i class="pn-dot ${verdict(x, s).tone}"></i>${esc(x.repo || '')} #${x.number}</button>`).join('')}${open.length > 1 ? `<button class="ghost xs" data-a="merge">${icon('check')}<span>Merge all</span></button>` : ''}</div>` : ''}
      <div class="pn-title"><a href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(p.title || '')}">${esc(p.title || `PR #${p.number}`)}</a></div>
      <div class="pn-meta">#${p.number} · ${p.draft && p.state === 'OPEN' ? 'Draft' : STATE[p.state] || esc(p.state || '')}${p.branch ? ` · <code>${esc(p.branch)}</code> → <code>${esc(p.base || '')}</code>` : ''}${p.author ? ` · by ${esc(p.author)}` : ''}</div>
      ${bar ? '' : verdictHtml}
      ${p.error ? `<p class="pn-err">${icon('warn')}${esc(p.error)}</p>` : ''}
      ${p.checkList ? checksHtml(id, p, canAsk && p.state === 'OPEN') : ''}
      ${reviewersHtml(p)}
      ${talkHtml(id, p, canAsk)}
      ${filesHtml(id, p)}
      <footer class="pn-foot">
        <a class="ghost xs" href="${esc(p.url)}" target="_blank" rel="noopener">${icon('github')}<span>Open on GitHub</span></a>
        <span class="grow"></span>
        <span class="pn-upd" title="${d.error ? esc(d.error) : ''}">${d.error ? 'Couldn’t check just now' : `Checked ${ago(d.at) === 'now' ? 'just now' : `${ago(d.at)} ago`}`}</span>
        <button class="icon-btn xs pn-refresh" data-a="refresh" title="Check now" aria-label="Check now">${icon('replay')}</button>
      </footer>
      ${bar ? verdictHtml : ''}`;
  }
  if (box.dataset.h !== html) (box.innerHTML = html), (box.dataset.h = html);
}

// Ask to fix: the failing check and the end of its log, in the reply box (not sent: you look first).
async function askToFix(id, name, url, btn) {
  const p = currentPr(id);
  btn?.classList.add('busy');
  let log = '';
  try {
    log = (await api(`/sessions/${id}/check-log?url=${encodeURIComponent(url || '')}`)).log;
  } catch {}
  btn?.classList.remove('busy');
  const text = [`The \`${name}\` check failed on PR #${p?.number}${url ? ` (${url})` : ''}. Find out why, fix it and push.`, log ? `\n\`\`\`\n${log}\n\`\`\`` : ''].join('\n').trim();
  toReply(id, text);
}

function sendToAgent(id, kind, i) {
  const p = currentPr(id);
  if (!p) return;
  const quote = (b) => String(b || '').trim().split('\n').map((l) => `> ${l}`).join('\n');
  if (kind === 'thread') {
    const t = p.threads[i];
    return toReply(id, `${t.notes[0].author} commented on \`${t.path}${t.line ? `:${t.line}` : ''}\` in PR #${p.number}:\n\n${t.notes.map((x) => quote(`**${x.author}:** ${x.body}`)).join('\n>\n')}\n\nAddress it and push.`);
  }
  const n = p.notes[i];
  toReply(id, `${n.author} ${n.kind === 'review' ? 'reviewed' : 'commented on'} PR #${p.number}:\n\n${quote(n.body)}\n\nAddress it and push.`);
}

// Into the task's reply box: stacked, back to the Task segment so the box is in sight.
function toReply(id, text) {
  if (isStacked()) close();
  draftInto(id, text);
}

const currentPr = (id) => {
  const list = details.get(id)?.prs || [];
  return list[Math.min(picked.get(id) || 0, list.length - 1)];
};

// --- the ⋯ menu on the place line --------------------------------------------------------------

function placeMenu(anchor) {
  const id = shown;
  const s = S.sessions.get(id);
  const w = spaces.get(id);
  if (!w || w.error) return;
  const t = (S.config.terminals || []).find((x) => x.id === S.config.defaults?.terminal);
  const app = t && !['auto', 'wisp'].includes(t.id) ? `Open in ${t.label}` : 'Open in terminal app';
  const r = anchor.getBoundingClientRect();
  const menu = el(`
    <div class="menu" style="top:${r.bottom + 6}px;right:${innerWidth - r.right}px">
      <button data-a="path">${icon('copy')}Copy path</button>
      ${w.worktree && !w.gone ? `<button data-a="branch">${icon('branch')}Copy branch name</button>` : ''}
      ${MOBILE ? '' : `<button data-a="editor">${icon('folder')}Open ${w.worktree && !w.gone ? 'worktree' : 'folder'} in editor</button>`}
      ${w.shell?.app && !MOBILE ? `<button data-a="app">${icon('terminal')}${esc(app)}</button>` : ''}
    </div>`);
  menu.onclick = (e) => {
    const a = e.target.closest('button')?.dataset.a;
    close();
    if (a === 'path') (copy(w.dir), toast('Path copied'));
    if (a === 'branch') (copy(w.worktree.branch), toast('Branch name copied'));
    if (a === 'editor') import('./actions.js').then((m) => m.openInEditor(s, w.dir));
    if (a === 'app') openApp(id);
  };
  const close = popover(menu);
}

async function openApp(id) {
  try {
    await api(`/sessions/${id}/open-shell`, { method: 'POST', body: {} });
  } catch (err) {
    toastError(err);
  }
}

// --- wiring ----------------------------------------------------------------------------------

panel.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]')?.dataset.tab;
  if (tab) return pickTab(tab, { focus: true });
  if (e.target.closest('.pn-close')) return close();
  if (e.target.closest('.pn-more')) return placeMenu(e.target.closest('.pn-more'));
  if (e.target.closest('.pn-end')) return void endShell();
  const pick = e.target.closest('[data-pick]');
  if (pick) return (picked.set(shown, Number(pick.dataset.pick)), paintPr());
  const f = e.target.closest('[data-fold]')?.dataset.fold;
  if (f) {
    const set = folds.get(shown) || new Set();
    set.has(f) ? set.delete(f) : set.add(f);
    folds.set(shown, set);
    return paintPr();
  }
  const b = e.target.closest('[data-a]');
  const a = b?.dataset.a;
  const id = shown;
  if (a === 'restart') return void startShell(id, { restart: true });
  if (a === 'retry') return (spaces.delete(id), paintBody(), loadSpace(id));
  if (a === 'app') return void openApp(id);
  if (a === 'refresh') return void loadPrs(id, { quiet: false });
  if (a === 'merge') return void mergePr(id).then(() => loadPrs(id));
  if (a === 'fix') return (fixPr(id), setTimeout(() => loadPrs(id), 1500));
  if (a === 'ship') return void shipDialog(id);
  if (a === 'fix-check') return void askToFix(id, b.dataset.name, b.dataset.url, b);
  if (a === 'send') return sendToAgent(id, b.dataset.kind, Number(b.dataset.i));
});
// The tabs, as a tablist: arrows move between them.
$('.pn-tabs', panel).addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  pickTab(tabOf() === 'shell' ? 'pr' : 'shell', { focus: true });
});

function pickTab(tab, { focus = false } = {}) {
  if (tab === 'shell' && tabOf() !== 'shell' && shown) freshShell(shown);
  if (segOn()) seg.tab = tab;
  else (pref.tab = tab), keep();
  paintTabs();
  paintPlace();
  paintBody();
  if (tab === 'pr' && shown) loadPrs(shown);
  if (focus) (tab === 'shell' ? view.focus() : $(`[data-tab="${tab}"]`, panel).focus());
}

// Resizing: drag the inner edge; double-click forgets the drag.
const grip = $('.pn-grip', panel);
grip.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
  const left = document.body.classList.contains('side-right'); // the panel sits opposite the list
  const move = (ev) => {
    pref.w = Math.round(left ? ev.clientX : innerWidth - ev.clientX);
    paintWidth();
    relayout();
  };
  const up = () => {
    grip.removeEventListener('pointermove', move);
    document.body.classList.remove('resizing');
    keep();
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up, { once: true });
  grip.addEventListener('pointercancel', up, { once: true });
});
grip.addEventListener('dblclick', () => {
  delete pref.w;
  keep();
  paintWidth();
  relayout();
});

// It follows the main pane: another task, home, a crew thread. And the task's state: the agent
// finishing changes what's in the folder.
let lastHead = '';
new MutationObserver(() => {
  const h = $('#splitHead');
  const key = `${h.hidden} ${h.dataset.id} ${h.className}`;
  paintBtn();
  if (key === lastHead) return;
  const same = lastHead.split(' ')[1] === h.dataset.id;
  lastHead = key;
  if (same && shown && !panel.hidden) loadSpace(shown); // its state moved: the counts may have
  paint();
}).observe($('#splitHead'), { attributes: true, attributeFilter: ['data-id', 'hidden', 'class'], childList: true });
addEventListener('resize', () => {
  if (!panel.hidden) (paint(), relayout()); // crossing 1180px: the list makes way, or comes back
});
addEventListener('focus', () => {
  if (shown && !panel.hidden && tabOf() === 'pr') loadPrs(shown);
});
bus.on('spells', () => !panel.hidden && (paintWidth(), paintTabs(), paintBody()));
bus.on('panel:close', () => close());
// A task's own refresh: its PR pill moved (a check landed), so the PR tab looks again.
let lastPr = '';
bus.on('config', () => !panel.hidden && paintPlace());
setInterval(() => {
  if (panel.hidden || !shown || tabOf() !== 'pr') return;
  const key = JSON.stringify(prsOf(S.sessions.get(shown)).map((x) => [x.pr.state, x.pr.checks, x.pr.review, x.pr.conflict]));
  if (lastPr && key !== lastPr) loadPrs(shown);
  lastPr = key;
}, 4000);

// The task head's toggle and the PR pill (in the list's rows and the details column).
document.addEventListener('click', (e) => {
  if (e.target.closest('#splitHead .sh-panel')) return toggle();
  const segBtn = e.target.closest('#splitHead [data-seg]');
  if (segBtn) return segBtn.dataset.seg === 'task' ? close() : openPanel(null, segBtn.dataset.seg);
  const pill = e.target.closest('.pill.pr');
  const id = pill?.closest('.item[data-id]')?.dataset.id;
  if (id && isSplit()) setTimeout(() => openPanel(id, 'pr'));
});

// --- what the rest of the page calls ---------------------------------------------------------

export function openPanel(id, tab) {
  const go = () => {
    fresh = panel.hidden;
    if (isStacked()) seg = { id: target(), tab: tab || (seg?.id === target() && seg.tab) || 'shell' };
    else {
      if (tab) pref.tab = tab;
      pref.open = true;
      keep();
    }
    paint();
    if (tabOf() === 'shell') requestAnimationFrame(() => view.focus());
    if (tabOf() === 'pr' && shown) loadPrs(shown);
  };
  if (id && splitOpen() !== id) expand(id).then(go);
  else go();
}

// Put it away (stacked: back to the Task segment).
export function close() {
  if (isStacked()) seg = null;
  else (pref.open = false), keep();
  view.blur();
  paint();
  // Squeezed out by the panel, the list comes back with it (split.js reads panel-open).
}

export function toggle() {
  if (panel.hidden) openPanel(null);
  else close();
}

// ⌃`: into the shell from anywhere, and from the shell back to the reply box.
export function shellKey() {
  const id = shown || target() || S.focus;
  if (!id) return;
  if (!panel.hidden && tabOf() === 'shell' && $('.pn-shell', panel).contains(document.activeElement)) return void $('.reply', S.nodes.get(id)?.card)?.focus();
  openPanel(id, 'shell');
}

// For the menus: the items' names, the same everywhere.
export const reviewLabel = (s) => {
  const prs = prsOf(s);
  return !prs.length ? null : prs.length > 1 ? 'Review PRs' : `Review PR #${prs[0].pr.number}`;
};
export const shellItem = (id) => `<button data-a="shell">${icon('shell')}Open shell${keyHint('⌃`')}</button>`;
export const panelLabel = () => `${panel.hidden ? 'Show' : 'Hide'} side panel`;

queueMicrotask(paint);
