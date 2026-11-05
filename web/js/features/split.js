// Split view: the task list in a sidebar, the open task in the main pane. The cards are the feed's
// own (same nodes, same code paths): in split view at most one is open, its head stays in the
// sidebar and its body is laid over the main pane (position: fixed to #splitStage's box), so
// everything that looks things up through the card keeps working. Home, with nothing open, is the
// prompt box. It's the only layout: below SPLIT_MIN_WIDTH, and always in the phone app, it stacks
// (body.stack): the list fills the window, and a task, a crew member's thread or home (New task)
// opens over it as a page of its own, with Back (the head's button, Esc, the phone's Back) to the list.
// The top bar becomes the sidebar's head, its corner a round avatar (you on the grid) whose menu holds
// Machines, Automations, Get the app and Settings, so the list keeps its height and the open task the
// window's: its header is just the title,
// and on a wide pane what the card says about it, its PR and its actions sit in a details column on
// the right that stays put while the task scrolls. The head's sidebar button (or [) hides the list
// so the task gets the whole window.
//
// Spells reach all of it through spell-schema.js: the sidebar.top, split.head
// and split.details slots, the sidebar / split.* parts and their props (width, side, details,
// readWidth, greeting, the details column's width).

import { esc } from '../md.js';
import * as bus from '../core/bus.js';
import { $, $$, beforePaint, el, icon } from '../core/dom.js';
import { ago, fmtDate, SHORT_TIME, STATUS_LABEL, statusKey, statusPill, timeAttrs, whenLabel } from '../core/format.js';
import { inGrid, isForLater, load, MOBILE, needsYou, S, save } from '../core/state.js';
import { dismissInstall, installHint } from './homescreen.js';
import { SPLIT_MIN_WIDTH } from '../spell-schema.js';
import { onBack } from '../ui/back.js';
import { popover } from '../ui/popover.js';
import { collapse, expand, groups, headPills, qDot, renderFeed, reveal, setFocus } from './feed.js';
import { barCover, stage } from './scroll.js';
import { paintMini, placePr, renderBody } from './turns.js';
import { slotHtml, spellProp } from './spells.js';
import { avatarHtml, crewBack, crewDot, crewViewShown, leaveCrew, memberById, paintCrewView, underMember } from './crew.js';
import { leaveOrg, orgShown, paintOrg } from './org.js';
import { leavePlan, paintPlan, planShown } from './plan-view.js';
import { closeGoalRun, paintGoalRun } from './goal-run.js';
import { leaveStuff, paintStuff, stuffShown } from './stuff.js';
import { openUpcoming, upcoming, upcomingByDay, upcomingRow } from './later.js';
import { paintGoal } from './goal.js';
import { backTarget, trailOf } from './lineage.js';
import { dismissNotice, noticesOn, noticeTip, noticeWhen, planLine } from './budget.js';
import { harnessLogo } from './runners.js';
import { pruneSeen, spareKey, spareOf, spareWhose, spareWords } from '../spare.js';
import { noticesOf, noticeWords } from '../window-notice.js';
import { feedbackOn, openFeedback } from './feedback.js';
import { follow as followTerm } from './term.js';
import { paneMade, paneNeed, paneNode, panesAt } from './panes.js';
import { dragShares, fitShares, TILE_HEIGHT, TILE_MAX_HEIGHT, TILE_MIN_HEIGHT, tileColumns, tileEdges, tileFrom, tileSaved, tileShares } from '../pane-bridge.js';

const wide = matchMedia(`(min-width: ${SPLIT_MIN_WIDTH}px)`);
const SIDE_W = 340;
const READ_W = 860;
const DETAILS_W = 232;
// The main pane gets the details column from this width; narrower, they're a bar over the task.
const DETAILS_PANE = 860;
// …and from this height: the column is pinned to the top of the pane, so on a shorter one (a phone
// in landscape) its actions would sit below the window, out of reach. The bar keeps them on screen.
const DETAILS_PANE_H = 520;

export const isSplit = () => document.body.classList.contains('split');
// One pane at a time: the list, or what's open over it as a page.
export const isStacked = () => MOBILE || !wide.matches;

// The task open in the main pane (null on home).
export const splitOpen = () => (isSplit() ? [...S.open].find((id) => S.nodes.get(id)?.card.isConnected) || null : null);
// The open task's body: in split view it's the main pane's scroller.
export const splitBody = () => (isSplit() ? $('#feed .item.open > .it-body') : null);
export const sidebar = $('#feedWrap');

// index.html lays split view out before the scripts load: the first applyView() still enters it.
let booted = false;

export function applyView() {
  paintProps();
  if (!booted) enter();
  else paintSplit();
  booted = true;
  paintViewBtn();
  if (inGrid()) paintMe(); // elsewhere the account comes with the machines
}

// The task list hidden beside the open task ([). Yours alone (kept in this browser), like the
// list's width. Stacked, the list is already out of the way while something's open.
let sideHidden = load('wisp.sideHidden', false);
// The side panel (panel.js) open in a window too narrow for the list as well: the list makes way
// while it's open, without forgetting your choice.
const PANEL_WIDE = 1180;
const panelSqueeze = () => document.body.classList.contains('panel-open') && innerWidth < PANEL_WIDE;
const listHidden = () => (sideHidden || panelSqueeze()) && !isStacked();
export const sideShown = () => isSplit() && !listHidden();
export function toggleSidebar() {
  if (!isSplit() || isStacked()) return;
  // [ brings the list back by putting the panel away: there's room for one of the two.
  if (panelSqueeze() && !sideHidden) return bus.emit('panel:close');
  sideHidden = !sideHidden;
  save('wisp.sideHidden', sideHidden);
  paintProps();
  paintViewBtn();
}

