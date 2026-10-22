// "Runs on" for one task: pick this computer or a machine for a follow-up or a rerun. The
// launcher's own menu (several places at once) is whereMenu in launcher.js.

import { esc } from '../md.js';
import * as bus from '../core/bus.js';
import { $, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { popover } from '../ui/popover.js';
import { MACHINE_STATE, machineById, placeName } from './places.js';

// One place for a follow-up or a rerun: this computer or a machine. from: where the task is now.
// locked: why it can't move right now (a running task), shown instead of a choice.
// back: the prompt it's for, where the caret goes once it closes.
export function placeMenu(anchor, { title, current, from, note = '', locked = '', back }, pick) {
  if ($('.menu.place-menu')) return $('.menu.place-menu').close(), back?.focus();
  const box = el(`<div class="menu where-menu place-menu" role="menu"></div>`);
  const paint = () => {
    const row = (k) => {
      const m = k ? machineById(k) : null;
      const st = m ? m.state : 'online';
      const on = k === current;
      const sub = k === from ? 'Where it is now' : m ? (st === 'online' ? m.target : `${m.target} · ${MACHINE_STATE[st]}`) : 'Where wisp runs';
      return `<button class="wm-row ${on ? 'on' : ''}" data-k="${k}" role="menuitemradio" aria-checked="${on}" ${locked && k !== from ? 'disabled' : ''}>
        <span class="wm-check">${icon('check')}</span>
        <span class="wm-icon">${icon(k ? 'server' : 'laptop')}${m ? `<i class="dot ${st === 'online' ? 'ok' : st === 'error' ? 'bad' : ''}"></i>` : ''}</span>
        <span class="wm-name"><b>${esc(placeName(k))}</b><small>${esc(sub)}</small></span>
      </button>`;
    };
    box.innerHTML = `<div class="wm-h">${esc(title)}</div>${locked || note ? `<p class="wm-note ${locked ? 'warn' : ''}">${esc(locked || note)}</p>` : ''}${row('')}${S.machines.map((m) => row(m.id)).join('')}`;
  };
  box.onclick = (e) => {
    const r = e.target.closest('.wm-row:not([disabled])');
    if (!r) return;
    shut();
    pick(r.dataset.k);
    back?.focus();
  };
  paint();
  const shut = popover(box, { anchor, back, onClose: () => anchor.setAttribute('aria-expanded', 'false') });
  bus.on('machines', paint, { node: box });
  anchor.setAttribute('aria-expanded', 'true');
  const r = anchor.getBoundingClientRect();
  const h = box.offsetHeight;
  box.style.left = `${Math.max(8, Math.min(r.left, innerWidth - box.offsetWidth - 8))}px`;
  box.style.top = `${r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
}
