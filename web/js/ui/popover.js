// Menus and popovers floating over the page. A mousedown anywhere else closes them; the button
// that opened one (`anchor`) doesn't count, so clicking it again can toggle. Callers build and
// position the node; this appends it and owns closing.
//
//   anchor   the button that opened it
//   keep     selector for other floating parts (a picker it opened) whose clicks keep it open
//   capture  watch for outside clicks in the capture phase
//   escape   close on Escape, wherever focus is
//   onClose  runs once it's gone
//
// Returns close, which is also set as node.close.
export function popover(node, { anchor, keep, capture = false, escape = false, onClose } = {}) {
  let open = true;
  const outside = (e) => {
    if (node.contains(e.target) || anchor?.contains(e.target) || (keep && e.target.closest?.(keep))) return;
    close();
  };
  const keys = (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  };
  function close() {
    if (!open) return;
    open = false;
    clearTimeout(arm);
    node.remove();
    document.removeEventListener('mousedown', outside, capture);
    document.removeEventListener('keydown', keys, true);
    onClose?.();
  }
  // Not yet: the mousedown that opened it is still going on.
  const arm = setTimeout(() => document.addEventListener('mousedown', outside, capture));
  if (escape) document.addEventListener('keydown', keys, true);
  node.close = close;
  document.body.append(node);
  return close;
}
