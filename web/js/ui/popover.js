// Menus and popovers floating over the page. A mousedown anywhere else closes them; the button
// that opened one (`anchor`) doesn't count, so clicking it again can toggle. Escape closes the
// newest one, wherever focus is, and puts focus back on its anchor. Callers build and position
// the node; this appends it and owns closing.
//
//   anchor   the button that opened it
//   back     the text box it serves: Escape, or a click elsewhere in that box, puts the caret back
//            there instead of on the anchor, so you go on typing
//   keep     selector for other floating parts (a picker it opened) whose clicks keep it open
//   capture  watch for outside clicks in the capture phase
//   onClose  runs once it's gone
//
// Returns close, which is also set as node.close.

const stack = []; // open popovers, newest last

document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape' || !stack.length) return;
    // Only the newest: a picker opened from the subagents popover closes alone. Nothing behind it
    // (the page's own Escape, which collapses the focused card) sees the key.
    e.preventDefault();
    e.stopImmediatePropagation();
    const top = stack.at(-1);
    top.close();
    (top.back || top.anchor)?.focus();
  },
  true,
);

export function popover(node, { anchor, keep, capture = false, back, onClose } = {}) {
  let open = true;
  const outside = (e) => {
    if (node.contains(e.target) || anchor?.contains(e.target) || (keep && e.target.closest?.(keep))) return;
    close();
    // A click on the box around the text (not one of its buttons): after the click's own focus change.
    const box = back?.closest('.launcher, .composer');
    if (box?.contains(e.target) && !e.target.closest('button, a, input, textarea, select')) setTimeout(() => back.focus());
  };
  const entry = { close, anchor, back };
  function close() {
    if (!open) return;
    open = false;
    clearTimeout(arm);
    stack.splice(stack.indexOf(entry), 1);
    node.remove();
    document.removeEventListener('mousedown', outside, capture);
    onClose?.();
  }
  // Not yet: the mousedown that opened it is still going on.
  const arm = setTimeout(() => document.addEventListener('mousedown', outside, capture));
  stack.push(entry);
  node.close = close;
  document.body.append(node);
  return close;
}

// Keep a right-click menu at the pointer but on-screen near the window edges. Reads offset
// sizes: the menu's pop-in animation starts scaled down, so its bounding box is too small
// on the first frame and the last items would end up below the fold.
export function clampToViewport(node, x, y) {
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  node.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
  node.style.top = `${Math.max(8, Math.min(y, innerHeight - h - 8))}px`;
}
