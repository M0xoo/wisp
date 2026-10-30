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
import { isSplit, isStacked } from './split.js';
import { agentName } from './runners.js';
import { slotHtml, spellProp } from './spells.js';
import { ask } from '../ui/confirm.js';
import { connect, SCREEN_HTML, termState, TermView, TOUCH } from './term-view.js';
import { takeOver } from './actions.js';

// --- the panel ----------------------------------------------------------------------------

let panel = null;
let cur = null; // { id, screen, es, ... } the terminal shown
const terms = new Map(); // id -> terminal state, kept while it runs so reopening is instant
const shut = new Set(); // tasks whose terminal you put away with Back, until you leave the task
const stale = new Set(); // terminal sessions resumed because their terminal had ended unseen

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
// Also after each paint of the main pane (split.js): on a cold load the task opens before the list
// has it, and it counts as opened once it does.
let seen = null; // the task open in the main pane
export function follow() {
  if (!isSplit()) return;
  const h = $('#splitHead');
  const id = (!h.hidden && h.dataset.id) || null;
  if (id && !S.sessions.get(id)) return;
  const opened = id !== seen;
  if (opened) {
    if (seen) shut.delete(seen);
    seen = id;
  }
  const shown = panel && !panel.hidden;
  if (shown && cur.id !== id) return hide();
  if (shown) return place();
  const t = id && terms.get(id);
  const s = id && S.sessions.get(id);
  if (s?.pending) return; // still starting up: the real task opens its terminal (launcher.js)
  if (s?.tui) {
    // A terminal session opens on its CLI: one whose terminal ended resumes it.
    if (s.term) {
      if (!t || t.code === null || tuiView?.cur !== t) tuiShow(id);
    } else if (opened && !s.archived) takeOver(id);
    return;
  }
  if (id && !shut.has(id) && s?.term && (!t || t.code === null)) openTerm(id);
}
new MutationObserver(follow).observe($('#splitHead'), { attributes: true, attributeFilter: ['data-id', 'hidden'] });

export function hide() {
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  document.body.classList.remove('term-open');
  view.blur();
}

// --- a terminal session's terminal ---------------------------------------------------------
// Babysitting mode (Settings → General): the terminal is the task's own content, full width inside
// its body (which split.js keeps on the stage, through every resize): no panel, head or End; the
// agent's /exit ends it, and a key then resumes it. One at a time, moved to the task that's open.

const isTui = (id) => !!S.sessions.get(id)?.tui;
let tuiHost = null;
let tuiView = null;

// The terminal's box, in task id's body. Moved only when another task's body is to hold it.
function tuiMount(id) {
  const body = $('.it-body', S.nodes.get(id)?.card);
  if (!body) return null;
  if (!tuiHost) {
    tuiHost = el(`<div class="tui-term">${SCREEN_HTML}</div>`);
    tuiView = new TermView(tuiHost, {
      shown: () => tuiHost.isConnected && tuiHost.offsetParent !== null,
      onEndedKey: () => {
        if (tuiView.cur) takeOver(tuiView.cur.id);
      },
    });
  }
  if (tuiHost.parentNode !== body) body.append(tuiHost);
  tuiHost.dataset.id = id;
  tuiHost.classList.toggle('touch', TOUCH.matches || MOBILE);
  return tuiHost;
}

function tuiShow(id, { starting = false } = {}) {
  if (!tuiMount(id)) return null;
  let t = terms.get(id);
  if (t && t.code !== null && !starting && !S.sessions.get(id)?.term) return (tuiView.show(t), t); // ended: its last screen, a key resumes
  if (t && t.code !== null) (terms.delete(id), (t = null));
  t = termFor(id);
  $('.tm-wait-l', tuiHost).textContent = `Opening the session in ${agentName(S.sessions.get(id)?.agent)}…`;
  tuiView.show(t);
  tuiView.focus();
  if (!starting && !t.es) connect(t);
  return t;
}

// The cell grid a terminal session started now gets: its terminal fills the task's body, which
// lies on #splitStage's box. Sent with the launch, so the CLI draws its first screen at the size
// it's shown at rather than reflowing a 100×30 one ({} when there's no pane to measure). From
// home the stage is hidden: its box is the main pane's under where the task's header goes.
let sizer = null;
export function launchSize() {
  if (!sizer) {
    const host = el(`<div class="tui-term tm-sizer" aria-hidden="true" inert>${SCREEN_HTML}</div>`);
    document.body.append(host);
    sizer = new TermView(host);
  }
  const main = $('#splitMain').getBoundingClientRect();
  const head = $('#splitHead').offsetHeight || (isStacked() ? 57 : 60);
  Object.assign(sizer.root.style, { left: `${main.left}px`, top: `${main.top + head}px`, width: `${main.width}px`, height: `${main.height - head}px` });
  sizer.root.classList.toggle('touch', TOUCH.matches || MOBILE);
  return sizer.size();
}

// --- one terminal ---------------------------------------------------------------------------

function termFor(id) {
  let t = terms.get(id);
  if (t) return t;
  t = termState(id, `/sessions/${id}/term`, {
    onHello: () => {
      t.helloAt = Date.now();
      if (cur === t) paintHead();
    },
    onExit: (_, code) => {
      // A terminal session whose terminal was already over when this page attached (the cached
      // list still said it was open): it's resumed, once, rather than showing its last screen.
      if (isTui(id) && !stale.has(id) && Date.now() - (t.helloAt || 0) < 500) {
        stale.add(id);
        terms.delete(id);
        const s = S.sessions.get(id);
        if (s) delete s.term;
        return void takeOver(id);
      }
      t.screen.write(`\r\n\x1b[2m[The ${isTui(id) ? 'session' : 'terminal'} ended${code ? ` (exit ${code})` : ''}. Press any key to ${isTui(id) ? 'resume it' : 'go back'}.]\x1b[0m`);
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
  if (isTui(id)) return tuiShow(id, { starting });
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
  if (isTui(id) && tuiMount(id)) return tuiView.size();
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
