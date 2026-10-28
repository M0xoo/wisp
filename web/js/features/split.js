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
import { $, $$, beforePaint, icon } from '../core/dom.js';
import { ago, STATUS_LABEL, timeAttrs, whenLabel } from '../core/format.js';
import { inGrid, isForLater, load, MOBILE, needsYou, S, save } from '../core/state.js';
import { SPLIT_MIN_WIDTH } from '../spell-schema.js';
import { onBack } from '../ui/back.js';
import { popover } from '../ui/popover.js';
import { collapse, expand, groups, headPills, qDot, renderFeed, reveal, setFocus } from './feed.js';
import { barCover, stage } from './scroll.js';
import { placePr, renderBody } from './turns.js';
import { slotHtml, spellProp } from './spells.js';
import { avatarHtml, crewBack, crewDot, crewViewShown, leaveCrew, memberById, paintCrewView, underMember } from './crew.js';
import { openUpcoming, upcoming, upcomingByDay, upcomingRow } from './later.js';
import { paintGoal } from './goal.js';
import { planLine } from './budget.js';
import { feedbackOn, openFeedback } from './feedback.js';

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
  for (const id of [...S.open]) collapse(id);
  homeAsked = isStacked();
  paintSplit();
  if (focus) $('#prompt')?.focus({ preventScroll: true });
}

// Back (Esc, the head's ×, the stacked page's Back, the phone's Back): a crew job goes back to its
// member's thread, the thread home. Stacked, home is the list.
export function goBack({ focus = false } = {}) {
  if (crewBack()) return;
  if (!isStacked()) return goHome({ focus });
  leaveCrew();
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
  const crew = crewViewShown();
  const stacked = isStacked();
  if (s || crew) homeAsked = false;
  paintPage(stacked && (!!s || crew || homeAsked));
  home.hidden = !!s || crew || (stacked && !homeAsked);
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
}

// Stacked: a page over the list while something's open. It slides in when you open it (not on the
// first paint, nor when the window narrows onto it); the list stays laid out underneath, where it
// was scrolled, for Back. In the phone app it takes one history entry, so Back closes it.
let paged = false;
let pageBack = null;
let painted = false;
function paintPage(on) {
  const b = document.body;
  const opened = on && !paged && painted && b.classList.contains('stack');
  painted = true;
  if (on !== paged) {
    paged = on;
    b.classList.toggle('stack-page', on);
    if (opened) {
      b.classList.add('stack-in');
      clearTimeout(paintPage.t);
      paintPage.t = setTimeout(() => b.classList.remove('stack-in'), 260);
    }
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
        ? `<span class="pill st-${s.status}"><i></i>${STATUS_LABEL[s.status] || STATUS_LABEL.done}</span>`
        : s.state === 'running'
          ? `<span class="pill st-running"><i></i>Working</span>`
          : '';
  h.dataset.id = s.id;
  h.className = `split-head c-${s.color} st-${s.state}`;
  // Stacked, Back replaces the crumb, the dot and Close: back to the member for its job, else the list.
  const stacked = isStacked();
  const html = `
    <div class="sh-row">
      ${stacked ? backBtn(s) : crumb(s) || qDot(s)}
      <h2 class="sh-title" title="${MOBILE ? '' : 'Rename (M)'}">${esc(s.title)}</h2>
      <span class="sh-acts">${slotHtml('split.head', s)}${panelBtn()}${stacked ? '' : `<button class="icon-btn sh-close" title="Close: back to New task (Esc)" aria-label="Close">${icon('x')}</button>`}</span>
    </div>${stacked && !s.pending ? segsHtml(s) : ''}`;
  if (h.dataset.h !== html) (h.innerHTML = html), (h.dataset.h = html);
  paintDetails(s, pill);
  paintGoal(s.id); // the band follows the summary: a check landing, a round starting
}

// Stacked (a phone), the side panel's tabs are segments under the head that swap the page's body
// in place: Task, Shell, PR. Back still goes to the list. panel.js keeps the one picked.
function segsHtml(s) {
  const at = document.body.dataset.seg || 'task';
  const prs = [s.pr, ...(s.also || []).map((a) => a.pr), ...(s.prs || []).map((x) => x.pr)].filter(Boolean);
  const pr = prs.length > 1 ? 'PRs' : prs.length ? `PR #${prs[0].number}` : 'PR';
  const seg = (k, label) => `<button role="tab" data-seg="${k}" aria-selected="${at === k}">${label}</button>`;
  return `<div class="sh-segs" role="tablist" aria-label="Task, shell and pull request">${seg('task', 'Task')}${seg('shell', 'Shell')}${seg('pr', esc(pr))}</div>`;
}

// The side panel's toggle (panel.js keeps it pressed while the panel is open).
function panelBtn() {
  const on = document.body.classList.contains('panel-open');
  const label = `${on ? 'Hide' : 'Show'} side panel (])`;
  return `<button class="icon-btn sh-panel" title="${label}" aria-label="${label}" aria-pressed="${on}">${icon('panel')}</button>`;
}

function backBtn(s) {
  const m = s?.crew && S.crewOpen === s.crew.id && !isForLater(s) && memberById(s.crew.id);
  const label = m ? `Back to ${m.name}` : 'Back to tasks';
  return `<button class="icon-btn sh-back" title="${esc(label)}" aria-label="${esc(label)}">${icon('back')}</button>`;
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
            <span class="sh-s ${s.state === 'waiting' ? 'asking' : s.reminder ? 'reminder' : ''}">${s.state === 'waiting' ? 'Asking' : s.reminder ? 'Reminder' : esc(STATUS_LABEL[s.status] || STATUS_LABEL.done)}</span>
            <span class="q-time" ${timeAttrs(s.updatedAt)}>${ago(s.updatedAt)}</span>
          </button>`,
        )
        .join('')}`
    : '';
  const next = $('.sh-next', home);
  if (next.dataset.h !== html) (next.innerHTML = html), (next.dataset.h = html);
  next.hidden = !html;
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

// The open body is fixed to #splitStage's box: whatever moves the box (the header wrapping, the
// sidebar resized or flipped) moves the body with it. Runs after every feed render, so it only
// writes what changed: a new --sb-* on body restyles the whole page.
let lastBox = '';
function measure() {
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
});
$('#splitHead').addEventListener('dblclick', (e) => {
  const id = $('#splitHead').dataset.id;
  if (e.target.closest('.sh-title') && id) import('./actions.js').then((m) => m.rename(id));
});
let shown = []; // Coming up's rows, as painted
let upAll = load('wisp.upAll', false); // Coming up shows everything, not only the next few
home.addEventListener('click', (e) => {
  if (e.target.closest('.sh-back')) return goBack();
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
bus.on('config', paintMe);
bus.on('machines', paintMe);
// index.html laid it out already: this takes over before anything paints.
queueMicrotask(applyView);
