// Split view: the task list in a sidebar, the open task in the main pane. The cards are the feed's
// own (same nodes, same code paths): in split view at most one is open, its head stays in the
// sidebar and its body is laid over the main pane (position: fixed to #splitStage's box), so
// everything that looks things up through the card keeps working. Home, with nothing open, is the
// prompt box. Below SPLIT_MIN_WIDTH the page falls back to the feed; the setting stays.
//
// Spells reach all of it through spell-schema.js: the `view` setting, the sidebar.top and
// split.head slots, the sidebar / split.* parts and their props (width, side, details, readWidth,
// greeting).

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, $$, icon } from '../core/dom.js';
import { ago, STATUS_LABEL } from '../core/format.js';
import { load, MOBILE, S, save } from '../core/state.js';
import { SPLIT_MIN_WIDTH } from '../spell-schema.js';
import { toast, tryApi } from '../ui/toast.js';
import { collapse, expand, groups, headPills, renderFeed, setFocus } from './feed.js';
import { stage } from './scroll.js';
import { renderBody } from './turns.js';
import { slotHtml, spellProp } from './spells.js';

const wide = matchMedia(`(min-width: ${SPLIT_MIN_WIDTH}px)`);
const SIDE_W = 340;
const READ_W = 860;

export const isSplit = () => document.body.classList.contains('split');
// The layout asked for: the setting (yours, or a spell's while it's on), else the last one seen,
// so the first paint before /config lands is already the right one.
export const viewPref = () => S.config.defaults?.view || load('wisp.view', 'feed');

// The task open in the main pane (null on home).
export const splitOpen = () => (isSplit() ? [...S.open].find((id) => S.nodes.get(id)?.card.isConnected) || null : null);
// The open task's body: in split view it's the main pane's scroller.
export const splitBody = () => (isSplit() ? $('#feed .item.open > .it-body') : null);
export const sidebar = $('#feedWrap');

export function applyView() {
  save('wisp.view', viewPref());
  paintProps();
  paintViewBtn();
  // The phone app always gets the feed (its switchers are hidden), even on a wide tablet.
  const want = viewPref() === 'split' && wide.matches && !MOBILE;
  if (want !== isSplit()) (want ? enter : leave)();
  else paintSplit();
}

export async function setView(v) {
  const was = viewPref();
  if (v === was) return;
  const by = S.config.lockedBy?.view;
  if (by) return toast(`${icon('wizard')} The layout is set by the spell <b>${esc(by.name)}</b>. Turn it off in Settings → Spells to change it.`);
  S.config.defaults.view = v;
  applyView();
  if (v === 'split' && !wide.matches) toast(`Split view needs a window at least ${SPLIT_MIN_WIDTH}px wide: it starts once there's room.`);
  const ok = await tryApi(() => api('/config', { method: 'PATCH', body: { defaults: { view: v } } }));
  if (!ok) {
    S.config.defaults.view = was;
    applyView();
  }
  bus.emit('view');
}
export const toggleView = () => {
  if (!MOBILE) setView(viewPref() === 'split' ? 'feed' : 'split');
};

// Nothing open: the prompt box, focused.
export function goHome({ focus = true } = {}) {
  for (const id of [...S.open]) collapse(id);
  paintSplit();
  if (focus) $('#prompt')?.focus({ preventScroll: true });
}

// --- entering and leaving ----------------------------------------------------------------------

const home = $('#splitHome');
const launchSlot = $('#launchSlot');
const feedTop = $('#spFeedTop');

function enter() {
  // One task at a time: keep the focused one if it's open, else the first.
  const keep = S.open.has(S.focus) ? S.focus : [...S.open][0];
  for (const id of [...S.open]) if (id !== keep) collapse(id);
  stage.scrollTop = 0;
  const box = $('#launcher');
  box?.classList.remove('docked');
  launchSlot.style.height = '';
  $('.sh-launch', home).append(launchSlot, feedTop);
  document.body.classList.add('split');
  $('#splitMain').hidden = false;
  $('#splitGrip').hidden = false;
  $('#splitTop').hidden = false;
  if (S.sessions.size) renderFeed(); // heads show their preview line again, open or not
  paintSplit();
  const card = S.nodes.get(splitOpen())?.card;
  card?.scrollIntoView({ block: 'nearest' });
}

function leave() {
  const open = splitOpen();
  sidebar.insertBefore(launchSlot, $('#feedHead'));
  $('#feedHead').after(feedTop);
  document.body.classList.remove('split');
  $('#splitMain').hidden = true;
  $('#splitGrip').hidden = true;
  $('#splitTop').hidden = true;
  if (S.sessions.size) renderFeed();
  const card = open && S.nodes.get(open)?.card;
  if (card) requestAnimationFrame(() => card.scrollIntoView({ block: 'start' }));
}

