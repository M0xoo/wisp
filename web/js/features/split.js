// Split view: the task list in a sidebar, the open task in the main pane. The cards are the feed's
// own (same nodes, same code paths): in split view at most one is open, its head stays in the
// sidebar and its body is laid over the main pane (position: fixed to #splitStage's box), so
// everything that looks things up through the card keeps working. Home, with nothing open, is the
// prompt box. Below SPLIT_MIN_WIDTH the page falls back to the feed; the setting stays. With no
// layout picked, windows SPLIT_DEFAULT_WIDTH and wider get split view, narrower ones the feed.
// The top bar becomes the sidebar's head (its Update, Get the app, Machines and Automations move to
// the sidebar's foot), so the open task has the window's full height: its header is just the title,
// and on a wide pane what the card says about it, its PR and its actions sit in a details column on
// the right that stays put while the task scrolls. The head's sidebar button (or [) hides the list
// so the task gets the whole window; the feed's own one opens split view.
//
// Spells reach all of it through spell-schema.js: the `view` setting, the sidebar.top, split.head
// and split.details slots, the sidebar / split.* parts and their props (width, side, details,
// readWidth, greeting, the details column's width).

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, $$, beforePaint, icon } from '../core/dom.js';
import { ago, agoLong, STATUS_LABEL, timeAttrs } from '../core/format.js';
import { load, MOBILE, S, save } from '../core/state.js';
import { SPLIT_DEFAULT_WIDTH, SPLIT_MIN_WIDTH } from '../spell-schema.js';
import { toast, tryApi } from '../ui/toast.js';
import { collapse, expand, groups, headPills, renderFeed, setFocus } from './feed.js';
import { barCover, scrollByPx, stage, topInset } from './scroll.js';
import { placePr, renderBody } from './turns.js';
import { slotHtml, spellProp } from './spells.js';

const wide = matchMedia(`(min-width: ${SPLIT_MIN_WIDTH}px)`);
const big = matchMedia(`(min-width: ${SPLIT_DEFAULT_WIDTH}px)`);
const SIDE_W = 340;
const READ_W = 860;
const DETAILS_W = 232;
// The main pane gets the details column from this width; narrower, they're a bar over the task.
const DETAILS_PANE = 860;

export const isSplit = () => document.body.classList.contains('split');
// The layout asked for: the setting (yours, or a spell's while it's on); none picked, split view on
// big screens and the feed elsewhere. Before /config lands (it always has `home`): the last one
// seen, so the first paint is already the right one.
const autoView = () => (big.matches ? 'split' : 'feed');
export const viewPref = () => S.config.defaults?.view || ('home' in S.config ? autoView() : load('wisp.view', autoView()));

// The task open in the main pane (null on home).
export const splitOpen = () => (isSplit() ? [...S.open].find((id) => S.nodes.get(id)?.card.isConnected) || null : null);
// The open task's body: in split view it's the main pane's scroller.
export const splitBody = () => (isSplit() ? $('#feed .item.open > .it-body') : null);
export const sidebar = $('#feedWrap');

// index.html lays split view out before the scripts load: the first applyView() still enters it.
let booted = false;

export function applyView() {
  save('wisp.view', viewPref());
  paintProps();
  // The phone app always gets the feed (its switchers are hidden), even on a wide tablet.
  const want = viewPref() === 'split' && wide.matches && !MOBILE;
  const first = !booted;
  booted = true;
  if (want !== isSplit() || (want && first)) (want ? enter : leave)();
  else paintSplit();
  paintViewBtn(); // says what it does in the layout now shown
}

export async function setView(v) {
  if (v === viewPref()) return;
  const by = S.config.lockedBy?.view;
  if (by) return toast(`${icon('wizard')} The layout is set by the spell <b>${esc(by.name)}</b>. Turn it off in Settings → Spells to change it.`);
  const was = S.config.defaults.view; // unset: the default for the window's width
  S.config.defaults.view = v;
  applyView();
  if (v === 'split' && !wide.matches) toast(`Split view needs a window at least ${SPLIT_MIN_WIDTH}px wide: it starts once there's room.`);
  const ok = await tryApi(() => api('/config', { method: 'PATCH', body: { defaults: { view: v } } }));
  if (!ok) {
    if (was) S.config.defaults.view = was;
    else delete S.config.defaults.view;
    applyView();
  }
  bus.emit('view');
}
export const toggleView = () => {
  if (!MOBILE) setView(viewPref() === 'split' ? 'feed' : 'split');
};

