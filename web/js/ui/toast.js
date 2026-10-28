import { $, el, icon } from '../core/dom.js';
import { esc } from '../md.js';

// Toasts sit low and centred, where an open task's docked reply box is (or a crew thread's box, or
// the crew editor's buttons on a phone): lift them above it so they never cover its buttons, and
// keep checking while any show (a task opened under a toast).
let watch = 0;
function keepClear() {
  clearDock();
  watch ||= setInterval(() => {
    if ($('#toasts').querySelector('.toast')) return clearDock();
    clearInterval(watch);
    watch = 0;
  }, 200);
}

function clearDock() {
  const box = $('#toasts');
  const cx = innerWidth / 2;
  let top = innerHeight;
  for (const c of document.querySelectorAll('.it-dock .composer, .launcher, .crew-view:not([hidden]) .cv-box, .crew-edit .ce-foot')) {
    const r = c.getBoundingClientRect();
    if (r.width && r.left < cx && r.right > cx && r.bottom > innerHeight - 140 && r.top < innerHeight) top = Math.min(top, r.top);
  }
  box.style.bottom = top < innerHeight ? `${Math.round(innerHeight - top + 10)}px` : '';
}

// Toasts stack like cards: the newest in front, the older ones tucked behind it with their top
// edges showing. Pointing at the stack (or tapping it on a phone) fans them out and stops every
// clock; × closes one, Clear all the lot.
const GAP = 8;
const KEEP = 3;
const live = () => [...$('#toasts').querySelectorAll(':scope > .toast:not(.out)')];

let box;
function stack() {
  if (box) return box;
  box = $('#toasts');
  box.append(el(`<button class="toasts-clear" aria-label="Close all messages">Clear all</button>`));
  box.querySelector('.toasts-clear').onclick = () => {
    for (const t of live()) dismiss(t);
  };
  // Anything that removes a toast (its own timer, a caller's .remove()) restacks the rest.
  new MutationObserver(layout).observe(box, { childList: true });
  // Leaving the stack waits a beat, so crossing the gap between two cards doesn't fold it.
  let shut = 0;
  box.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    clearTimeout(shut);
    fan(true);
  });
  box.addEventListener('pointerout', (e) => {
    if (e.pointerType === 'touch' || box.contains(e.relatedTarget)) return;
    shut = setTimeout(() => fan(box.matches(':focus-within')), 180);
  });
  box.addEventListener('focusin', () => {
    fan(true);
  });
  box.addEventListener('focusout', () => {
    setTimeout(() => fan(box.matches(':hover, :focus-within')));
  });
  // On a phone a tap on the folded stack opens it; a tap outside folds it again.
  box.addEventListener('click', (e) => {
    if (!box.classList.contains('open') && live().length > 1 && !e.target.closest('button')) fan(true);
  });
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' && !box.contains(e.target)) fan(false);
  });
  addEventListener('resize', () => {
    for (const t of live()) delete t.dataset.h;
    layout();
  });
  return box;
}

function fan(on) {
  if (on && live().length < 2) on = false;
  box.classList.toggle('open', on);
  for (const t of live()) (on || box.matches(':hover, :focus-within') ? t.hold : t.go)?.();
  layout();
}

// Newest first: the front card sits at the bottom; folded, the others peek out above it, smaller
// and dimmer; fanned, they stand in a column at their own height.
function layout() {
  const ts = live().reverse();
  const open = box.classList.contains('open') && ts.length > 1;
  for (const t of ts) t.dataset.h ||= t.firstElementChild.offsetHeight + 2; // + its 1px borders
  const front = Number(ts[0]?.dataset.h || 0);
  let y = 0;
  ts.forEach((t, i) => {
    t.style.setProperty('--y', `${open ? -y : -i * 10}px`);
    t.style.setProperty('--s', open ? 1 : 1 - i * 0.05);
    t.style.height = `${open || !i ? t.dataset.h : front}px`;
    t.classList.toggle('behind', i > 0 && !open);
    t.style.zIndex = String(ts.length - i);
    y += Number(t.dataset.h) + GAP;
  });
  box.style.height = `${open ? y - GAP : front}px`;
  box.classList.toggle('many', open);
}