// Stacked: home shows as a page only once asked for (New task); otherwise nothing open is the list.
let homeAsked = false;
// Stacked and something's open over the list: a task, a member's thread or home.
export const stackPage = () => document.body.classList.contains('stack-page');

// Nothing open: the prompt box, focused (New task).
export function goHome({ focus = true } = {}) {
  leaveCrew(); // a crew member's thread too
  leaveOrg(); // and the Org page
  leavePlan(); // and a scheduled task's page
  leaveStuff(); // and My Stuff
  leavePane(); // and a pane open as a page
  for (const id of [...S.open]) collapse(id);
  homeAsked = isStacked();
  paintSplit();
  if (focus) $('#prompt')?.focus({ preventScroll: true });
}

// Back (Esc, the head's ×, the stacked page's Back, the phone's Back): a crew job goes back to its
// member's thread, the thread home. Stacked, a pane's page goes back to home, and home is the list.
export function goBack({ focus = false } = {}) {
  if (closeGoalRun()) return; // a goal check's page: back to its task, as it was
  const pane = panePage;
  if (leavePane()) {
    paintSplit();
    $$('.sh-pane-row', home).find((r) => r.dataset.pane === pane)?.focus({ preventScroll: true });
    return;
  }
  // A delegate's task goes back up to the task it was opened from (its lead), wherever it is.
  const up = splitOpen() && backTarget(splitOpen());
  if (up) return void reveal(up);
  if (crewBack()) return;
  if (!isStacked()) return goHome({ focus });
  leaveCrew();
  leaveOrg();
  leavePlan();
  leaveStuff();
  for (const id of [...S.open]) collapse(id);
  homeAsked = false;
  paintSplit();
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
  // Already in place when index.html laid it out: re-inserting would replay their entrances.
  if (launchSlot.parentNode !== $('.sh-launch', home)) $('.sh-launch', home).append(launchSlot, feedTop);
  document.body.classList.add('split');
  $('#splitMain').hidden = false;
  $('#splitGrip').hidden = false;
  $('#splitTop').hidden = false;
  if (S.sessions.size) renderFeed(); // heads show their preview line again, open or not
  paintSplit();
  const n = S.nodes.get(splitOpen());
  placePr(n?.body);
  n?.card.scrollIntoView({ block: 'nearest' });
}

// You, the avatar in the top bar's corner and the first row of its menu: the account this wisp is on a grid with, as the grid's own page shows it. A
// cloud computer is yours on the grid; a computer signed in to one has its account in Machines.
// Signed out, it stays: the last account (wisp.lastMe), greyed, the row saying it's not connected,
// and a click on it signs in again; never signed in, the cloud. Remembered
// (wisp.me) so index.html paints it before the config lands.
let lastMe;
const hostOf = (g) => {
  try {
    return new URL(/^https?:/.test(g) ? g : `https://${g}`).host;
  } catch {
    return '';
  }
};
function meInfo() {
  if (inGrid()) {
    const g = S.config.grid;
    const handle = g.handle || new URL(g.address).hostname.split('.')[0];
    return { handle, name: g.name || '', avatar: '', grid: g.url, state: 'on' };
  }
  const m = S.machines.find((x) => x.kind === 'grid' && !x.computer);
  if (!m) return { ...(load('wisp.lastMe', null) || {}), state: 'out' };
  const me = { handle: m.user?.handle || m.handle, name: m.user?.name || '', avatar: m.user?.avatar || '', grid: m.grid };
  save('wisp.lastMe', me);
  return { ...me, state: m.state === 'online' ? 'on' : 'off' };
}
export function paintMe() {
  const a = $('#splitMe');
  const me = meInfo();
  const host = me.grid ? hostOf(me.grid) : '';
  const out = me.state === 'out';
  const who = me.name || me.handle;
  const av = who
    ? `${me.avatar ? `<img src="${esc(me.avatar)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<b>${esc(who.trim()[0].toUpperCase())}</b>`
    : icon('user'); // never signed in: you, not a grid's status
  const sub = out ? 'Not connected · Sign in' : me.name ? `${me.handle} · ${host}` : host;
  const circle = `<span class="sf-av${me.state === 'on' ? ' on' : ''}${out ? ' out' : ''}">${av}</span>`;
  const saved = {
    av: circle,
    html: `${circle}<span class="sf-who"><b>${esc(who || 'wisp Grid')}</b><small>${esc(sub)}</small></span>`,
    // In the phone app the account page would replace wisp in its one window, with no way back:
    // there it goes to your computers, like the logo.
    href: !out && host && !MOBILE ? `https://${host}/account` : '',
    title: MOBILE
      ? `${out ? 'Not connected to a wisp Grid' : `Signed in as ${me.handle} on ${host}`}: your computers`
      : out
        ? `Not connected to a wisp Grid${host ? ` (last: ${me.handle} on ${host})` : ''}: sign in`
        : `Signed in as ${me.handle} on ${host}${me.state === 'on' ? '' : ' (not connected right now)'}: open your account`,
  };
  const key = JSON.stringify(saved);
  if (key === lastMe) return;
  lastMe = key;
  save('wisp.me', saved);
  if (a.dataset.h !== saved.html) (a.innerHTML = saved.html), (a.dataset.h = saved.html);
  if (meBtn.dataset.h !== saved.av) (meBtn.innerHTML = saved.av), (meBtn.dataset.h = saved.av);
  // The phone app calls them Computers.
  const what = `${MOBILE ? 'Computers' : 'Machines'}, Automations and Settings`;
  meBtn.title = `${who ? `${who} · ` : ''}${what}`;
  meBtn.setAttribute('aria-label', `You, ${what}`);
  // Signed out it opens the sign-in here rather than linking to the account page (a menu row either way).
  if (saved.href) a.href = saved.href;
  else a.removeAttribute('href');
  a.title = saved.title;
}

