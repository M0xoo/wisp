// The phone app (MOBILE): what you touch shows it at once, as a native button does. The WebView
// only applies :active once the finger lifts (or after a long press), so a tap showed nothing while
// it was down and the press look came with the action, 120-210 ms late. Here the touched button
// gets .pressed on the way down; rows in the scrolling list wait a moment first, so starting a
// scroll or a swipe doesn't flash them. Kept long enough to be seen on a quick tap.

const BUTTONS = 'button, .brand, .shell-door, [role="menuitem"]';
const ROWS = '.it-head, .task-head, .cr-row';
const ROW_DELAY = 60; // ms: a scroll or swipe has moved past SLOP by then
const MIN_SHOWN = 100; // ms from the touch
const SLOP = 8; // px

let cur = null; // { el, x, y, at, timer: the row's frame wait }

function release(now = false) {
  const c = cur;
  if (!c) return;
  cur = null;
  cancelAnimationFrame(c.timer);
  const left = MIN_SHOWN - (performance.now() - c.at);
  if (now || left <= 0 || !c.el.classList.contains('pressed')) return c.el.classList.remove('pressed');
  setTimeout(() => c.el.classList.remove('pressed'), left);
}

export function pressFeedback() {
  addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType !== 'touch' || !e.isPrimary) return;
      release(true);
      const el = e.target.closest?.(`${BUTTONS}, ${ROWS}`);
      if (!el || el.disabled) return;
      cur = { el, x: e.clientX, y: e.clientY, at: performance.now(), timer: 0 };
      if (!el.matches(ROWS)) return el.classList.add('pressed');
      // Counted in frames: Chrome holds timers back for ~100 ms after a touch starts (in case it scrolls).
      const c = cur;
      const wait = () => {
        if (cur !== c) return;
        if (performance.now() - c.at >= ROW_DELAY) el.classList.add('pressed');
        else c.timer = requestAnimationFrame(wait);
      };
      c.timer = requestAnimationFrame(wait);
    },
    { capture: true, passive: true },
  );
  addEventListener(
    'pointermove',
    (e) => {
      if (cur && Math.hypot(e.clientX - cur.x, e.clientY - cur.y) > SLOP) release(true); // a scroll or a swipe, not a tap
    },
    { capture: true, passive: true },
  );
  addEventListener('pointerup', () => release(), { capture: true, passive: true });
  addEventListener('pointercancel', () => release(true), { capture: true, passive: true });
}
