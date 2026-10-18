import { $, el } from '../core/dom.js';
import { esc } from '../md.js';

export function toast(html, { tone = '', action, timeout = 4200 } = {}) {
  const t = el(`<div class="toast ${tone}"><span>${html}</span>${action ? `<button class="link">${esc(action.label)}</button>` : ''}</div>`);
  if (action) t.querySelector('button').onclick = () => (action.run(), t.remove());
  $('#toasts').append(t);
  setTimeout(() => t.classList.add('out'), timeout);
  setTimeout(() => t.remove(), timeout + 400);
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
