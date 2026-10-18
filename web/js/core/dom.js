// DOM helpers. el (an element from an HTML string) and icon (a sprite <svg>) live with the block
// renderers, which use them too.

export { el, icon } from '../blocks.js';

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
