// A scheduled task or reminder that hasn't started yet (a plan, later.js), opened from its row in
// Scheduled: Wait until the reset near the usage limit and Start later both leave one. It opens in
// the main pane like the Org page (stacked: a page over the list, with Back), and is where you change
// what it will say: the prompt is a box, saved when you leave it (Save, ⌘Enter, clicking away,
// Start now, closing the page). Start now, Change time… and Delete are the row menu's, by the same
// names. When it starts while open, its task takes the page.
//
// Spells reach it through spell-schema.js: the plan.head slot, the plan.* parts.

import { esc } from '../md.js';
import { $, $$, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { collapse, renderFeed, reveal } from './feed.js';
import { goBack, isSplit, isStacked, splitOpen } from './split.js';
import { leaveCrew } from './crew.js';
import { leaveOrg } from './org.js';
import { autosize } from './attachments.js';
import { projectLabel } from './places.js';
import { MODES, modelBadge } from './runners.js';
import { slotHtml } from './spells.js';
import { aheadLabel, cancelPlan, editPlan, movePlan, plans, startPlan, timeMenu, whenTip } from './later.js';

S.planOpen = null; // not kept over a reload: by then it may well have started
let view = null;
let starting = null; // Start now pressed: the page stays until its task opens (or it's refused)

export function openPlan(id) {
  leaveCrew();
  leaveOrg();
  for (const x of [...S.open]) collapse(x);
  flush();
  S.planOpen = id;
  renderFeed(); // the row's selection, then the pane (paintSplit → paintPlan)
  requestAnimationFrame(() => {
    const ta = view && $('.pv-text', view);
    if (!ta || isStacked()) return;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });
}

export function leavePlan() {
  if (!S.planOpen) return;
  flush();
  S.planOpen = null;
}

export const planShown = () => isSplit() && !!S.planOpen && !splitOpen() && !S.crewOpen && !S.orgOpen;
const current = () => plans().find((p) => p.id === S.planOpen) || (starting?.id === S.planOpen ? starting : null);
const isTask = (p) => p.kind === 'task';
const textOf = (p) => (isTask(p) ? p.body.prompt : p.text);

// What's in the box and not saved yet goes now. Resolves once the server has it (or refused).
function flush() {
  const ta = view && $('.pv-text', view);
  const p = ta && plans().find((x) => x.id === view.dataset.plan);
  if (!p || ta.value.trim() === textOf(p).trim() || !ta.value.trim()) return Promise.resolve(true);
  return editPlan(p, ta.value.trim());
}

// --- painting ---------------------------------------------------------------------------------------

const WIDE = 860; // the details beside the box from this pane width (a task's DETAILS_PANE)
const WIDE_H = 520;

function build() {
  const node = el(`<section class="plan-view" id="planView" hidden>
      <header class="split-head pv-head"></header>
      <div class="pv-scroll">
        <div class="pv-cols">
          <div class="pv-box">
            <textarea class="pv-text" rows="3" spellcheck="true" aria-label="Prompt"></textarea>
            <div class="pv-bar">
              <span class="pv-hint"></span>
              <span class="pv-save-acts" hidden>
                <button class="ghost sm pv-revert">Undo changes</button>
                <button class="ghost sm pv-save">Save</button>
              </span>
            </div>
          </div>
          <aside class="it-bar pv-side">
            <div class="it-props"></div>
            <div class="it-actions"></div>
          </aside>
        </div>
      </div>
    </section>`);
  const ta = $('.pv-text', node);
  const fit = autosize(ta, 520);
  ta.addEventListener('input', paintDirty);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      flush().then(paintDirty);
    }
  });
  ta.addEventListener('blur', (e) => {
    if (!node.contains(e.relatedTarget)) flush().then(paintDirty);
  });
  node.addEventListener('click', onClick);
  // Its own width, not the task stage's (hidden while this shows): the details column from 860px.
  new ResizeObserver(([e]) => node.classList.toggle('wide', e.contentRect.width >= WIDE && e.contentRect.height >= WIDE_H)).observe(node);
  node.fit = fit;
  return node;
}

// Save and Undo changes only while there's something unsaved; the hint says how it saves.
function paintDirty() {
  const p = current();
  if (!view || !p) return;
  const ta = $('.pv-text', view);
  const empty = !ta.value.trim();
  const dirty = ta.value.trim() !== textOf(p).trim();
  $('.pv-save-acts', view).hidden = !dirty;
  $('.pv-save', view).disabled = empty;
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
  $('.pv-hint', view).textContent = empty
    ? isTask(p) ? 'A task needs a prompt. Delete removes it' : 'A reminder needs something to remind you of'
    : dirty ? `${mod}Enter saves · so does clicking away` : `You can edit it until it ${isTask(p) ? 'starts' : 'goes off'}`;
}

