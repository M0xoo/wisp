// Drag to reorder chips or rows. The one picked up follows the pointer, a line marks where it will
// land, and letting go there calls onDrop(id, to, after). A mouse drags once it moves a few pixels,
// so a click stays a click; a finger holds still first (HOLD ms), so the list still scrolls and a
// tap still picks. Escape puts it back. Nothing is re-inserted: the caller repaints the new order.
//
//   box       the element the items are in; repainting its insides keeps the drag working
//   item      selector of what can be dragged (and dropped next to), inside box
//   axis      'x' for chips in a row (left/right of one), 'y' for rows (above/below)
//   onDrop    (id, to, after) => …: id goes just before `to`, or just after it
//   ok        (event) => bool, whether this press may start a drag (a search typed: no)
//   onEnd     () => …, once a drag is over, dropped or not, before onDrop: a repaint held off
//             while it ran (box has .reordering then) can go now

const HOLD = 300;
const SLOP = 5; // px a mouse moves before it's a drag
const wired = new WeakSet();

export function reorderable(box, { item, axis = 'x', onDrop, onEnd = () => {}, ok = () => true }) {
  if (!box || wired.has(box)) return;
  wired.add(box);
  box.addEventListener('pointerdown', (e) => {
    const node = e.target.closest(item);
    if (!node || !box.contains(node) || e.button !== 0 || !node.dataset.id || !ok(e)) return;
    if (e.target.closest('input, textarea, [contenteditable], [data-no-drag]')) return;
    press(e, box, node, { item, axis, onDrop, onEnd });
  });
}

function press(e, box, node, { item, axis, onDrop, onEnd }) {
  const touch = e.pointerType === 'touch';
  const x0 = e.clientX;
  const y0 = e.clientY;
  let armed = !touch; // a finger has to hold first
  let drag = null; // { items, mark } once it's moving
  const hold = touch && setTimeout(() => (armed = true), HOLD);
  // While dragging with a finger the page mustn't scroll under it.
  const noScroll = (ev) => drag && ev.cancelable && ev.preventDefault();
  const start = () => {
    const items = [...box.querySelectorAll(item)].filter((n) => n.dataset.id && !n.hidden && n.offsetParent);
    if (items.length < 2) return end();
    drag = { items: items.map((n) => ({ n, r: n.getBoundingClientRect() })), at: null };
    // Chips all on one line (the top bar's, which clips) slide along it only.
    drag.flat = axis === 'y' || drag.items.every((x) => Math.abs(x.r.top - drag.items[0].r.top) < 2);
    try {
      node.setPointerCapture(e.pointerId);
    } catch {}
    box.classList.add('reordering');
    node.classList.add('dragged');
    // A mouse drag would otherwise select the text it passes over (a row's name, say).
    getSelection()?.removeAllRanges();
    document.documentElement.style.userSelect = 'none';
  };
  const mark = (to, after) => {
    if (drag.at?.n === to && drag.at.after === after) return;
    drag.at?.n.classList.remove('drop-before', 'drop-after');
    drag.at = to && { n: to, after };
    to?.classList.add(after ? 'drop-after' : 'drop-before');
  };
  const move = (ev) => {
    if (ev.pointerId !== e.pointerId || drag?.off) return;
    const dx = ev.clientX - x0;
    const dy = ev.clientY - y0;
    if (!drag) {
      if (Math.hypot(dx, dy) < SLOP) return;
      if (!armed) return end(); // a finger that moved before holding: it's scrolling
      start();
      if (!drag) return;
    }
    node.style.translate = axis === 'y' ? `0 ${dy}px` : `${dx}px ${drag.flat ? 0 : dy}px`; // in its column or line (and its box's clip)
    // The nearest item to the pointer, as it was laid out when the drag began; which side of it by
    // the axis. Over its own old place: no line, nothing moves.
    let best = null;
    let d = Infinity;
    for (const it of drag.items) {
      const cx = Math.max(it.r.left, Math.min(ev.clientX, it.r.right));
      const cy = Math.max(it.r.top, Math.min(ev.clientY, it.r.bottom));
      const dist = Math.hypot(ev.clientX - cx, ev.clientY - cy);
      if (dist < d) (d = dist), (best = it);
    }
    if (!best || best.n === node) return mark(null);
    const after = axis === 'y' ? ev.clientY > best.r.top + best.r.height / 2 : ev.clientX > best.r.left + best.r.width / 2;
    // Just before the next one, or just after the one before, is where it already is.
    const i = drag.items.findIndex((x) => x.n === node);
    const j = drag.items.indexOf(best);
    if ((after && j === i - 1) || (!after && j === i + 1)) return mark(null);
    mark(best.n, after);
  };
  const key = (ev) => {
    if (ev.key !== 'Escape' || !drag) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    // Back where it was; still held, so letting go is no click either.
    mark(null);
    drag.off = true;
    node.style.translate = '';
    node.classList.remove('dragged');
  };
  const up = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    const at = drag?.at;
    const was = !!drag;
    end();
    if (!was) return;
    // The click that ends a drag isn't a pick.
    const eat = (c) => {
      c.preventDefault();
      c.stopImmediatePropagation();
    };
    window.addEventListener('click', eat, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', eat, { capture: true }), 0);
    if (at && ev.type === 'pointerup') onDrop(node.dataset.id, at.n.dataset.id, at.after);
  };
  // A long press opens the menu on a phone: that wins over a drag that hasn't moved yet.
  const menu = (ev) => {
    if (drag) ev.preventDefault();
    else end();
  };
  function end() {
    clearTimeout(hold);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    window.removeEventListener('keydown', key, true);
    window.removeEventListener('touchmove', noScroll);
    node.removeEventListener('contextmenu', menu);
    if (drag) {
      drag.at?.n.classList.remove('drop-before', 'drop-after');
      box.classList.remove('reordering');
      node.classList.remove('dragged');
      node.style.translate = '';
      document.documentElement.style.userSelect = '';
      drag = null;
      onEnd();
    }
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  window.addEventListener('keydown', key, true);
  window.addEventListener('touchmove', noScroll, { passive: false });
  node.addEventListener('contextmenu', menu);
}
