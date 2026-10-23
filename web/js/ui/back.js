// The phone app's Back button (mobile/: MainActivity goes back in the WebView). Without history
// entries of its own, Back from an open dialog, menu or task would leave wisp for the app's list of
// computers. Each thing Back should close takes an entry (onBack); Back closes the newest one.
// Closed some other way (its ×, a tap outside), its entry stays and the next one opened reuses it:
// calling history.back() there would race the pushState of whatever opens next.

import { MOBILE } from '../core/state.js';

const stack = []; // what Back closes, oldest first; null once it closed some other way

// How many entries wisp holds above the page's own, for leaving the page in one step.
export const backDepth = () => stack.length;

// Returns what to call when it closed by other means.
export function onBack(close) {
  if (!MOBILE) return () => {};
  let i = stack.length - 1;
  if (i >= 0 && stack[i] === null) stack[i] = close;
  else {
    stack.push(close);
    i = stack.length - 1;
    history.pushState({ ...history.state, wispBack: stack.length }, '');
  }
  return () => {
    if (stack[i] === close) stack[i] = null;
  };
}

if (MOBILE)
  addEventListener('popstate', (e) => {
    // An older app sets location.hash for a tapped notification: a new entry, not a Back.
    if (!e.state?.wispBack && location.hash.startsWith('#/s/')) return;
    const depth = e.state?.wispBack || 0;
    let closed = false;
    while (stack.length > depth) {
      const close = stack.pop();
      if (close) (close(), (closed = true));
    }
    // Only entries closed another way: this Back showed nothing, so it takes the next step too
    // (from the page's own entry, that's back to the list of computers).
    if (!closed) history.back();
  });