export function paintPlan() {
  // Something else took the pane (a task, a member, the Org page): the plan goes.
  if (S.planOpen && isSplit() && (splitOpen() || S.crewOpen || S.orgOpen)) leavePlan();
  const on = planShown();
  for (const r of $$('#feed .plan-row')) r.classList.toggle('sel', on && r.dataset.plan === S.planOpen);
  const p = on && current();
  if (on && !p) {
    // It started (or was deleted elsewhere): its task takes the page, if there is one.
    const id = S.planOpen;
    S.planOpen = null;
    const s = [...S.sessions.values()].find((x) => x.origin?.kind === 'later' && x.origin.id === id);
    if (s) queueMicrotask(() => reveal(s.id));
    else queueMicrotask(goBack);
  }
  if (!p) {
    if (view) view.hidden = true;
    return;
  }
  view ||= build();
  if (view.parentNode !== $('#splitMain')) $('#splitMain').append(view);
  view.hidden = false;
  const ta = $('.pv-text', view);
  // Another plan, or this one changed elsewhere while you weren't typing in it: the box follows.
  if (view.dataset.plan !== p.id || (document.activeElement !== ta && view.dataset.text !== textOf(p))) {
    ta.value = textOf(p);
    view.dataset.text = textOf(p);
    view.fit();
  }
  view.dataset.plan = p.id;
  paintHead(p);
  paintSide(p);
  paintDirty();
}

// A task's header: its title (the prompt's first line), the plan.head slot, Close (stacked: Back).
function paintHead(p) {
  const stacked = isStacked();
  const task = isTask(p);
  const html = `<div class="sh-row">
      ${stacked ? `<button class="icon-btn sh-back" data-a="close" title="Back to tasks" aria-label="Back to tasks">${icon('back')}</button>` : `<span class="q-dot auto">${icon(task ? 'clock' : 'bell')}</span>`}
      <h2 class="sh-title" title="${esc(textOf(p))}">${esc(task ? p.title : p.text)}</h2>
      <span class="sh-acts">${slotHtml('plan.head', null)}${stacked ? '' : `<button class="icon-btn sh-close" data-a="close" title="Close: back to New task (Esc)" aria-label="Close">${icon('x')}</button>`}</span>
    </div>`;
  const h = $('.pv-head', view);
  if (h.dataset.h !== html) (h.innerHTML = html), (h.dataset.h = html);
}

// The details column, as a task's: one fact a row (when, harness, mode, project, files), then the
// actions by the row menu's names. Stacked, a row of facts and a row of actions over the box.
function paintSide(p) {
  const b = p.body || {};
  const task = isTask(p);
  const project = task && S.config.projects?.find((x) => x.path === b.cwd);
  const mode = task && MODES.find((m) => m.id === b.mode);
  const props = `<span class="pill later-pill pv-when" title="${esc(whenTip(p.at))}">${icon(task ? 'clock' : 'bell')}<span>${task ? 'Starts' : 'At'} ${esc(aheadLabel(p.at))}</span></span>
    ${task ? modelBadge(b.agent || 'auto', b.model, b.effort, null, b.account) : ''}
    ${mode ? `<span class="pv-fact pv-mode m-${mode.id}" title="${esc(mode.hint)}">${icon(mode.icon)}<span>${esc(mode.label)}</span></span>` : ''}
    ${project ? projectLabel({ project: project.name }) : task && b.scratch ? `<span class="pv-fact">${icon('folder')}<span>Scratch folder</span></span>` : ''}
    ${task && b.attachments?.length ? `<span class="pv-fact">${icon('clip')}<span>${b.attachments.length === 1 ? '1 file goes with it' : `${b.attachments.length} files go with it`}</span></span>` : ''}
    ${p.from?.title ? `<span class="pv-fact">${icon('file')}<span>${esc(p.from.title)}</span></span>` : ''}`;
  const side = $('.pv-side', view);
  side.className = `it-bar pv-side c-${project?.color || 'slate'}`;
  const pr = $('.it-props', side);
  if (pr.dataset.h !== props) (pr.innerHTML = props), (pr.dataset.h = props);
  const acts = `<button class="ghost xs pv-now" data-a="now">${icon(task ? 'play' : 'bell')}<span>${task ? 'Start now' : 'Remind me now'}</span></button>
    <button class="ghost xs" data-a="time" title="${task ? 'Change start time…' : 'Change time…'}">${icon('clock')}<i class="it-lbl">${task ? 'Change start time…' : 'Change time…'}</i></button>
    <button class="ghost xs" data-a="delete" title="${task ? 'Delete' : 'Delete reminder'}">${icon('trash')}<i class="it-lbl">${task ? 'Delete' : 'Delete reminder'}</i></button>`;
  const ac = $('.it-actions', side);
  if (ac.dataset.h !== acts) (ac.innerHTML = acts), (ac.dataset.h = acts);
}

async function onClick(e) {
  const p = current();
  const b = e.target.closest('button');
  if (!p || !b) return;
  const ta = $('.pv-text', view);
  if (b.classList.contains('pv-save')) return flush().then(paintDirty);
  if (b.classList.contains('pv-revert')) return (ta.value = textOf(p)), view.fit(), paintDirty(), ta.focus();
  const a = b.dataset.a;
  if (a === 'close') return goBack();
  if (a === 'time') return timeMenu(b, { back: b, pick: (at) => movePlan(p, at) });
  if (a === 'delete') {
    S.planOpen = null; // what you typed goes with it
    cancelPlan(p);
    return goBack();
  }
  if (a === 'now') {
    if (!(await flush())) return;
    starting = current() || p;
    const ok = await startPlan(starting);
    starting = null;
    if (!ok) renderFeed();
  }
}