// --- each task keeps its place ------------------------------------------------------------------

// Where each task was scrolled to when it closed, so going back to it lands on the same spot. Held
// by the turn at the top of the pane (and how far into it), so a turn landing meanwhile or older
// ones folding away don't shift what was being read. At the end: back to the end, new turns and all.
const places = new Map();

export function keepPlace(id) {
  const n = S.nodes.get(id);
  const body = n?.body;
  if (!isSplit() || !body?.isConnected || !body.querySelector('.turns')) return;
  if (body.scrollTop < 1) return places.delete(id);
  const end = body.scrollTop + body.clientHeight >= body.scrollHeight - 4;
  const top = body.getBoundingClientRect().top + ($('.it-bar', body)?.offsetHeight || 0);
  const turn = $$('.turn', body).find((t) => t.getBoundingClientRect().bottom > top);
  places.set(id, { end, turn: turn?.dataset.turn, dy: turn ? turn.getBoundingClientRect().top - top : 0, top: body.scrollTop, showAll: n.showAll });
}

// Once the task's body has rendered on opening it. Used once: a later re-open keeps its own place.
export function backToPlace(id) {
  const p = places.get(id);
  const n = S.nodes.get(id);
  const body = n?.body;
  if (!p || !isSplit() || splitOpen() !== id || !body?.querySelector('.turns')) return;
  places.delete(id);
  // It was reading turns behind "Show earlier": show them again.
  if (p.showAll && !n.showAll) (n.showAll = true), renderBody(id, { fresh: false });
  if (p.end) return (body.scrollTop = body.scrollHeight);
  const turn = p.turn && $(`.turn[data-turn="${p.turn}"]`, body);
  if (!turn) return (body.scrollTop = p.top);
  const top = body.getBoundingClientRect().top + ($('.it-bar', body)?.offsetHeight || 0);
  body.scrollTop += turn.getBoundingClientRect().top - top - p.dy;
}

// --- painting ----------------------------------------------------------------------------------

// Home or the open task's header, whichever applies. Cheap: called after every feed render.
export function paintSplit() {
  if (!isSplit()) return;
  const id = splitOpen();
  const s = id && S.sessions.get(id);
  home.hidden = !!s;
  $('#splitHead').hidden = !s;
  $('#splitStage').hidden = !s;
  $('#splitNew').classList.toggle('on', !s);
  const side = slotHtml('sidebar.top');
  const host = $('#spSide');
  if (host.dataset.h !== side) (host.innerHTML = side), (host.dataset.h = side);
  if (s) paintHead(s);
  else paintHome();
  measure();
}

// The open task's header: its title and everything the card head says about it, with room to read.
export function paintHead(s) {
  const h = $('#splitHead');
  if (!isSplit() || splitOpen() !== s.id || h.querySelector('[contenteditable="true"]')) return;
  const pill =
    s.state === 'waiting'
      ? `<span class="pill st-waiting"><i></i>Asking</span>`
      : s.state === 'review'
        ? `<span class="pill st-${s.status}"><i></i>${STATUS_LABEL[s.status] || 'Done'}</span>`
        : s.state === 'running'
          ? `<span class="pill st-running"><i></i>Working</span>`
          : '';
  h.dataset.id = s.id;
  h.className = `split-head c-${s.color} st-${s.state}`;
  const html = `
    <div class="sh-row">
      <span class="q-dot ${s.state === 'running' ? 'live' : ''} ${s.state === 'waiting' ? 'waiting' : ''}"></span>
      <h2 class="sh-title" title="Rename (M)">${esc(s.title)}</h2>
      <span class="sh-acts">${slotHtml('split.head', s)}<button class="icon-btn sh-close" title="Close: back to New task (Esc)" aria-label="Close">${icon('x')}</button></span>
    </div>
    <div class="sh-meta">${headPills(s, pill)}<span class="q-time">${ago(s.updatedAt)}</span></div>`;
  if (h.dataset.h !== html) (h.innerHTML = html), (h.dataset.h = html);
}