// The task list hidden in split view. Yours alone (kept in this browser), like the list's width.
let sideHidden = load('wisp.sideHidden', false);
export const sideShown = () => isSplit() && !sideHidden;
export function toggleSidebar() {
  if (!isSplit()) return;
  sideHidden = !sideHidden;
  save('wisp.sideHidden', sideHidden);
  paintProps();
  paintViewBtn();
}

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
const foot = $('#splitFoot');
// The top bar's buttons that sit in the sidebar's foot in split view, in the bar's order.
const FOOT = ['#updateBtn', '#getAppBtn', '#machinesBtn', '#autoBtn'];

function enter() {
  // One task at a time: keep the focused one if it's open, else the first.
  const keep = S.open.has(S.focus) ? S.focus : [...S.open][0];
  for (const id of [...S.open]) if (id !== keep) collapse(id);
  stage.scrollTop = 0;
  const box = $('#launcher');
  box?.classList.remove('docked');
  launchSlot.style.height = '';
  // Already in place when index.html laid it out: re-inserting would replay their entrances.
  if (launchSlot.parentNode !== $('.sh-launch', home)) $('.sh-launch', home).append(launchSlot, feedTop);
  if (foot.childElementCount !== FOOT.length) foot.append(...FOOT.map((sel) => $(sel)));
  document.body.classList.add('split');
  $('#splitMain').hidden = false;
  $('#splitGrip').hidden = false;
  $('#splitTop').hidden = false;
  foot.hidden = false;
  if (S.sessions.size) renderFeed(); // heads show their preview line again, open or not
  paintSplit();
  const n = S.nodes.get(splitOpen());
  placePr(n?.body);
  n?.card.scrollIntoView({ block: 'nearest' });
}

function leave() {
  const open = splitOpen();
  $('#feed').before(launchSlot, feedTop);
  $('#spTop').before(...FOOT.map((sel) => $(sel)));
  document.body.classList.remove('split', 'pane-wide');
  $('#splitMain').hidden = true;
  $('#splitGrip').hidden = true;
  $('#splitTop').hidden = true;
  foot.hidden = true;
  for (const id of S.open) placePr(S.nodes.get(id)?.body);
  if (S.sessions.size) renderFeed();
  const card = open && S.nodes.get(open)?.card;
  if (card) requestAnimationFrame(() => card.scrollIntoView({ block: 'start' }));
}

// --- each task keeps its place ------------------------------------------------------------------

// Where each task was scrolled to when it closed, so going back to it lands on the same spot. Held
// by the turn at the top of the pane (and how far into it), so a turn landing meanwhile or older
// ones folding away don't shift what was being read. At the end: back to the end, new turns and all.
// Kept in localStorage (the most recent MAX_PLACES), and the open task's is written as the page
// goes away, so a reload (wisp updating, ⌘R) opens it where it was.
const MAX_PLACES = 100;
const places = new Map(Object.entries(load('wisp.places', {})));
const savePlaces = () => {
  while (places.size > MAX_PLACES) places.delete(places.keys().next().value);
  save('wisp.places', Object.fromEntries(places));
};
// The tasks open when the page loaded: in the feed, only the one being read as it went away goes
// back to its place, once (an Open there scrolls to the card's top).
const reloaded = new Set(S.open);

export function keepPlace(id) {
  const n = S.nodes.get(id);
  const body = n?.body;
  if (!isSplit() || !body?.isConnected || !body.querySelector('.turns')) return;
  places.delete(id); // the newest go last, so the oldest go first
  if (body.scrollTop < 1) return savePlaces();
  const end = body.scrollTop + body.clientHeight >= body.scrollHeight - 4;
  const top = body.getBoundingClientRect().top + barCover(body);
  const turn = $$('.turn', body).find((t) => t.getBoundingClientRect().bottom > top);
  places.set(id, { end, turn: turn?.dataset.turn, dy: turn ? turn.getBoundingClientRect().top - top : 0, top: body.scrollTop, showAll: n.showAll });
  savePlaces();
}

