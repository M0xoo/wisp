// Swipe the phone app's task page to the left to bring in its side panel (Changes, PR, Shell), and
// the panel to the right to put it back, the way a native app pushes and pops a page. The panel
// follows the finger, the task slides a little under it and dims; letting go past 40% of the way
// (or on a quick flick) finishes the move from where the finger left it, at the finger's speed,
// otherwise it springs back. It opens on what it last showed.
// A crew member's thread does the same with its About page (crew.js), the column beside the
// thread on a wide pane.
// Only the app (MOBILE), like the list's swipes (swipe.js): a phone browser keeps its own gestures.
// A spell turns it off (panel: swipe false; crew.page: swipe false).
// Only transform and opacity move while the finger does, so the frames stay on the compositor.

import { $, el } from '../core/dom.js';
import { MOBILE } from '../core/state.js';
import { close, lastTab, openPanel, panelShown, sidePanel } from './panel.js';
import { aboutLayers, aboutPage, aboutShown, showAbout } from './crew.js';
import { spellProp } from './spells.js';
import { isStacked, splitOpen, stackPage } from './split.js';

const EDGE = 24; // from either edge of the screen a swipe is Android's Back, not ours
const SLOP = 10; // px before a touch counts as a swipe rather than a tap or a scroll
const COMMIT = 0.4; // of the page's width
const FLICK = 0.3; // px/ms over the last 100ms: a throw finishes the move whatever the distance
const BEHIND = 0.25; // how far the task slides back under the panel, of its width
const DIM = 0.18; // the task's shade with the panel fully over it
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'; // fast out of the finger, soft landing

const scrim = el('<div class="pn-scrim" aria-hidden="true"></div>');

let g = null; // the touch being followed
let swallow = 0; // the click a swipe's lift would send
let settling = null; // the move finishing after a lift: { done, timer }

// The task's page under the panel: its head and its body.
const taskLayers = () => [$('.split-main'), $('#feed .item.open > .it-body')].filter(Boolean);

// What a swipe brings in, and over what: the page, whether it's in, the layers under it (a
// swipe on them brings it in), and how it comes and goes.
const PAGES = [
  {
    off: () => spellProp('panel', 'swipe') === false,
    shown: panelShown,
    page: () => sidePanel,
    under: () => (stackPage() && splitOpen() ? taskLayers() : []),
    open: () => openPanel(splitOpen(), lastTab(), { swipe: true }),
    close,
  },
  {
    off: () => spellProp('crew.page', 'swipe') === false,
    shown: aboutShown,
    page: aboutPage,
    under: () => (stackPage() ? aboutLayers() : []),
    open: () => showAbout(true),
    close: () => showAbout(false),
  },
];

// Inside something that scrolls sideways and can still go the finger's way (a diff, a code
// block, the key row): that scroll is the finger's, not ours.
function scrollsSideways(t, dx, stop) {
  for (let n = t; n && n !== stop; n = n.parentElement) {
    if (n.scrollWidth <= n.clientWidth + 1 || !/auto|scroll/.test(getComputedStyle(n).overflowX)) continue;
    if (dx < 0 ? n.scrollLeft + n.clientWidth < n.scrollWidth - 1 : n.scrollLeft > 0) return true;
  }
  return false;
}

function start(e) {
  if (!MOBILE || e.pointerType !== 'touch' || !e.isPrimary || g || settling || !isStacked()) return;
  if (e.clientX < EDGE || e.clientX > innerWidth - EDGE) return;
  const t = e.target;
  if (t.closest('input, textarea, select, [contenteditable="true"], dialog, .popover, .pk-slider, .cq-grip')) return;
  for (const p of PAGES) {
    if (p.off()) continue;
    const open = p.shown();
    if (open ? !p.page().contains(t) : !p.under().some((n) => n.contains(t))) continue;
    g = { p, open, id: e.pointerId, x0: e.clientX, y0: e.clientY, t, on: false, trail: [], w: 0, x: 0, raf: 0, page: null, layers: [] };
    return;
  }
}

