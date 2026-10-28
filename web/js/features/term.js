// Take over in the page: the agent's own TUI in a terminal inside wisp, for computers with no
// terminal app to open (a wisp Grid, a server, the phone app). The server runs it (server/pty.js)
// and streams its output from /sessions/:id/term; term-emu.js keeps the screen.
//
// One panel, for one task at a time. In split view it lies over the open task's reading area (the
// task's header stays above it); in the feed it's a sheet; on a phone it fills the screen with a
// row of the keys a phone keyboard lacks. Going back hides it: the agent carries on, the card says
// "In terminal", and opening it again shows the same screen. Leaving the task (another task, home,
// a crew member) puts it away too, and coming back to the task brings it back. It ends when the
// agent exits.

import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, el, icon } from '../core/dom.js';
import { MOBILE, S } from '../core/state.js';
import { esc } from '../md.js';
import { toastError } from '../ui/toast.js';
import { isSplit } from './split.js';
import { agentName } from './runners.js';
import { slotHtml, spellProp } from './spells.js';
import { ask } from '../ui/confirm.js';
import { connect, SCREEN_HTML, termState, TermView, TOUCH } from './term-view.js';

// --- the panel ----------------------------------------------------------------------------

let panel = null;
let cur = null; // { id, screen, es, ... } the terminal shown
const terms = new Map(); // id -> terminal state, kept while it runs so reopening is instant
const shut = new Set(); // tasks whose terminal you put away with Back, until you leave the task

let view = null;

function build() {
  panel = el(`
    <section class="term" id="term" hidden>
      <div class="tm-scrim"></div>
      <div class="tm-box">
        <header class="tm-head">
          <button class="icon-btn tm-back" title="Back to the task (the agent keeps going)" aria-label="Back">${icon('back')}</button>
          <span class="tm-name"><b class="tm-title"></b><small class="tm-sub"></small></span>
          <span class="tm-acts"></span>
          <button class="ghost xs tm-end" title="End the terminal and the agent in it">${icon('stop')}<span>End</span></button>
        </header>
        ${SCREEN_HTML}
      </div>
    </section>`);
  document.body.append(panel);
  $('.tm-back', panel).onclick = () => {
    dismiss();
  };
  $('.tm-scrim', panel).onclick = () => {
    dismiss();
  };
  $('.tm-end', panel).onclick = () => {
    end();
  };
  view = new TermView(panel, { shown: () => !panel.hidden, onEndedKey: () => hide() });
  // The phone keyboard covers the bottom of the page: keep the panel (and its keys) above it.
  visualViewport?.addEventListener('resize', place);
  visualViewport?.addEventListener('scroll', place);
  bus.on('spells', () => cur && !panel.hidden && (paintHead(), view.fit()));
}

// Where the panel goes: over the open task in split view, else a sheet (a phone: the whole screen).
function place(id = cur?.id) {
  if (!panel || panel.hidden) return;
  panel.classList.toggle('over-stage', isSplit() && !$('#splitStage').hidden && $('#splitHead').dataset.id === id);
  panel.classList.toggle('touch', TOUCH.matches || MOBILE);
  const vv = visualViewport;
  panel.style.setProperty('--vv-h', vv ? `${Math.round(vv.height)}px` : '100dvh');
  panel.style.setProperty('--vv-top', vv ? `${Math.round(vv.offsetTop)}px` : '0px');
}

function paintHead() {
  const s = S.sessions.get(cur.id) || S.full.get(cur.id) || {};
  panel.dataset.id = cur.id;
  $('.tm-title', panel).textContent = s.title || 'Terminal';
  $('.tm-sub', panel).textContent = cur.code !== null ? 'Ended' : cur.ready ? `${agentName(s.agent)} · in a terminal` : 'Starting…';
  $('.tm-wait-l', panel).textContent = `${cur.ready ? 'Resuming' : 'Opening'} the session in ${agentName(s.agent)}…`;
  $('.tm-end', panel).hidden = cur.code !== null;
  const acts = $('.tm-acts', panel);
  const html = slotHtml('term.head', s);
  if (acts.dataset.h !== html) (acts.innerHTML = html), (acts.dataset.h = html);
  const fs = spellProp('term', 'fontSize');
  panel.style.setProperty('--tm-fs', fs ? `${fs}px` : '');
}

