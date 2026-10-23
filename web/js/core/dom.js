// DOM helpers. el (an element from an HTML string) and icon (a sprite <svg>) live with the block
// renderers, which use them too.

export { el, icon } from '../blocks.js';

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

// Reading layout (fitting chips into a row, measuring a box) right after a render's DOM writes makes
// the browser lay out the page there and then, and again for the next read after more writes. Asked
// for here, fn runs once just before the next frame paints, on the layout that frame needs anyway,
// however often it was asked for meanwhile. Nothing shows in between: the frame paints after it.
const soon = new Set();
export function beforePaint(fn) {
  if (soon.has(fn)) return;
  soon.add(fn);
  requestAnimationFrame(() => {
    soon.delete(fn);
    fn();
  });
}
