// Menus and popovers floating over the page. A mousedown anywhere else closes them; the button
// that opened one (`anchor`) doesn't count, so clicking it again can toggle. Escape closes the
// newest one, wherever focus is, and puts focus back on its anchor. Callers build and position
// the node; this appends it and owns closing.
//
//   anchor   the button that opened it
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
    top.anchor?.focus();
  },
  true,
);

export function popover(node, { anchor, keep, capture = false, onClose } = {}) {
  let open = true;
  const outside = (e) => {
    if (node.contains(e.target) || anchor?.contains(e.target) || (keep && e.target.closest?.(keep))) return;
    close();
  };
  const entry = { close, anchor };
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