function move(e) {
  if (!g || e.pointerId !== g.id) return;
  const dx = e.clientX - g.x0;
  const dy = e.clientY - g.y0;
  if (!g.on) {
    if (Math.abs(dy) > SLOP && Math.abs(dy) >= Math.abs(dx)) return (g = null); // a scroll
    if (Math.abs(dx) < SLOP || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    // Left brings the panel in, right takes it away; the other way isn't ours.
    if ((dx < 0) === g.open || scrollsSideways(g.t, dx, g.open ? g.p.page() : document.body)) return (g = null);
    begin(g);
    g.x0 = e.clientX; // no jump of the slop's 10px when it takes hold
  }
  e.preventDefault();
  const now = e.timeStamp;
  g.trail.push([now, e.clientX]);
  while (g.trail.length > 2 && now - g.trail[0][0] > 100) g.trail.shift();
  const d = e.clientX - g.x0;
  g.x = Math.min(g.w, Math.max(0, (g.open ? 0 : g.w) + d));
  if (!g.raf)
    g.raf = requestAnimationFrame(() => {
      if (!g) return;
      g.raf = 0;
      place(g, g.x);
    });
}

// It takes hold: the panel is painted at once (off to the right when it's coming in), and from
// here on only its position changes.
function begin(t) {
  t.on = true;
  if (!t.open) t.p.open();
  t.w = innerWidth; // stacked it's the whole window; measuring it would lay the page out here, mid-frame
  t.page = t.p.page();
  t.layers = t.p.under();
  t.page.after(scrim);
  for (const n of [t.page, scrim, ...t.layers]) n.classList.add('pn-drag');
  place(t, t.open ? 0 : t.w);
}

// x: how far the panel is from fully over the task (0 is open, w is gone).
function place(t, x) {
  const p = 1 - x / t.w;
  t.page.style.transform = `translate3d(${x}px, 0, 0)`;
  scrim.style.opacity = (DIM * p).toFixed(3);
  const back = `translate3d(${(-BEHIND * t.w * p).toFixed(1)}px, 0, 0)`;
  for (const n of t.layers) n.style.transform = back;
}

function end(e) {
  if (!g || e.pointerId !== g.id) return;
  const t = g;
  g = null;
  if (!t.on) return;
  swallow = Date.now();
  cancelAnimationFrame(t.raf);
  const [t0, x0] = t.trail[0] || [0, 0];
  const [t1, x1] = t.trail.at(-1) || [0, 0];
  const v = (x1 - x0) / Math.max(1, t1 - t0); // px/ms, + to the right
  // Lifted (not cancelled by the system): a flick decides; else where it is.
  const shown = e.type === 'pointerup' && (Math.abs(v) >= FLICK ? v < 0 : t.x < t.w * (1 - COMMIT));
  settle(t, shown, v);
}

// From where the finger left it to where it goes, carrying the finger's speed (never slower
// than a normal page move, never a drag).
function settle(t, shown, v) {
  const to = shown ? 0 : t.w;
  const left = Math.abs(to - t.x);
  const ms = Math.round(Math.min(320, Math.max(140, left / Math.max(Math.abs(v), t.w / 300))));
  for (const n of [t.page, scrim, ...t.layers]) n.style.transition = `transform ${ms}ms ${EASE}, opacity ${ms}ms ${EASE}`;
  place(t, to);
  const done = () => {
    clearTimeout(settling?.timer);
    settling = null;
    if (!shown && t.p.shown()) t.p.close(); // hidden first, so it never flashes back over the task
    for (const n of [t.page, scrim, ...t.layers]) {
      n.classList.remove('pn-drag');
      n.style.transform = n.style.transition = n.style.opacity = '';
    }
    scrim.remove();
  };
  settling = { done, timer: setTimeout(done, ms + 30) };
}

if (MOBILE) {
  document.addEventListener('pointerdown', start);
  document.addEventListener('pointermove', move, { passive: false });
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
  // A long press opens a menu: then it isn't a swipe any more.
  document.addEventListener('contextmenu', () => {
    if (g && !g.on) g = null;
  });
  // The lift after a swipe isn't a tap on what was under the finger.
  document.addEventListener(
    'click',
    (e) => {
      if (Date.now() - swallow < 400) (e.stopPropagation(), e.preventDefault(), (swallow = 0));
    },
    true,
  );
  // The page changed under a finished move (Back, another task): finish it now.
  addEventListener('popstate', () => settling?.done());
}