export function toast(html, { tone = '', action, timeout = 4200, glyph: face, onClose } = {}) {
  stack();
  keepClear();
  // The same message again (a double click, a retry) brings the one showing back to the front
  // with a fresh timer instead of stacking a twin.
  const twin = live().find((t) => t.dataset.msg === html);
  twin?.onClose?.();
  twin?.remove();
  // A face (a crew member's avatar) or the icon a message starts with becomes the glyph; otherwise
  // errors get a warning and the rest a small wisp of light.
  const lead = !face && /^\s*(<svg class="i[^"]*"[^>]*>.*?<\/svg>)\s*/s.exec(html);
  const glyph = face || (lead ? lead[1] : tone === 'bad' ? icon('warn') : '<i class="t-orb"></i>');
  const t = el(`<div class="toast ${tone}" role="${tone === 'bad' ? 'alert' : 'status'}"><div class="t-in">
    <span class="t-glyph${face ? ' face' : ''}">${glyph}</span>
    <span class="t-msg">${lead ? html.slice(lead[0].length) : html}</span>
    ${action ? `<button class="t-act">${esc(action.label)}</button>` : ''}
    <button class="t-x" aria-label="Close" title="Close">${icon('x')}<svg class="t-time" viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="12.5" pathLength="100"/></svg></button>
  </div></div>`);
  t.dataset.msg = html;
  t.onClose = onClose; // once it goes, however it goes (its clock, ×, a swipe, Undo, a newer twin)
  t.style.setProperty('--t-life', `${timeout}ms`);
  const close = () => dismiss(t);
  t.querySelector('.t-x').onclick = () => {
    close();
  };
  if (action) {
    t.querySelector('.t-act').onclick = () => {
      action.run();
      close();
    };
  }
  // Its clock stops while the stack is open, so there's time to read and act.
  let left = timeout;
  let since = Date.now();
  let timer = setTimeout(close, left);
  t.hold = () => {
    if (t.classList.contains('held')) return;
    t.classList.add('held');
    clearTimeout(timer);
    left -= Date.now() - since;
  };
  t.go = () => {
    if (!t.classList.contains('held')) return;
    t.classList.remove('held');
    since = Date.now();
    timer = setTimeout(close, Math.max(left, 1200));
  };
  swipeAway(t, close);
  box.append(t);
  if (box.classList.contains('open')) t.hold();
  for (const x of live().slice(0, -KEEP)) dismiss(x);
  layout();
  return t;
}

// It drops and fades where it stands; the ones behind move up to the front.
function dismiss(t) {
  if (t.classList.contains('out')) return;
  t.classList.add('out');
  t.onClose?.();
  t.hold?.();
  if (live().length < 2) fan(false);
  else layout();
  setTimeout(() => t.remove(), 300);
}

// On a touch screen a flick down (or sideways) sends the front one away.
function swipeAway(t, close) {
  let x0 = 0;
  let y0 = 0;
  let on = false;
  t.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || e.target.closest('button') || t.classList.contains('behind')) return;
    on = true;
    x0 = e.clientX;
    y0 = e.clientY;
    t.classList.add('drag');
  });
  t.addEventListener('pointermove', (e) => {
    if (!on) return;
    const dx = e.clientX - x0;
    const dy = Math.max(0, e.clientY - y0);
    t.style.setProperty('--dx', `${Math.abs(dx) > dy ? dx : 0}px`);
    t.style.setProperty('--dy', `${Math.abs(dx) > dy ? 0 : dy}px`);
    t.style.opacity = String(1 - Math.min(1, Math.max(Math.abs(dx), dy) / 160));
  });
  const end = (e) => {
    if (!on) return;
    on = false;
    t.classList.remove('drag');
    const far = Math.abs(e.clientX - x0) > 70 || e.clientY - y0 > 40;
    t.style.removeProperty('--dx');
    t.style.removeProperty('--dy');
    t.style.opacity = '';
    if (far) close();
  };
  t.addEventListener('pointerup', end);
  t.addEventListener('pointercancel', end);
}

// An error (usually the server refusing something) as a red toast.
export const toastError = (err, opts) => toast(esc(err.message), { tone: 'bad', ...opts });

// Run an action that talks to the server; a failure shows as a red toast instead of throwing.
// Resolves to what `fn` returns, or undefined when it failed.
export async function tryApi(fn, opts) {
  try {
    return await fn();
  } catch (err) {
    toastError(err, opts);
  }
}