// The avatar's menu: the same buttons whatever opens (their counts and states are painted by their
// own modules while it's closed), moved to the end of the page between openings.
const meBtn = $('#meBtn');
const meMenu = $('#meMenu');
const meRows = () => $$('[role="menuitem"]', meMenu).filter((x) => !x.hidden);
function openMe({ keys = false } = {}) {
  meMenu.hidden = false;
  document.body.append(meMenu);
  const r = meBtn.getBoundingClientRect();
  const w = meMenu.offsetWidth;
  meMenu.style.top = `${r.bottom + 6}px`;
  meMenu.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
  meBtn.setAttribute('aria-expanded', 'true');
  popover(meMenu, {
    anchor: meBtn,
    onClose: () => {
      const inside = meMenu.contains(document.activeElement);
      meMenu.hidden = true;
      document.body.append(meMenu);
      meBtn.setAttribute('aria-expanded', 'false');
      if (inside) meBtn.focus({ preventScroll: true });
    },
  });
  // Opened from the keyboard: on its first row, ready for the arrows.
  if (keys) meRows()[0]?.focus();
}
meBtn.addEventListener('click', (e) => {
  if (meMenu.hidden) openMe({ keys: e.detail === 0 });
  else meMenu.close?.();
});
meBtn.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' || !meMenu.hidden) return;
  e.preventDefault();
  openMe({ keys: true });
});
meMenu.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const rows = meRows();
  const i = rows.indexOf(document.activeElement);
  rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
});
// A row does its thing (its own handler), then the menu goes.
meMenu.addEventListener('click', (e) => {
  if (e.target.closest('button, a')) meMenu.close?.();
});
$('#splitMe').addEventListener('click', (e) => {
  if (e.currentTarget.hasAttribute('href')) return;
  e.preventDefault();
  import('./machines.js').then((m) => m.openMachines({ focusGrid: true }));
});
$('#splitMe').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.currentTarget.hasAttribute('href')) e.currentTarget.click();
});

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

const leaving = () => {
  const id = splitOpen();
  if (id) keepPlace(id);
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
  // Places kept by the feed (gone now) were for its one scroller, not the task's own.
  if (!p || p.feed || !body?.querySelector('.turns')) return;
  // On a reload the open tasks render before their cards are in the list.
  if (!n.card.isConnected) return again && requestAnimationFrame(() => backToPlace(id, false));
  if (splitOpen() !== id) return;
  places.delete(id);
  savePlaces();
  // It was reading turns behind "Show earlier": show them again.
  if (p.showAll && !n.showAll) (n.showAll = true), renderBody(id, { fresh: false });
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
  paintCrewView(); // a crew member's thread fills the pane while no task is open (crew.js)
  paintOrg(); // …and so does the Org page (org.js)
  paintPlan(); // …and a scheduled task's page (plan-view.js)
  paintStuff(); // …and My Stuff (stuff.js)
  paintGoalRun(); // a goal check's page goes when its task does (goal-run.js)
  const crew = crewViewShown() || orgShown() || planShown() || stuffShown();
  const stacked = isStacked();
  if (s || crew) homeAsked = false;
  if (s || crew || !stacked) leavePane(); // something else opened over it, or the window widened
  paintPage(stacked && (!!s || crew || homeAsked || !!panePage));
  home.hidden = !!s || crew || (stacked && !homeAsked && !panePage);
  $('#splitHead').hidden = !s;
  const shown = !!s && $('#splitStage').hidden;
  $('#splitStage').hidden = !s;
  $('#splitNew').classList.toggle('on', !s && !crew && !stacked);
  const side = slotHtml('sidebar.top');
  const host = $('#spSide');
  if (host.dataset.h !== side) (host.innerHTML = side), (host.dataset.h = side);
  if (s) paintHead(s);
  else if (!crew) paintHome();
  // Measuring forces a layout in the middle of a render. Only a pane that just appeared needs it
  // now (the body's scroll is restored right after); otherwise the next frame, before it paints.
  if (shown) measure();
  else beforePaint(measure);
  followTerm(); // a task's terminal comes with it (term.js)
}

