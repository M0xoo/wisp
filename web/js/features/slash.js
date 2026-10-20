// The / menu in a follow-up box: type "/" to see the commands, pick one with ↑↓ and Tab (or Enter,
// or a click) and the box reads "/btw " ready for the rest. Esc closes it.

import { esc } from '../md.js';
import { el } from '../core/dom.js';
import { SLASH, slashMatches } from '../slash-text.js';
import { feedbackOn } from './feedback.js';
import { activeSpells } from './spells.js';

// Register before the box's own Enter handler: picking a command must not send it.
export function slashMenu(ta, host) {
  const menu = el('<div class="slash-menu" role="listbox" aria-label="Commands" hidden></div>');
  host.append(menu);
  let items = [];
  let sel = 0;
  let closed = false; // Esc: hidden until the text changes
  const commands = () => [...SLASH.filter((c) => c.name !== 'feedback' || feedbackOn()), ...activeSpells().flatMap((s) => (s.slash || []).map((c) => ({ name: c.name, args: c.args || '', hint: c.hint || `From ${s.name}` })))];
  const paint = () => {
    const next = !closed && document.activeElement === ta ? slashMatches(ta.value, commands()) : [];
    if (next.map((c) => c.name).join() !== items.map((c) => c.name).join()) sel = 0;
    items = next;
    menu.hidden = !items.length;
    menu.innerHTML = items
      .map((c, i) => `<button type="button" class="slash-item${i === sel ? ' on' : ''}" role="option" aria-selected="${i === sel}" data-i="${i}"><b>/${c.name}</b><span class="slash-args">${esc(c.args)}</span><span class="slash-hint">${esc(c.hint)}</span></button>`)
      .join('');
  };
  const pick = (c) => {
    ta.value = `/${c.name} `;
    ta.dispatchEvent(new Event('input'));
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  };
  ta.addEventListener('input', () => {
    closed = false;
    paint();
  });
  ta.addEventListener('focus', paint);
  ta.addEventListener('blur', paint);
  menu.addEventListener('mousedown', (e) => e.preventDefault()); // keep the focus in the box
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (b) pick(items[b.dataset.i]);
  });
  ta.addEventListener('keydown', (e) => {
    if (menu.hidden || e.isComposing) return;
    const c = items[sel];
    // Enter on a command typed out in full that works on its own (/feedback opens the dialog) sends it.
    const complete = (e.key === 'Tab' && !e.shiftKey) || (e.key === 'Enter' && !e.shiftKey && !(c.bare && ta.value.slice(1).toLowerCase() === c.name));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      paint();
    } else if (complete) {
      e.preventDefault();
      e.stopImmediatePropagation();
      pick(c);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closed = true;
      paint();
    }
  });
}