function paintHome() {
  $('.sh-hello', home).textContent = spellProp('split.home', 'greeting') || 'What should wisp do next?';
  // The tasks waiting on you, one click each: home doubles as the inbox.
  const all = groups().needs; // the sidebar's Needs you, in its order
  const needs = all.slice(0, 5);
  const html = needs.length
    ? `<h4>Needs you<span class="n">${all.length > needs.length ? `${needs.length} of ${all.length}` : all.length}</span></h4>${needs
        .map(
          (s) => `<button class="sh-task c-${s.color}" data-id="${s.id}">
            <span class="q-dot ${s.state === 'waiting' ? 'waiting' : ''}"></span>
            <span class="sh-t">${esc(s.title)}</span>
            <span class="sh-s ${s.state === 'waiting' ? 'asking' : ''}">${s.state === 'waiting' ? 'Asking' : esc(STATUS_LABEL[s.status] || 'Done')}</span>
            <span class="q-time">${ago(s.updatedAt)}</span>
          </button>`,
        )
        .join('')}`
    : '';
  const next = $('.sh-next', home);
  if (next.dataset.h !== html) (next.innerHTML = html), (next.dataset.h = html);
  next.hidden = !html;
  $('.sh-keys', home).innerHTML = '<kbd>J</kbd><kbd>K</kbd> move through tasks · <kbd>↵</kbd> open · <kbd>E</kbd> done · <kbd>Esc</kbd> back here · <kbd>\\</kbd> feed view';
}

// The open body is fixed to #splitStage's box: whatever moves the box (the header wrapping, the
// sidebar resized or flipped) moves the body with it.
function measure() {
  const r = $('#splitStage').getBoundingClientRect();
  const st = document.body.style;
  st.setProperty('--sb-top', `${r.top}px`);
  st.setProperty('--sb-left', `${r.left}px`);
  st.setProperty('--sb-w', `${r.width}px`);
  st.setProperty('--sb-h', `${r.height}px`);
}
new ResizeObserver(measure).observe($('#splitStage'));
addEventListener('resize', measure);

// Sidebar width, side and detail, and the reading width: a drag wins over a spell's width, which
// wins over the default. Double-clicking the grip forgets the drag.
const clampW = (w) => Math.round(Math.min(Math.max(w, 220), Math.max(260, Math.min(720, innerWidth - 420))));
function paintProps() {
  const root = document.documentElement.style;
  root.setProperty('--side-w', `${clampW(load('wisp.sideW', null) ?? spellProp('sidebar', 'width') ?? SIDE_W)}px`);
  root.setProperty('--read-w', `${spellProp('split.main', 'readWidth') ?? READ_W}px`);
  // The list sits on the left unless a spell asks for the right.
  document.body.classList.toggle('side-right', spellProp('sidebar', 'side') === 'right');
  document.body.classList.toggle('side-full', spellProp('sidebar', 'details') === 'full');
  measure();
}

const viewBtn = $('#viewBtn');
function paintViewBtn() {
  const split = viewPref() === 'split';
  viewBtn.setAttribute('aria-pressed', split);
  $('use', viewBtn).setAttribute('href', split ? '#i-feed' : '#i-split');
  viewBtn.title = split ? 'Feed view: one column, cards open in place (\\)' : 'Split view: tasks in a sidebar, the open one beside it (\\)';
}

// --- wiring --------------------------------------------------------------------------------------

viewBtn.onclick = () => {
  toggleView();
};
$('#splitNew').onclick = () => goHome();
$('#splitHead').addEventListener('click', (e) => {
  if (e.target.closest('.sh-close')) return goHome();
});
$('#splitHead').addEventListener('dblclick', (e) => {
  const id = $('#splitHead').dataset.id;
  if (e.target.closest('.sh-title') && id) import('./actions.js').then((m) => m.rename(id));
});
home.addEventListener('click', (e) => {
  const id = e.target.closest('.sh-task')?.dataset.id;
  if (!id) return;
  setFocus(id, { scroll: false });
  expand(id);
});

const grip = $('#splitGrip');
grip.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
  const right = document.body.classList.contains('side-right');
  let w = null;
  const move = (ev) => {
    w = clampW(right ? innerWidth - ev.clientX : ev.clientX);
    document.documentElement.style.setProperty('--side-w', `${w}px`);
    measure();
  };
  const up = () => {
    grip.removeEventListener('pointermove', move);
    document.body.classList.remove('resizing');
    if (w !== null) save('wisp.sideW', w);
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up, { once: true });
  grip.addEventListener('pointercancel', up, { once: true });
});
grip.addEventListener('dblclick', () => {
  localStorage.removeItem('wisp.sideW');
  paintProps();
});

wide.addEventListener('change', applyView);
bus.on('spells', applyView);
// Before the config lands, from the last layout seen (no flash of the feed on reload).
queueMicrotask(applyView);