// Stacked: a page over the list while something's open. It slides in when you open it (not on the
// first paint, nor when the window narrows onto it); the list stays laid out underneath, where it
// was scrolled, for Back. In the phone app it takes one history entry, so Back closes it.
let paged = false;
let pageBack = null;
let painted = false;
function slideIn() {
  const b = document.body;
  b.classList.add('stack-in');
  clearTimeout(slideIn.t);
  slideIn.t = setTimeout(() => b.classList.remove('stack-in'), 260);
}
function paintPage(on) {
  const b = document.body;
  const opened = on && !paged && painted && b.classList.contains('stack');
  painted = true;
  if (on !== paged) {
    paged = on;
    b.classList.toggle('stack-page', on);
    if (opened) slideIn();
  }
  if (on && !pageBack)
    pageBack = onBack(() => {
      pageBack = null;
      goBack();
    });
  else if (!on && pageBack) (pageBack(), (pageBack = null));
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
        ? statusPill(s)
        : s.state === 'running'
          ? `<span class="pill st-running"><i></i>Working</span>`
          : '';
  h.dataset.id = s.id;
  h.className = `split-head c-${s.color} st-${s.state}`;
  // Stacked, Back replaces the crumb, the dot and Close: back to the member for its job, else the list.
  const stacked = isStacked();
  const html = `
    <div class="sh-row">
      ${stacked ? backBtn(s) : ''}${trailHtml(s)}${stacked ? '' : crumb(s) || (trailOf(s).length ? '' : qDot(s))}
      <h2 class="sh-title" title="${MOBILE ? '' : 'Rename (M)'}">${esc(s.title)}</h2>
      <span class="sh-acts">${slotHtml('split.head', s)}${panelBtn()}${stacked ? '' : `<button class="icon-btn sh-close" title="${esc(closeLabel(s))}" aria-label="Close">${icon('x')}</button>`}</span>
    </div>`;
  if (h.dataset.h !== html) (h.innerHTML = html), (h.dataset.h = html);
  paintDetails(s, pill);
  paintGoal(s.id); // the band follows the summary: a check landing, a round starting
}

// The side panel's toggle (panel.js keeps it pressed while the panel is open).
function panelBtn() {
  const on = document.body.classList.contains('panel-open');
  const label = `${on ? 'Hide' : 'Show'} side panel (])`;
  return `<button class="icon-btn sh-panel" title="${label}" aria-label="${label}" aria-pressed="${on}">${icon('panel')}</button>`;
}

function backBtn(s) {
  const up = backTarget(s.id);
  const m = !up && s?.crew && S.crewOpen === s.crew.id && !isForLater(s) && memberById(s.crew.id);
  const label = up ? `Back to “${S.sessions.get(up).title}”` : m ? `Back to ${m.name}` : 'Back to tasks';
  return `<button class="icon-btn sh-back" title="${esc(label)}" aria-label="${esc(label)}">${icon('back')}</button>`;
}

const closeLabel = (s) => {
  const up = backTarget(s.id);
  return up ? `Back to “${S.sessions.get(up).title}” (Esc)` : 'Close: back to New task (Esc)';
};

// The tasks above a delegate's task (its lead, the task a crew job was done for, and theirs), each
// a way up: the nearest one by name, any further up behind "…". Esc goes back one.
function trailHtml(s) {
  const t = trailOf(s);
  if (!t.length) return '';
  const near = t.at(-1);
  const up = (p, cls = '') =>
    p.here
      ? `<button class="sh-up${cls}" data-up="${esc(p.id)}" title="${esc(p.id === backTarget(s.id) ? `Back to “${p.title}” (Esc)` : `Open “${p.title}”`)}">${icon('agent')}<span>${esc(p.title)}</span></button>`
      : `<span class="sh-up off${cls}" title="${esc(`“${p.title}” isn’t here anymore`)}">${icon('agent')}<span>${esc(p.title)}</span></span>`;
  const more = t.length > 1 ? `<button class="sh-up more" data-trail aria-haspopup="menu" title="${esc(t.slice(0, -1).map((p) => p.title).join(' › '))}">…</button>${icon('chevron', 'sh-sep')}` : '';
  return `<nav class="sh-trail" aria-label="Delegated from">${more}${up(near)}${icon('chevron', 'sh-sep')}</nav>`;
}

