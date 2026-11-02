// A <select> in wisp's own menu kit, not the OS's list. The select stays (hidden) as the value
// holder, so the code around it keeps reading .value and hearing `change`; a button of the form
// kit's shape shows its choice and opens a .menu of its options. Touch screens keep the OS picker:
// a phone's wheel is the better list there.

import { esc } from '../md.js';
import { el, icon } from '../core/dom.js';
import { popover, TOUCH } from './popover.js';

const NATIVE = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');

export function kitSelect(sel) {
  if (sel.dataset.kit || sel.multiple || TOUCH.matches) return;
  sel.dataset.kit = '1';
  const btn = el(`<button type="button" class="kit-sel" aria-haspopup="listbox" aria-expanded="false"></button>`);
  const paint = () => {
    const text = sel.selectedOptions[0]?.text || '';
    const html = `<span>${esc(text)}</span>${icon('chevron', 'chev')}`;
    if (btn.dataset.h !== html) (btn.innerHTML = html), (btn.dataset.h = html);
    btn.disabled = sel.disabled;
    btn.setAttribute('aria-label', `${sel.getAttribute('aria-label') || sel.name || ''}: ${text}`.replace(/^: /, ''));
    btn.title = sel.title || '';
  };
  // Code that sets .value (a repaint, a spell's lock) is shown too, not only a pick
  Object.defineProperty(sel, 'value', { configurable: true, get: () => NATIVE.get.call(sel), set: (v) => (NATIVE.set.call(sel, v), paint()) });
  new MutationObserver(paint).observe(sel, { attributes: true, attributeFilter: ['disabled', 'aria-label'], childList: true, subtree: true });
  sel.addEventListener('change', paint);
  // As wide as the select was: a full-width field stays one
  if (sel.classList.contains('input') || (sel.offsetWidth && sel.offsetWidth >= sel.parentElement.clientWidth - 2)) btn.style.width = '100%';
  sel.hidden = true;
  sel.after(btn);
  paint();
  btn.onclick = () => {
    if (btn.getAttribute('aria-expanded') === 'true') return;
    const r = btn.getBoundingClientRect();
    const menu = el(`<div class="menu kit-menu" role="listbox" aria-label="${esc(sel.getAttribute('aria-label') || '')}" style="top:${r.bottom + 4}px;left:${r.left}px;min-width:${r.width}px">${[...sel.options]
      .map((o, i) => `<button type="button" role="option" data-i="${i}" aria-selected="${o.selected}" class="${o.selected ? 'on' : ''}"${o.disabled ? ' disabled' : ''}><span>${esc(o.text)}</span>${o.selected ? icon('check', 'mi-on') : ''}</button>`)
      .join('')}</div>`);
    btn.setAttribute('aria-expanded', 'true');
    const close = popover(menu, { anchor: btn, back: btn, onClose: () => btn.setAttribute('aria-expanded', 'false') });
    menu.onclick = (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      close();
      btn.focus();
      if (sel.selectedIndex === Number(b.dataset.i)) return;
      sel.selectedIndex = Number(b.dataset.i);
      paint();
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      sel.dispatchEvent(new Event('input', { bubbles: true }));
    };
    // ↑ ↓ through the options, from the one picked
    menu.onkeydown = (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const all = [...menu.querySelectorAll('button:not([disabled])')];
      const i = all.indexOf(document.activeElement);
      all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
    };
    (menu.querySelector('.on') || menu.querySelector('button'))?.focus();
  };
}

// Every select in node, now and as it repaints (dialogs and Settings panes redraw their rows).
export function kitSelects(node) {
  if (TOUCH.matches) return;
  const run = () => node.querySelectorAll('select:not([data-kit]):not([multiple])').forEach(kitSelect);
  run();
  new MutationObserver(run).observe(node, { childList: true, subtree: true });
}
