// Swipe a row in the phone app's list, the way a mail app does: right to mark it done, left to
// archive it, each with Undo. The row slides over a coloured band naming what letting go will do;
// past a third of the row (or on a quick flick) the band fills and the phone ticks, and letting go
// there flies the row off and closes the gap. A spell picks the actions (card: swipeRight / swipeLeft) or turns one off.
// Only the app (MOBILE): a phone browser keeps its own sideways gestures (back, forward).

import { $, el, icon } from '../core/dom.js';
import { MOBILE, S, isForLater } from '../core/state.js';
import { canSaveForLater, deleteWithUndo, setArchived, setForLater, toggleDone } from './actions.js';
import { spellProp } from './spells.js';

const EDGE = 24; // from either edge of the screen a swipe is Android's Back, not ours
const SLOP = 10; // px before a touch counts as a swipe rather than a tap or a scroll
const COMMIT = 0.34; // of the row's width
const FLICK = { speed: 0.5, min: 56, window: 100 }; // px/ms over the last 100ms, at least 56px out
const DEFAULTS = { right: 'done', left: 'archive' };

const busy = (s) => s.state === 'running' || s.state === 'waiting';

// Whether a swipe marks a row done, in which case the row needs no done check of its own.
export const swipesDone = () => MOBILE && ['swipeRight', 'swipeLeft'].some((k) => (spellProp('card', k) || DEFAULTS[k === 'swipeRight' ? 'right' : 'left']) === 'done');

// What letting go does, for a task, or null when that action can't apply to it (a running task
// can't be done yet): the row then only gives a little, with nothing under it.
function actionFor(s, side) {
  const a = spellProp('card', side === 'right' ? 'swipeRight' : 'swipeLeft') || DEFAULTS[side];
  if (a === 'done' && !busy(s) && !s.archived) return { label: s.state === 'done' ? 'Reopen' : 'Mark done', icon: s.state === 'done' ? 'replay' : 'done', tone: 'good', run: () => toggleDone(s.id) };
  if (a === 'later' && (isForLater(s) || canSaveForLater(s))) return { label: isForLater(s) ? 'Unsave' : 'Save for later', icon: 'bookmark', tone: 'accent', run: () => setForLater(s.id, !isForLater(s)) };
  if (a === 'archive' && (s.archived || !busy(s))) return { label: s.archived ? 'Unarchive' : 'Archive', icon: 'archive', tone: 'plain', run: () => setArchived(s.id, !s.archived) };
  if (a === 'delete' && !busy(s)) return { label: 'Delete task', icon: 'trash', tone: 'bad', run: () => deleteWithUndo(s.id) };
  return null;
}

let g = null; // the touch being followed
let swallow = 0; // the click a swipe's lift would send

function start(e) {
  if (!MOBILE || e.pointerType !== 'touch' || !e.isPrimary || g) return;
  if (e.clientX < EDGE || e.clientX > innerWidth - EDGE) return;
  const head = e.target.closest('.it-head');
  const card = head?.parentElement;
  const s = card?.matches('.item[data-id]:not(.pending)') && S.sessions.get(card.dataset.id);
  // Not a compare task's run (its card handles the runs together), nor a button inside the row.
  if (!s || s.pending || card.closest('.task-runs') || e.target.closest('button, [contenteditable="true"], .it-choices')) return;
  g = { s, card, head, id: e.pointerId, x0: e.clientX, y0: e.clientY, on: false, side: '', act: null, armed: false, band: null, w: head.offsetWidth, trail: [] };
}

