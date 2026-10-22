// The project list: every project in a searchable list, for when there are too many to show as
// chips. The launcher's "in" row and the top bar's filter both open it from a "+N" chip.
//
//   projects  the list, in the order to show it (recent first)
//   current   the picked id, checked and scrolled to
//   meta(p)   extra html after a row's name (status badges)
//   extras    [{ id, label, icon }] fixed rows under the list (No folder, Other folder…)
//   onPick    (id) => …, a project's id or an extra's
//   also      { has(id), toggle(id) }: each row gets a + that adds the project to the task (✓ once
//             it's in) without closing the list; ⌘/Ctrl/Shift+Enter does the same from the keyboard
//   back      the prompt it's for, where the caret goes once it closes

import { esc } from '../md.js';
import { $, el, icon } from '../core/dom.js';
import { fuzzy, highlight } from '../fuzzy.js';
import { popover } from '../ui/popover.js';
import { projectTitle } from './places.js';

export function projectList(anchor, { projects, current, meta = () => '', extras = [], onPick, also = null, label = 'Projects', back }) {
  if ($('.menu.pm')) return $('.menu.pm').close(), back?.focus();
  const node = el(`
    <div class="menu pm" role="dialog" aria-label="${esc(label)}">
      <label class="field pm-search">${icon('search')}<input spellcheck="false" autocomplete="off" placeholder="Search ${projects.length} projects" aria-label="Search projects"></label>
      <div class="pm-list" role="listbox"></div>
      ${extras.length ? `<div class="pm-extras">${extras.map((x) => `<button class="pm-row pm-x" data-id="${esc(x.id)}">${icon(x.icon)}<span class="pm-name">${esc(x.label)}</span></button>`).join('')}</div>` : ''}
    </div>`);
  const input = $('input', node);
  const list = $('.pm-list', node);
  let act = 0;
  const rows = () => [...node.querySelectorAll('.pm-row')];
  const mark = (i, scroll = true) => {
    const r = rows();
    if (!r.length) return;
    act = (i + r.length) % r.length;
    r.forEach((x, k) => x.classList.toggle('act', k === act));
    if (scroll) r[act].scrollIntoView({ block: 'nearest' });
  };
  const paint = () => {
    const q = input.value.trim();
    const hits = q
      ? projects
          .map((p) => ({ p, m: fuzzy(q, [p.name, p.path]) }))
          .filter((x) => x.m)
          .sort((a, b) => b.m.score - a.m.score)
      : projects.map((p) => ({ p, m: null }));
    list.innerHTML = hits.length
      ? hits
          .map(
            ({ p, m }) => `<button class="pm-row c-${p.color} ${p.id === current ? 'on' : ''} ${also?.has(p.id) ? 'in' : ''}" data-id="${esc(p.id)}" role="option" aria-selected="${p.id === current}" title="${esc(projectTitle(p))}">
              <i class="p-dot"></i><span class="pm-name">${highlight(p.name, m?.idx, esc)}</span>${p.machine ? icon('server', 'pm-where') : ''}${meta(p)}<small class="pm-path">${esc(p.path.replace(/^\/(Users|home)\/[^/]+/, '~'))}</small>${
                also ? `<span class="pm-also" data-also title="${also.has(p.id) ? `Leave ${esc(p.name)} out of this task` : `Also work in ${esc(p.name)}`}">${icon(also.has(p.id) ? 'check' : 'plus')}</span>` : icon('check', 'pm-check')
              }
            </button>`,
          )
          .join('')
      : `<div class="pm-empty">No project matches “${esc(q)}”</div>`;
    // Searching starts on the best hit; the full list opens on the current pick.
    const at = q ? 0 : Math.max(0, hits.findIndex((h) => h.p.id === current));
    mark(at, !q);
  };
  const pick = (id) => {
    close();
    onPick(id);
  };
  // Adding to the task keeps the list open, the row where it was and the search as typed.
  const toggle = (r) => {
    also.toggle(r.dataset.id);
    const at = act;
    paint();
    mark(at, false);
    input.focus({ preventScroll: true });
  };
  node.onclick = (e) => {
    const r = e.target.closest('.pm-row');
    if (!r) return;
    if (also && !r.classList.contains('pm-x') && (e.target.closest('[data-also]') || e.metaKey || e.ctrlKey || e.shiftKey)) return toggle(r);
    pick(r.dataset.id);
  };
  node.onmousemove = (e) => {
    const r = e.target.closest('.pm-row');
    if (r && !r.classList.contains('act')) mark(rows().indexOf(r), false);
  };
  input.oninput = paint;
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      mark(act + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      const r = rows()[act];
      if (r && also && !r.classList.contains('pm-x') && (e.metaKey || e.ctrlKey || e.shiftKey)) toggle(r);
      else if (r) pick(r.dataset.id);
    } else if (e.key === 'Tab') close();
  };

  const close = popover(node, {
    anchor,
    back,
    onClose: () => {
      anchor.classList.remove('open');
      anchor.setAttribute('aria-expanded', 'false');
    },
  });
  anchor.classList.add('open');
  anchor.setAttribute('aria-expanded', 'true');
  paint();
  // Under the chip, or over it when the page has no room below; never off the side.
  const r = anchor.getBoundingClientRect();
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  node.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  node.style.top = `${r.bottom + 6 + h > innerHeight - 8 && r.top - h - 6 > 8 ? r.top - h - 6 : r.bottom + 6}px`;
  rows()[act]?.scrollIntoView({ block: 'nearest' }); // placed: now bring the current pick into view
  input.focus({ preventScroll: true });
  return close;
}
