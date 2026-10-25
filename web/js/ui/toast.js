import { $, el } from '../core/dom.js';
import { esc } from '../md.js';

// Toasts sit low and centred, where an open task's docked reply box is (or a crew thread's box, or
// the crew editor's buttons on a phone): lift them above it so they never cover its buttons, and
// keep checking while any show (a task opened under a toast).
let watch = 0;
function keepClear() {
  clearDock();
  watch ||= setInterval(() => {
    if ($('#toasts').childElementCount) return clearDock();
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

export function toast(html, { tone = '', action, timeout = 4200 } = {}) {
  keepClear();
  const t = el(`<div class="toast ${tone}"><span>${html}</span>${action ? `<button class="link">${esc(action.label)}</button>` : ''}</div>`);
  if (action) t.querySelector('button').onclick = () => (action.run(), t.remove());
  $('#toasts').append(t);
  setTimeout(() => t.classList.add('out'), timeout);
  setTimeout(() => t.remove(), timeout + 400);
  return t;
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