function move(e) {
  if (!g || e.pointerId !== g.id) return;
  const dx = e.clientX - g.x0;
  const dy = e.clientY - g.y0;
  if (!g.on) {
    if (Math.abs(dy) > SLOP && Math.abs(dy) >= Math.abs(dx)) return (g = null); // a scroll
    if (Math.abs(dx) < SLOP || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    g.on = true;
    g.card.classList.add('swiping');
    g.band = el(`<div class="it-swipe" aria-hidden="true"><span class="sw-ic"></span></div>`);
    g.card.prepend(g.band);
  }
  e.preventDefault();
  const now = e.timeStamp;
  g.trail.push([now, dx]);
  while (g.trail.length > 2 && now - g.trail[0][0] > FLICK.window) g.trail.shift();
  const side = dx > 0 ? 'right' : 'left';
  if (side !== g.side) {
    g.side = side;
    g.act = actionFor(g.s, side);
    g.armed = false;
    g.band.className = `it-swipe to-${side} ${g.act ? `tone-${g.act.tone}` : 'none'}`;
    $('.sw-ic', g.band).innerHTML = g.act ? `${icon(g.act.icon)}<span>${g.act.label}</span>` : '';
  }
  // No action that way: a short, stiff pull that says so.
  const x = g.act ? dx : Math.sign(dx) * Math.min(28, Math.abs(dx) * 0.2);
  arm(g, !!g.act && Math.abs(dx) > g.w * COMMIT);
  g.head.style.transform = `translateX(${x}px)`;
  g.band.style.setProperty('--p', Math.min(1, Math.abs(x) / (g.w * COMMIT)).toFixed(3));
}

function arm(t, armed) {
  if (armed === t.armed) return;
  t.armed = armed;
  t.band.classList.toggle('armed', armed);
  navigator.vibrate?.(armed ? 12 : 6);
}

// A quick throw the same way, far enough out, acts as if it had gone past the line.
function flicked(t) {
  const [t0, x0] = t.trail[0] || [0, 0];
  const [t1, x1] = t.trail.at(-1) || [0, 0];
  const v = (x1 - x0) / Math.max(1, t1 - t0);
  return !!t.act && Math.abs(x1) >= FLICK.min && Math.sign(v) === Math.sign(x1) && Math.abs(v) >= FLICK.speed;
}

function end(e) {
  if (!g || e.pointerId !== g.id) return;
  const t = g;
  g = null;
  if (!t.on) return;
  swallow = Date.now();
  const flick = e.type === 'pointerup' && !t.armed && flicked(t);
  const lift = e.type === 'pointerup' && (t.armed || flick);
  t.head.classList.add('sw-back');
  if (!lift) {
    t.head.style.transform = '';
    return settle(t, 260);
  }
  // A flick shows the filled band for a beat first, so it's clear what it did.
  if (flick) {
    t.band.style.setProperty('--p', '1');
    arm(t, true);
    return setTimeout(() => fly(t), 90);
  }
  fly(t);
}

// Off the edge, then the gap closes, then the list changes under it (no jump when it does).
function fly(t) {
  t.head.style.transform = `translateX(${t.side === 'right' ? '' : '-'}${t.w + 24}px)`;
  setTimeout(() => {
    t.card.style.height = `${t.card.offsetHeight}px`;
    t.card.classList.add('sw-gone');
    requestAnimationFrame(() => {
      t.card.style.height = '0px';
    });
    setTimeout(() => {
      t.act.run();
      settle(t, 0);
    }, 200);
  }, 180);
}

// Back to a plain row, wherever the change put it.
function settle(t, after) {
  setTimeout(() => {
    t.band?.remove();
    t.card.classList.remove('swiping', 'sw-gone');
    t.head.classList.remove('sw-back');
    t.head.style.transform = '';
    t.card.style.height = '';
  }, after);
}

if (MOBILE) {
  const feed = $('#feed');
  feed.addEventListener('pointerdown', start);
  feed.addEventListener('pointermove', move, { passive: false });
  feed.addEventListener('pointerup', end);
  feed.addEventListener('pointercancel', end);
  // A long press opens the row's menu: then it isn't a swipe any more.
  feed.addEventListener('contextmenu', (e) => {
    if (!g?.on) return (g = null);
    e.preventDefault();
    e.stopPropagation();
  }, true);
  feed.addEventListener('click', (e) => {
    if (Date.now() - swallow > 400) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}