// The feed has one scroller for every card: the place kept is the open card's under the top bar.
function keepFeedPlace() {
  const top = topInset();
  for (const id of S.open) {
    const n = S.nodes.get(id);
    const r = n?.card.isConnected && n.body?.querySelector('.turns') && n.card.getBoundingClientRect();
    if (!r || r.top > top || r.bottom <= top) continue;
    const turn = $$('.turn', n.body).find((t) => t.getBoundingClientRect().bottom > top);
    if (!turn) return;
    places.delete(id);
    places.set(id, { feed: true, end: false, turn: turn.dataset.turn, dy: turn.getBoundingClientRect().top - top, showAll: n.showAll });
    return savePlaces();
  }
}

const leaving = () => {
  const id = splitOpen();
  if (id) keepPlace(id);
  else if (!isSplit()) keepFeedPlace();
};
addEventListener('pagehide', leaving);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) leaving();
});

// Once the task's body has rendered on opening it. Used once: a later re-open keeps its own place.
export function backToPlace(id, again = true) {
  const p = places.get(id);
  const n = S.nodes.get(id);
  const body = n?.body;
  if (!p || !body?.querySelector('.turns') || (!isSplit() && !(p.feed && reloaded.has(id)))) return;
  // On a reload the open tasks render before their cards are in the list.
  if (!n.card.isConnected) return again && requestAnimationFrame(() => backToPlace(id, false));
  reloaded.delete(id);
  if (isSplit() && splitOpen() !== id) return;
  places.delete(id);
  savePlaces();
  // It was reading turns behind "Show earlier": show them again.
  if (p.showAll && !n.showAll) (n.showAll = true), renderBody(id, { fresh: false });
  if (!isSplit()) {
    const turn = p.turn && $(`.turn[data-turn="${p.turn}"]`, body);
    // Measured without the body's entry animation (it rises 6px into place).
    const rise = new DOMMatrixReadOnly(getComputedStyle(body).transform).m42 || 0;
    if (turn) scrollByPx(turn.getBoundingClientRect().top - rise - topInset() - p.dy);
    return;
  }
  if (p.end) return (body.scrollTop = body.scrollHeight);
  const turn = p.turn && $(`.turn[data-turn="${p.turn}"]`, body);
  if (!turn) return (body.scrollTop = p.top);
  const top = body.getBoundingClientRect().top + barCover(body);
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
  const shown = !!s && $('#splitStage').hidden;
  $('#splitStage').hidden = !s;
  $('#splitNew').classList.toggle('on', !s);
  const side = slotHtml('sidebar.top');
  const host = $('#spSide');
  if (host.dataset.h !== side) (host.innerHTML = side), (host.dataset.h = side);
  if (s) paintHead(s);
  else paintHome();
  // Measuring forces a layout in the middle of a render. Only a pane that just appeared needs it
  // now (the body's scroll is restored right after); otherwise the next frame, before it paints.
  if (shown) measure();
  else beforePaint(measure);
}

