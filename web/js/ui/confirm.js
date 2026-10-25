// Asking before something that's hard to take back, in wisp's own small box instead of the
// browser's confirm(): it names the action on its button ("Delete recipe", not "OK"), doesn't
// freeze the page, and sits by the button that asked (or at the top when there's none, a
// shortcut). Resolves true for the action; Escape, Cancel or a click elsewhere resolve false.
// alt: a second action's label (resolves 'alt'), for a choice between two ways to go on;
// altDanger when that one deletes something.
import { esc } from '../md.js';
import { el } from '../core/dom.js';

export async function ask(text, { ok = 'Continue', alt = '', altDanger = false, danger = false, anchor = null } = {}) {
  // Loaded on use: blocks.js asks too, and its tests run without a document.
  const { popover } = await import('./popover.js');
  return new Promise((resolve) => {
    const [head, ...rest] = String(text).split('\n\n');
    const node = el(`<div class="menu ask-pop" role="alertdialog" aria-modal="false">
      <p class="ap-q">${esc(head)}</p>${rest.length ? `<p class="ap-more">${esc(rest.join('\n\n'))}</p>` : ''}
      <div class="ap-acts"><button class="ghost sm" data-a="no">Cancel</button>${alt ? `<button class="ghost sm${altDanger ? ' danger' : ''}" data-a="alt">${esc(alt)}</button>` : ''}<button class="primary sm ${danger ? 'bad' : ''}" data-a="yes">${esc(ok)}</button></div>
    </div>`);
    let answer = false;
    const close = popover(node, { anchor, capture: true, onClose: () => resolve(answer) });
    node.onclick = (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      answer = a === 'alt' ? 'alt' : a === 'yes';
      close();
      anchor?.isConnected && anchor.focus();
    };
    const r = anchor?.isConnected && anchor.getBoundingClientRect();
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    const x = r ? r.right - w : (innerWidth - w) / 2;
    const y = r ? (r.bottom + 6 + h < innerHeight - 8 ? r.bottom + 6 : r.top - 6 - h) : innerHeight * 0.18;
    node.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
    node.style.top = `${Math.max(8, Math.min(y, innerHeight - h - 8))}px`;
    node.querySelector('[data-a="yes"]').focus();
  });
}
