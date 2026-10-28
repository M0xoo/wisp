import { onBack } from './back.js';

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
//   onEscape returns true when it took Escape itself (a step back inside it): it stays open
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
    if (top.onEscape?.()) return;
    top.close();
    (top.back || top.anchor)?.focus();
  },
  true,
);

export function popover(node, { anchor, keep, capture = false, back, onClose, onEscape } = {}) {
  let open = true;
  const outside = (e) => {
    if (node.contains(e.target) || anchor?.contains(e.target) || (keep && e.target.closest?.(keep))) return;
    close();
    // A click on the box around the text (not one of its buttons): after the click's own focus change.
    const box = back?.closest('.launcher, .composer');
    if (box?.contains(e.target) && !e.target.closest('button, a, input, textarea, select')) setTimeout(() => back.focus());
  };
  const entry = { close, anchor, back, onEscape };
  const backDone = onBack(close); // the phone's Back closes it (ui/back.js)
  function close() {
    if (!open) return;
    open = false;
    backDone();
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
  // A phone's keyboard leaves half the screen: a menu opened from the prompt box's buttons gets all
  // of it (not one that follows the typing, anchored to the box itself).
  const typing = document.activeElement;
  if (TOUCH.matches && anchor && anchor !== typing && typing?.matches('textarea, input')) typing.blur();
  document.body.append(node);
  // Callers place it right after this returns: then keep it on screen, and again whenever the
  // visible area changes (the keyboard going down, a rotated phone).
  const refit = () => open && fitToScreen(node, anchor);
  requestAnimationFrame(refit);
  const vv = window.visualViewport || window;
  vv.addEventListener('resize', refit);
  addEventListener('resize', refit);
  const off = onClose;
  onClose = () => {
    vv.removeEventListener('resize', refit);
    removeEventListener('resize', refit);
    off?.();
  };
  return close;
}

// A touch screen: picking from a menu doesn't bring the keyboard back up (refocus skips it).
export const TOUCH = matchMedia('(hover: none) and (pointer: coarse)');

// Put the caret back in the prompt a menu served, except on a touch screen, where focusing it
// would pop the keyboard up over what you just picked.
export function refocus(box) {
  if (box && !TOUCH.matches) box.focus();
}

// Keep a floating node inside the visible area (the visual viewport: what the keyboard leaves).
// Anchored ones go above or below their button, whichever has room, and scroll inside when
// neither has enough. Reads offset sizes: the pop-in animation scales the first frame down.
export function fitToScreen(node, anchor) {
  if (!node.isConnected) return;
  const vv = window.visualViewport;
  const top = (vv?.offsetTop || 0) + 8;
  const bottom = (vv ? vv.offsetTop + vv.height : innerHeight) - 8;
  const left = (vv?.offsetLeft || 0) + 8;
  const right = (vv ? vv.offsetLeft + vv.width : innerWidth) - 8;
  node.style.maxHeight = '';
  const w = Math.min(node.offsetWidth, right - left);
  const h = node.offsetHeight;
  const cs = getComputedStyle(node);
  let y = parseFloat(cs.top);
  const x = parseFloat(cs.left);
  if (Number.isNaN(y)) return; // not placed yet
  const a = anchor?.isConnected && anchor.getBoundingClientRect();
  // Only anchored nodes that sit above or below their button move to the roomier side.
  if (a && a.height && (y >= a.bottom - 1 || y + h <= a.top + 1)) {
    const above = a.top - 6 - top;
    const below = bottom - a.bottom - 6;
    const up = y + h <= a.top + 1 ? h <= above || above > below : h > below && above > below;
    const room = up ? above : below;
    if (h > room) node.style.maxHeight = `${Math.max(120, room)}px`;
    y = up ? a.top - 6 - Math.min(h, Math.max(120, room)) : a.bottom + 6;
  } else if (h > bottom - top) {
    node.style.maxHeight = `${bottom - top}px`;
    y = top;
  } else y = Math.min(Math.max(y, top), bottom - h);
  if (node.style.maxHeight && cs.overflowY === 'visible') node.style.overflowY = 'auto';
  node.style.bottom = 'auto';
  node.style.top = `${Math.max(top, y)}px`;
  if (!Number.isNaN(x)) node.style.left = `${Math.max(left, Math.min(x, right - w))}px`;
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