// The open task's header is its title (and the split.head slot). What the card head says about the
// task (state, PR, harness, project, time) goes in its details, with the split.details slot: both
// are painted after every feed render, and when the task's body arrives (renderBody).
export function paintHead(s) {
  const h = $('#splitHead');
  if (!isSplit() || splitOpen() !== s.id || h.querySelector('[contenteditable="true"]')) return;
  const pill =
    s.state === 'waiting'
      ? `<span class="pill st-waiting"><i></i>Asking</span>`
      : s.state === 'review'
        ? `<span class="pill st-${s.status}"><i></i>${STATUS_LABEL[s.status] || STATUS_LABEL.done}</span>`
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
    </div>`;
  if (h.dataset.h !== html) (h.innerHTML = html), (h.dataset.h = html);
  paintDetails(s, pill);
}

function paintDetails(s, pill) {
  const body = S.nodes.get(s.id)?.body;
  const props = body && $('.it-props', body);
  if (!props) return;
  const html = `${headPills(s, pill)}<span class="q-time" ${timeAttrs(s.updatedAt)}>${agoLong(s.updatedAt)}</span>`;
  if (props.dataset.h !== html) (props.innerHTML = html), (props.dataset.h = html);
  const slot = $('.it-slot', body);
  const btns = slotHtml('split.details', s);
  if (slot.dataset.h !== btns) (slot.innerHTML = btns), (slot.dataset.h = btns);
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
            <span class="sh-t" title="${esc(s.title)}">${esc(s.title)}</span>
            <span class="sh-s ${s.state === 'waiting' ? 'asking' : ''}">${s.state === 'waiting' ? 'Asking' : esc(STATUS_LABEL[s.status] || STATUS_LABEL.done)}</span>
            <span class="q-time" ${timeAttrs(s.updatedAt)}>${ago(s.updatedAt)}</span>
          </button>`,
        )
        .join('')}`
    : '';
  const next = $('.sh-next', home);
  if (next.dataset.h !== html) (next.innerHTML = html), (next.dataset.h = html);
  next.hidden = !html;
  $('.sh-keys', home).innerHTML = '<kbd>J</kbd><kbd>K</kbd> move through tasks · <kbd>↵</kbd> open · <kbd>E</kbd> done · <kbd>Esc</kbd> back here · <kbd>[</kbd> hide the list · <kbd>\\</kbd> feed view';
}

// The open body is fixed to #splitStage's box: whatever moves the box (the header wrapping, the
// sidebar resized or flipped) moves the body with it. Runs after every feed render, so it only
// writes what changed: a new --sb-* on body restyles the whole page.
let lastBox = '';
function measure() {
  const r = $('#splitStage').getBoundingClientRect();
  const wideNow = isSplit() && r.width >= DETAILS_PANE;
  // With the list hidden the top bar's buttons float over the pane's corner: the header keeps clear.
  const bar = isSplit() && sideHidden ? $('#topbar').offsetWidth : 0;
  const key = `${r.top} ${r.left} ${r.width} ${r.height} ${wideNow} ${bar}`;
  if (key === lastBox) return;
  lastBox = key;
  const st = document.body.style;
  st.setProperty('--sb-top', `${r.top}px`);
  st.setProperty('--sb-left', `${r.left}px`);
  st.setProperty('--sb-w', `${r.width}px`);
  st.setProperty('--sb-h', `${r.height}px`);
  st.setProperty('--bar-w', `${bar}px`);
  document.body.classList.toggle('pane-wide', wideNow);
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
  root.setProperty('--det-w', `${spellProp('split.details', 'width') ?? DETAILS_W}px`);
  // The list sits on the left unless a spell asks for the right.
  document.body.classList.toggle('side-right', spellProp('sidebar', 'side') === 'right');
  document.body.classList.toggle('side-full', spellProp('sidebar', 'details') === 'full');
  document.body.classList.toggle('side-hidden', sideHidden); // only applies in split view
  beforePaint(measure);
}

// The sidebar button: in split view it hides and shows the task list, in the feed it opens split
// view (the feed comes back with \\, the command palette or Settings).
const viewBtn = $('#viewBtn');
function paintViewBtn() {
  viewBtn.setAttribute('aria-pressed', sideShown());
  viewBtn.title = isSplit()
    ? `${sideHidden ? 'Show' : 'Hide'} the task list ([)`
    : viewPref() === 'split'
      ? `Split view needs a window at least ${SPLIT_MIN_WIDTH}px wide`
      : 'Split view: tasks in a sidebar, the open one beside it (\\)';
  viewBtn.setAttribute('aria-label', viewBtn.title);
}

// --- wiring --------------------------------------------------------------------------------------

viewBtn.onclick = () => {
  if (isSplit()) return toggleSidebar();
  if (MOBILE) return;
  if (viewPref() === 'split') return toast(`Split view needs a window at least ${SPLIT_MIN_WIDTH}px wide: it starts once there's room.`);
  // Asked for the sidebar: it comes with the list showing.
  if (sideHidden) (sideHidden = false), save('wisp.sideHidden', false);
  setView('split');
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
    beforePaint(measure); // pointer moves can come faster than frames
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
big.addEventListener('change', applyView); // the default follows the window while none is picked
bus.on('spells', applyView);
// Before the config lands, from the last layout seen (no flash of the feed on reload).
queueMicrotask(applyView);
