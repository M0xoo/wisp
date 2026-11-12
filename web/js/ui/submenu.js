import { icon } from '../core/dom.js';

// A long menu's sections and submenus (design/ux.md → Task menus). Submenus drill in: the row's
// items take the menu's place, under a Back row, so the menu keeps its spot and width on every
// screen (no flyout that runs off a phone or closes when the pointer crosses a gap).

// Groups with a line between them; empty items and empty groups drop out.
export const sectionsHtml = (groups) =>
  groups
    .map((g) => g.filter(Boolean).join(''))
    .filter(Boolean)
    .join('<div class="wm-sep" role="separator"></div>');

// Two or more items fold under one row named for them; one stays where it is.
export function subHtml(key, label, ic, items) {
  const xs = items.filter(Boolean);
  if (xs.length < 2) return xs.join('');
  return (
    `<button data-sub="${key}" aria-haspopup="menu" aria-expanded="false">${icon(ic)}${label}${icon('chevron', 'mi-sub')}</button>` +
    `<div class="mi-pane" data-of="${key}" role="group" aria-label="${label}" hidden><button data-back class="mi-back">${icon('back')}${label}</button>${xs.join('')}</div>`
  );
}

// Wire a menu's submenus. Call before popover(); pass the returned escape as its onEscape, so
// Escape inside a submenu steps back to the menu instead of closing it.
export function wireSubmenus(menu, anchor) {
  let pane = null;
  const show = (key) => {
    const r = menu.getBoundingClientRect();
    const a = anchor?.isConnected && anchor.getBoundingClientRect();
    const up = a && a.height && r.bottom <= a.top + 1; // opened above its button: keep its bottom edge
    menu.style.minWidth = `${menu.offsetWidth}px`; // the same width in and out of a submenu
    const was = pane;
    pane = key ? menu.querySelector(`.mi-pane[data-of="${key}"]`) : null;
    menu.classList.toggle('drilled', !!pane);
    for (const p of menu.querySelectorAll('.mi-pane')) p.hidden = p !== pane;
    for (const b of menu.querySelectorAll('[data-sub]')) b.setAttribute('aria-expanded', String(b.dataset.sub === key));
    if (up) menu.style.top = `${Math.max(8, r.bottom - menu.offsetHeight)}px`;
    else if (r.top + menu.offsetHeight > innerHeight - 8) menu.style.top = `${Math.max(8, innerHeight - 8 - menu.offsetHeight)}px`; // a taller pane stays on screen
    (pane ? pane.querySelector('button:not([data-back])') : was && menu.querySelector(`[data-sub="${was.dataset.of}"]`))?.focus({ preventScroll: true });
  };
  // Capture: before the menu's own click handler, which runs the item and closes the menu.
  menu.addEventListener(
    'click',
    (e) => {
      const sub = e.target.closest('[data-sub]');
      const back = e.target.closest('[data-back]');
      if (!sub && !back) return;
      e.stopPropagation();
      show(sub ? sub.dataset.sub : null);
    },
    true,
  );
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' && e.target.matches?.('[data-sub]')) show(e.target.dataset.sub);
    else if (e.key === 'ArrowLeft' && pane) show(null);
    else return;
    e.preventDefault();
  });
  return () => {
    if (!pane) return false;
    show(null);
    return true;
  };
}