// "…": every task further up, the top one first.
function trailMenu(btn) {
  const s = S.sessions.get(splitOpen());
  const t = s ? trailOf(s).slice(0, -1) : [];
  if (!t.length) return;
  const r = btn.getBoundingClientRect();
  const menu = el(`<div class="menu trail-menu" role="menu" style="top:${r.bottom + 6}px;left:${r.left}px">
      ${t.map((p, i) => `<button role="menuitem" ${p.here ? `data-up="${esc(p.id)}"` : 'disabled'} style="padding-left:${10 + i * 12}px">${icon('agent')}<span>${esc(p.title)}</span></button>`).join('')}
    </div>`);
  menu.onclick = (e) => {
    const b = e.target.closest('button[data-up]');
    if (!b) return;
    close();
    reveal(b.dataset.up);
  };
  const close = popover(menu, { anchor: btn });
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 8 - menu.offsetWidth))}px`;
}

// A crew member's job: the member, as a way back to its thread (Esc too).
function crumb(s) {
  const m = s.crew && memberById(s.crew.id);
  return m ? `<button class="sh-crumb" data-crew="${esc(m.id)}" title="${isForLater(s) ? `Open ${esc(m.name)}` : `Back to ${esc(m.name)} (Esc)`}">${avatarHtml(m, { size: 22, dot: false })}<span>${esc(m.name)}</span>${icon('chevron', 'chev')}</button>` : '';
}

function paintDetails(s, pill) {
  const body = S.nodes.get(s.id)?.body;
  const props = body && $('.it-props', body);
  if (!props) return;
  // The clock time only before the first prompt: after it, the list says how long ago and the prompt's
  // foot gives the time. Never on a state or minute, so the actions under it never move.
  const echo = !!S.full.get(s.id)?.turns?.at(-1)?.startedAt;
  // Its share of the plan's windows (Claude Code, Codex): only here, not on the list's rows.
  const html = `${headPills(s, pill)}${planLine(s)}${echo ? '' : `<span class="q-time" ${timeAttrs(s.updatedAt)}>${whenLabel(s.updatedAt)}</span>`}`;
  if (props.dataset.h !== html) (props.innerHTML = html), (props.dataset.h = html);
  const slot = $('.it-slot', body);
  const btns = slotHtml('split.details', s);
  if (slot.dataset.h !== btns) (slot.innerHTML = btns), (slot.dataset.h = btns);
  paintMini(s.id); // the mini row says the state the details just painted
}

function paintHome() {
  $('.sh-hello', home).textContent = spellProp('split.home', 'greeting') || 'What should wisp do next?';
  // The tasks waiting on you, one click each: home doubles as the inbox. The sidebar's Needs you,
  // plus what the crew wants from you on other tasks' jobs (a question, a report you haven't read),
  // with their faces; their own tasks are in Needs you already.
  const crew = [...S.sessions.values()].filter((s) => underMember(s) && !s.pending && needsYou(s));
  const all = [...groups().needs, ...crew].sort((a, b) => (b.state === 'waiting') - (a.state === 'waiting') || b.updatedAt - a.updatedAt);
  const needs = all.slice(0, 5);
  const html = needs.length
    ? `<h4>Needs you<span class="n">${all.length > needs.length ? `${needs.length} of ${all.length}` : all.length}</span></h4>${needs
        .map(
          (s) => `<button class="sh-task c-${s.color}" data-id="${s.id}">
            ${(s.crew && crewDot(s)) || (s.reminder ? `<span class="q-dot auto">${icon('bell')}</span>` : qDot(s, { ring: false }))}
            <span class="sh-t" title="${esc(s.title)}">${esc(s.title)}</span>
            <span class="sh-s ${s.state === 'waiting' ? 'asking' : s.reminder ? 'reminder' : ''}">${s.state === 'waiting' ? 'Asking' : s.reminder ? 'Reminder' : esc(STATUS_LABEL[statusKey(s)] || STATUS_LABEL.done)}</span>
            <span class="q-time" ${timeAttrs(s.updatedAt)}>${ago(s.updatedAt)}</span>
          </button>`,
        )
        .join('')}`
    : '';
  const next = $('.sh-next', home);
  if (next.dataset.h !== html) (next.innerHTML = html), (next.dataset.h = html);
  next.hidden = !html;
  paintSpare();
  paintPanes();
  // What's coming up: scheduled tasks, reminders, follow-ups, crew check-ins and schedules (later.js).
  // Past the first few, Show all opens the rest in place, a heading per day; the heading sticks
  // so Show fewer stays in reach down a long list.
  const ahead = upcoming();
  const few = spellProp('split.upcoming', 'count') || 5;
  const open = upAll && ahead.length > few;
  shown = open ? ahead : ahead.slice(0, few);
  const more = ahead.length > few ? `<button class="tip-more sh-more" aria-expanded="${open}">${open ? 'Show fewer' : `Show all ${ahead.length}`}</button>` : '';
  const up = shown.length
    ? `<h4>Coming up<span class="n">${ahead.length}</span>${more}${slotHtml('split.upcoming')}</h4>${open ? upcomingByDay(shown) : shown.map((x, i) => upcomingRow(x, i)).join('')}`
    : '';
  const coming = $('.sh-coming', home);
  if (coming.dataset.h !== up) (coming.innerHTML = up), (coming.dataset.h = up);
  coming.hidden = !up;
  $('.sh-fb', home).hidden = !feedbackOn();
  $('.sh-keys', home).innerHTML = '<kbd>J</kbd><kbd>K</kbd> move through tasks · <kbd>↵</kbd> open · <kbd>E</kbd> done · <kbd>Esc</kbd> back here · <kbd>[</kbd> hide the list';
}

// Spare allowance (web/js/spare.js): a weekly window about to reset with much of it unused, under
// Needs you (so Needs you never moves when it comes). Use <harness> picks that harness and account
// in the prompt box above (you send it); × hides that window's card until its next period, here.
// Within a day the weekday and time say when; the tooltip has the full date.
const spareWhen = (t) => fmtDate(t, new Date().toDateString() === new Date(t).toDateString() ? SHORT_TIME : { weekday: 'short', ...SHORT_TIME });
let spare = []; // the cards, as painted
function paintSpare() {
  const box = $('.sh-spare', home);
  const off = S.config.defaults?.spareCard === 'off';
  spare = off ? [] : spareOf(S.agents, { hours: spellProp('split.spare', 'hours') || undefined, seen: load('wisp.spareSeen', {}) }).slice(0, 2);
  const html = spare
    .map((x, i) => {
      const who = `${x.name}${x.accountLabel ? ` (${x.accountLabel})` : ''}`;
      const tip = `Resets ${whenLabel(x.resetsAt)}. What’s left then doesn’t carry over. wisp never switches accounts for you.${x.at ? ` Last reported ${whenLabel(x.at)}.` : ''}`;
      return `<div class="sp-card" aria-label="${esc(spareWords(x, spareWhen(x.resetsAt)))}" data-i="${i}">
        <span class="model-logo">${harnessLogo(x.agent)}</span>
        <span class="sp-text" title="${esc(tip)}"><b>${Math.round(x.left * 100)}%</b>${esc(` of ${spareWhose(x)} left · resets ${spareWhen(x.resetsAt)}`)}</span>
        <button type="button" class="ghost sm sp-start" data-spare="start" data-i="${i}" title="${esc(`Pick ${who} in the prompt box`)}">${esc(`Use ${x.name}`)}</button>
        <button type="button" class="icon-btn sp-x" data-spare="x" data-i="${i}" title="Hide until the window resets" aria-label="Hide until the window resets">${icon('x')}</button>
      </div>`;
    })
    .join('');
  // Window changes (web/js/window-notice.js) in the same box, after the spare rows: a line and ×.
  notes = noticesOn() ? noticesOf(S.agents).slice(0, 2) : [];
  const nhtml = notes
    .map(
      (n, i) => `<div class="sp-card wn-card" role="status">
        <span class="model-logo">${harnessLogo(n.agent)}</span>
        <span class="sp-text" title="${esc(noticeTip(n))}">${esc(noticeWords(n, noticeWhen))}</span>
        <button type="button" class="icon-btn sp-x" data-wnote="${i}" title="Hide until this window changes again" aria-label="Hide until this window changes again">${icon('x')}</button>
      </div>`,
    )
    .join('');
  // On a wisp Grid in an iPhone's browser: add wisp to the Home Screen (homescreen.js), first in the box.
  const install = installHint()
    ? `<div class="sp-card hs-install" role="note">
        <span class="model-logo">${icon('phone')}</span>
        <span class="sp-text">Add wisp to your Home Screen: tap Share ${icon('share', 'hs-share')}, then Add to Home Screen</span>
        <button type="button" class="icon-btn sp-x" data-install="x" title="Hide this" aria-label="Hide this">${icon('x')}</button>
      </div>`
    : '';
  const all = install + html + nhtml;
  if (box.dataset.h !== all) (box.innerHTML = all), (box.dataset.h = all);
  box.hidden = !all;
}
let notes = []; // the window changes, as painted

// Panes on home (panes.js): apps pinned there. Side by side they tile, in the order of their pins:
// as many columns as fit (the spell's split.panes columns at most), sized by your drag, else the
// spell's widths and height. Stacked each is a row (`.sh-rows`) that opens it as a page (panePage):
// no frame starts until then. Their nodes stay in `.sh-tiles` whatever shows, hidden rather than
// moved: re-adding one reloads its app. Called on every repaint of home, so it writes what changed.
let panePage = null; // stacked: the app open as a page
let paneBack = null; // …and its entry in the phone's Back (ui/back.js)
let pageTop = 0; // where home was scrolled under it
let room = 0; // the width home has for them, from the observer below; 0 until it has been measured
let tileSizes = load('wisp.panes', null); // { from, h, w: { <columns>: shares } } (pane-bridge.js)
let dragging = false;

function panesBox() {
  const box = $('.sh-panes', home);
  if (!box.firstElementChild) box.append(el('<h4></h4>'), el('<div class="sh-rows"></div>'), el('<div class="sh-tiles"></div>'));
  return box;
}

function leavePane() {
  if (!panePage) return false;
  panePage = null;
  paneBack?.();
  paneBack = null;
  return true;
}

// Its own entry in the phone's Back, over home's: closing one mustn't touch the other.
function openPane(id) {
  if (panePage || !panesAt('home').some(({ it }) => it.id === id)) return;
  panePage = id;
  paneBack = onBack(() => {
    paneBack = null;
    goBack();
  });
  slideIn(); // home is a page already, so paintPage sees nothing open
  paintSplit();
}

const setStyle = (n, prop, v) => {
  if (n.style.getPropertyValue(prop) !== v) n.style.setProperty(prop, v);
};

function paintPanes() {
  const box = panesBox();
  const list = panesAt('home');
  const stacked = isStacked();
  if (panePage && !list.some(({ it }) => it.id === panePage)) leavePane(); // unpinned while open
  if (box.hidden === !!list.length) box.hidden = !list.length;
  const head = $('h4', box);
  const h = `Panes<span class="n">${list.length}</span>${slotHtml('split.panes')}`;
  if (head.dataset.h !== h) (head.innerHTML = h), (head.dataset.h = h);
  const rows = stacked ? list.map(({ it }) => paneRow(it)).join('') : '';
  const rowBox = $('.sh-rows', box);
  if (rowBox.dataset.h !== rows) (rowBox.innerHTML = rows), (rowBox.dataset.h = rows);
  const want = list
    .filter(({ it }) => !stacked || it.id === panePage || paneMade(it, 'home'))
    .map(({ it }) => {
      const n = paneNode(it, 'home');
      if (!n.classList.contains('sh-pane')) n.classList.add('sh-pane');
      return n;
    });
  const tiles = $('.sh-tiles', box);
  for (const n of [...tiles.querySelectorAll(':scope > .pa')]) if (!want.includes(n)) n.remove();
  let at = null;
  for (const n of want) {
    if ((at ? at.nextElementSibling : tiles.firstElementChild) !== n) {
      if (at) at.after(n);
      else tiles.prepend(n);
    }
    at = n;
  }
  paintPanePage(want);
  paintTiles(list.length);
}

function paneRow(it) {
  const need = paneNeed(it);
  return `<button class="sh-pane-row" data-pane="${esc(it.id)}"><span class="pa-ic">${icon('app')}</span><span class="pa-name">${esc(it.title)}</span>${need ? `<span class="pa-need">${esc(need)}</span>` : ''}${icon('chevron', 'chev')}</button>`;
}

// A pane's page: home's other children go, the pane fills it. Nothing moves in the DOM.
function paintPanePage(nodes) {
  const open = !!panePage;
  if (home.classList.contains('pane-open') !== open) {
    if (open) pageTop = home.scrollTop;
    home.classList.toggle('pane-open', open);
    if (!open) home.scrollTop = pageTop;
  }
  for (const n of nodes) {
    const on = n.dataset.app === panePage;
    if (n.classList.contains('pa-open') !== on) n.classList.toggle('pa-open', on);
    const back = n.querySelector('.sh-back');
    if (back.hidden === on) back.hidden = !on;
  }
}

const tileSpell = () => ({ columns: spellProp('split.panes', 'columns'), widths: spellProp('split.panes', 'widths'), height: spellProp('split.panes', 'height') });

// The layout the tiles have now.
function tilesNow(count = panesAt('home').length) {
  const spell = tileSpell();
  const saved = tileSaved(tileSizes, tileFrom(spell));
  const columns = tileColumns(count, room, spell.columns);
  return { columns, rows: Math.ceil(count / columns), height: saved.h ?? spell.height ?? TILE_HEIGHT, shares: fitShares(tileShares(columns, { spell: spell.widths, saved: saved.w }), room) };
}

function paintTiles(count = panesAt('home').length) {
  const box = panesBox();
  const tiles = $('.sh-tiles', box);
  const t = tilesNow(count);
  const on = count > 0 && !!room && !isStacked(); // stacked (or not measured yet) there's nothing to lay out
  setStyle(box, '--pa-h', `${t.height}px`);
  const tiled = on && t.columns >= 2;
  if (box.classList.contains('tiled') !== tiled) box.classList.toggle('tiled', tiled);
  if (on) setStyle(tiles, 'grid-template-columns', t.shares.map((x) => `${x}fr`).join(' '));
  const x = $$(':scope > .sh-grip.x', tiles);
  if (!dragging) {
    // Never the grip in your hand: its pointer capture goes with it.
    const wantX = on ? t.columns - 1 : 0;
    while (x.length > wantX) x.pop().remove();
    while (x.length < wantX) x.push(tiles.appendChild(gripNode('x', x.length)));
    const y = $(':scope > .sh-grip.y', tiles);
    if (on && !y) tiles.append(gripNode('y'));
    else if (!on) y?.remove();
  }
  if (on) tileEdges(t.shares, room).forEach((px, i) => x[i] && setStyle(x[i], 'left', `${px}px`));
}

const gripNode = (axis, i = 0) =>
  el(`<div class="sh-grip ${axis}" data-i="${i}" role="separator" aria-orientation="${axis === 'x' ? 'vertical' : 'horizontal'}" aria-label="Resize panes" title="Drag to resize · double-click to reset" tabindex="0"></div>`);

// Yours for this layout, or a clean slate: a drag saves over another spell's sizes.
function ownSizes() {
  const from = tileFrom(tileSpell());
  if (tileSizes?.from !== from) tileSizes = { from, w: {} };
  tileSizes.w = tileSizes.w && typeof tileSizes.w === 'object' ? tileSizes.w : {};
  return tileSizes;
}

// A grip moved from where it was (start: tilesNow()). In memory: saved when the drag ends.
function moveGrip(g, start, dx, dy) {
  const mine = ownSizes();
  if (g.classList.contains('y')) mine.h = Math.round(Math.min(TILE_MAX_HEIGHT, Math.max(TILE_MIN_HEIGHT, start.height + dy / start.rows)));
  else mine.w[start.columns] = dragShares(start.shares, Number(g.dataset.i), dx, room);
  paintTiles();
}

const paneRepaint = () => {
  if (home && !home.hidden && isSplit()) paintPanes();
};
bus.on('panes', paneRepaint);
bus.on('stuff-list', paneRepaint);
bus.on('spells', paneRepaint);

// Home's width (0 while it's hidden: nothing to do then) decides the columns, so it's observed, not
// the tiles: `.tiled` changes their own width.
new ResizeObserver(([e]) => {
  const w = e.contentRect.width;
  if (!w || w === room) return;
  room = w;
  if (!home.hidden && !dragging) paintTiles();
}).observe(home);

home.addEventListener('pointerdown', (e) => {
  const g = e.target.closest('.sh-grip');
  if (!g || e.button !== 0) return;
  e.preventDefault();
  g.setPointerCapture(e.pointerId); // keeps the pointer over the frames, which would swallow it
  const b = document.body.classList;
  const tall = g.classList.contains('y');
  b.add('resizing');
  b.toggle('resizing-y', tall);
  g.classList.add('held');
  dragging = true;
  const start = tilesNow();
  let moved = false;
  const move = (ev) => {
    moved = true;
    moveGrip(g, start, ev.clientX - e.clientX, ev.clientY - e.clientY);
  };
  const up = () => {
    g.removeEventListener('pointermove', move);
    g.removeEventListener('pointerup', up);
    g.removeEventListener('pointercancel', up);
    b.remove('resizing', 'resizing-y');
    g.classList.remove('held');
    dragging = false;
    if (moved) save('wisp.panes', tileSizes);
    paintTiles();
  };
  g.addEventListener('pointermove', move);
  g.addEventListener('pointerup', up);
  g.addEventListener('pointercancel', up);
});
home.addEventListener('keydown', (e) => {
  const g = e.target.closest('.sh-grip');
  if (!g) return;
  const tall = g.classList.contains('y');
  const by = { ArrowLeft: tall ? 0 : -16, ArrowRight: tall ? 0 : 16, ArrowUp: tall ? -16 : 0, ArrowDown: tall ? 16 : 0 }[e.key];
  if (!by) return;
  e.preventDefault();
  moveGrip(g, tilesNow(), by, by);
  save('wisp.panes', tileSizes);
});
home.addEventListener('dblclick', (e) => {
  const g = e.target.closest('.sh-grip');
  if (!g) return;
  const mine = ownSizes();
  if (g.classList.contains('y')) delete mine.h;
  else delete mine.w[tilesNow().columns];
  save('wisp.panes', mine);
  paintTiles();
});

function onSpare(btn) {
  const x = spare[Number(btn.dataset.i)];
  if (!x) return;
  if (btn.dataset.spare === 'x') {
    save('wisp.spareSeen', { ...pruneSeen(load('wisp.spareSeen', {})), [spareKey(x)]: x.resetsAt });
    paintSpare();
    return;
  }
  $('#launcher')?.spellSet?.({ agent: x.agent, account: x.account || undefined });
  $('#prompt')?.focus();
}

// The open body is fixed to #splitStage's box: whatever moves the box (the header wrapping, the
// sidebar resized or flipped) moves the body with it. Runs after every feed render, so it only
// writes what changed: a new --sb-* on body restyles the whole page.
let lastBox = '';
function measure() {
  document.body.classList.toggle('no-stage', $('#splitStage').hidden); // Reconnecting… has no pane to sit on
  // Stacked with no task open there's no box: keep the last one, so Back and the next open don't
  // write --sb-* twice (each write restyles the whole page; the phone's box never moves).
  if (isStacked() && $('#splitStage').hidden) return;
  const box = $('#splitStage').getBoundingClientRect();
  // Without the page's slide in (stacked): the body slides with it, from where it'll rest.
  const m = new DOMMatrixReadOnly(getComputedStyle($('#splitMain')).transform);
  const r = { top: Math.round(box.top - m.m42), left: Math.round(box.left - m.m41), width: box.width, height: box.height };
  // The side panel takes the right-hand column: the details fold into the bar while it's open.
  const wideNow = isSplit() && r.width >= DETAILS_PANE && r.height >= DETAILS_PANE_H && !document.body.classList.contains('panel-open');
  // With the list hidden the top bar's buttons float over the pane's corner: the header keeps clear.
  const bar = isSplit() && listHidden() ? $('#topbar').offsetWidth : 0;
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
  document.body.classList.toggle('stack', isStacked());
  document.body.classList.toggle('side-hidden', listHidden());
  beforePaint(measure);
}

// The side panel opened, closed or resized: the columns, the list and the head's buttons follow.
export function relayout() {
  paintProps();
  paintViewBtn();
}

// The sidebar button hides and shows the task list (not there when stacked).
const viewBtn = $('#viewBtn');
function paintViewBtn() {
  viewBtn.setAttribute('aria-pressed', sideShown());
  viewBtn.title = `${listHidden() ? 'Show' : 'Hide'} the task list ([)`;
  viewBtn.setAttribute('aria-label', viewBtn.title);
}

// --- wiring --------------------------------------------------------------------------------------

viewBtn.onclick = () => {
  toggleSidebar();
};
$('#splitNew').onclick = () => goHome();
$('#splitHead').addEventListener('click', (e) => {
  if (e.target.closest('.sh-close')) return goBack({ focus: true });
  if (e.target.closest('.sh-back')) return goBack();
  const up = e.target.closest('[data-up]');
  if (up) return reveal(up.dataset.up);
  const more = e.target.closest('[data-trail]');
  if (more) return trailMenu(more);
});
$('#splitHead').addEventListener('dblclick', (e) => {
  const id = $('#splitHead').dataset.id;
  if (e.target.closest('.sh-title') && id) import('./actions.js').then((m) => m.rename(id));
});
let shown = []; // Coming up's rows, as painted
let upAll = load('wisp.upAll', false); // Coming up shows everything, not only the next few
home.addEventListener('click', (e) => {
  if (e.target.closest('.sh-back')) return goBack();
  const pane = e.target.closest('.sh-pane-row');
  if (pane) return openPane(pane.dataset.pane);
  if (e.target.closest('.sh-more')) {
    upAll = !upAll;
    save('wisp.upAll', upAll);
    const head = $('.sh-coming h4', home);
    const top = head.getBoundingClientRect().top;
    paintHome();
    // Show fewer from far down a long list: back to the heading, not into the tips below.
    if (!upAll && top < 0) head.scrollIntoView({ block: 'start' });
    $('.sh-coming .sh-more', home)?.focus();
    return;
  }
  if (e.target.closest('.sh-fb')) return openFeedback({ source: 'home' });
  const sp = e.target.closest('[data-spare]');
  if (sp) return onSpare(sp);
  if (e.target.closest('[data-install]')) {
    dismissInstall();
    paintSpare();
    return;
  }
  const wn = e.target.closest('[data-wnote]');
  if (wn) {
    const n = notes[Number(wn.dataset.wnote)];
    if (n) dismissNotice(n.agent, n.account, n.window);
    return;
  }
  const up = e.target.closest('.sh-up');
  if (up) return openUpcoming(shown[up.dataset.up], up, e);
  const id = e.target.closest('.sh-task')?.dataset.id;
  if (!id) return;
  if (S.sessions.get(id)?.crew) return reveal(id); // under its member, Crew unfolded
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

// Crossing SPLIT_MIN_WIDTH stacks the panes or lays them side by side, what's open staying open.
wide.addEventListener('change', () => {
  paintProps();
  paintSplit();
});
bus.on('spells', applyView);
// A window moved (server/budget.js broadcasts 'agents'): the spare card follows, while home shows.
bus.on('agents', () => {
  if (isSplit() && !home.hidden) paintSpare();
});
bus.on('config', paintMe);
bus.on('machines', paintMe);
// index.html laid it out already: this takes over before anything paints.
queueMicrotask(applyView);