function show(t) {
  if (!panel) build();
  cur = t;
  panel.hidden = false;
  document.body.classList.add('term-open');
  place();
  paintHead();
  view.show(t);
  view.focus();
}

// Back: put it away while you read the task (it comes back once you leave the task and return).
function dismiss() {
  if (cur) shut.add(cur.id);
  hide();
}

// Split view: the panel goes with its task. Another task, home or a crew member's thread in the
// main pane puts it away; opening the task again while its terminal runs shows it over it again.
let seen = null; // the task open in the main pane
function follow() {
  if (!isSplit()) return;
  const h = $('#splitHead');
  const id = (!h.hidden && h.dataset.id) || null;
  if (id !== seen) {
    if (seen) shut.delete(seen);
    seen = id;
  }
  const shown = panel && !panel.hidden;
  if (shown && cur.id !== id) return hide();
  if (shown) return place();
  const t = id && terms.get(id);
  if (id && !shut.has(id) && S.sessions.get(id)?.term && (!t || t.code === null)) openTerm(id);
}
new MutationObserver(follow).observe($('#splitHead'), { attributes: true, attributeFilter: ['data-id', 'hidden'] });

export function hide() {
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  document.body.classList.remove('term-open');
  view.blur();
}

// --- one terminal ---------------------------------------------------------------------------

function termFor(id) {
  let t = terms.get(id);
  if (t) return t;
  t = termState(id, `/sessions/${id}/term`, {
    onHello: () => cur === t && paintHead(),
    onExit: (_, code) => {
      t.screen.write(`\r\n\x1b[2m[The terminal ended${code ? ` (exit ${code})` : ''}. Press any key to go back.]\x1b[0m`);
      if (cur === t) paintHead();
    },
  });
  terms.set(id, t);
  return t;
}

// --- what the rest of the page calls ---------------------------------------------------------

// Show task id's terminal, connecting to it if this page hasn't yet. starting: the server is still
// opening it (the take over is on its way).
export function openTerm(id, { starting = false } = {}) {
  shut.delete(id);
  let t = terms.get(id);
  if (t && t.code !== null) (terms.delete(id), (t = null));
  t = termFor(id);
  show(t);
  if (!starting && !t.es) connect(t);
  return t;
}

// The take over answered: stream it, or (it went to a terminal app after all) put the panel away.
export function termStarted(id, inline) {
  const t = terms.get(id);
  if (!inline) {
    if (t && !t.es) (terms.delete(id), cur === t && hide());
    return;
  }
  connect(t || openTerm(id, { starting: true }));
}

// The take over failed: put back what it showed.
export function termFailed(id) {
  const t = terms.get(id);
  if (t && !t.es) {
    terms.delete(id);
    if (cur === t) hide();
  }
}

// The cell size a new terminal would get, so the server starts it at the right size.
export function termSize(id) {
  if (!panel) build();
  const was = panel.hidden;
  panel.hidden = false;
  panel.style.visibility = 'hidden';
  place(id);
  const size = view.size();
  panel.hidden = was;
  panel.style.visibility = '';
  return size;
}

async function end() {
  const t = cur;
  if (!t || (t.code === null && !(await ask('End the terminal?\n\nThe agent in it stops.', { ok: 'End terminal', danger: true })))) return;
  hide();
  terms.delete(t.id);
  t.es?.close();
  t.code = 0;
  try {
    await api(`/sessions/${t.id}/term`, { method: 'DELETE' });
  } catch (err) {
    toastError(err);
  }
}

// The card's "In terminal" pill opens it. In the feed, instead of the head's own click (which
// folds the card); in split view, after it: the task opens in the main pane, the terminal over it.
document.addEventListener(
  'click',
  (e) => {
    const p = e.target.closest?.('[data-term]');
    if (!p) return;
    const id = p.dataset.term;
    if (isSplit() && p.closest('#feed')) return void setTimeout(() => openTerm(id));
    e.stopPropagation();
    e.preventDefault();
    openTerm(id);
  },
  true,
);

export const termPill = (s) => (s.term ? `<button class="pill st-term" data-term="${esc(s.id)}" title="Taken over in a terminal: open it">${icon('terminal')}In terminal</button>` : '');
