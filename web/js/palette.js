import { icon, el } from './blocks.js';
import { esc } from './md.js';
import { fuzzy, highlight } from './fuzzy.js';

// ⌘K command palette: one input over a grouped list of sessions, projects and
// actions. Generic over its items; app.js decides what's in it and what runs.
//
// item: { id, group, label, sub?, icon?, dot?, kbd?, keywords?, run, rank? }
// With an empty query each group shows its first `limit` items in the given order.

const GROUP_LIMIT = 6;

export function palette({ items, overlay, placeholder = 'Search sessions, projects and actions…' }) {
  const node = el(`
    <div class="palette" role="dialog" aria-label="Command palette">
      <div class="pal-input">${icon('search')}<input type="text" placeholder="${esc(placeholder)}" spellcheck="false" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="palList"></div>
      <div class="pal-list" id="palList" role="listbox"></div>
      <footer class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></footer>
    </div>`);
  const input = node.querySelector('input');
  const list = node.querySelector('.pal-list');
  let shown = [];
  let sel = 0;

  const results = (q) => {
    if (!q.trim()) {
      const per = new Map();
      return items.filter((it) => {
        const n = per.get(it.group) || 0;
        per.set(it.group, n + 1);
        return n < (it.limit ?? GROUP_LIMIT);
      }).map((it) => ({ it, idx: [] }));
    }
    const hits = [];
    for (const it of items) {
      const m = fuzzy(q, [it.label, it.sub || '', it.keywords || '', it.group]);
      if (m) hits.push({ it, idx: m.idx, score: m.score + (it.rank || 0) });
    }
    // Best match first, but keep groups together, ordered by their best hit.
    hits.sort((a, b) => b.score - a.score);
    const order = [...new Set(hits.map((h) => h.it.group))];
    return order.flatMap((g) => hits.filter((h) => h.it.group === g).slice(0, 12));
  };

  const render = () => {
    shown = results(input.value);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    if (!shown.length) {
      list.innerHTML = `<div class="pal-empty">No results for “${esc(input.value.trim())}”</div>`;
      return;
    }
    let group = null;
    list.innerHTML = shown
      .map(({ it, idx }, i) => {
        const head = it.group !== group ? `<div class="pal-group">${esc((group = it.group))}</div>` : '';
        const lead = it.dot ? `<i class="p-dot c-${esc(it.dot)}"></i>` : icon(it.icon || 'arrow');
        return `${head}<div class="pal-row ${i === sel ? 'on' : ''}" role="option" data-i="${i}" aria-selected="${i === sel}">
          <span class="pal-lead">${lead}</span>
          <span class="pal-label">${highlight(it.label, idx, esc)}</span>
          ${it.sub ? `<span class="pal-sub">${esc(it.sub)}</span>` : ''}
          ${it.kbd ? `<span class="pal-kbd">${it.kbd.split(' ').map((k) => `<kbd>${esc(k)}</kbd>`).join('')}</span>` : ''}
        </div>`;
      })
      .join('');
  };

  const move = (to) => {
    if (!shown.length) return;
    sel = (to + shown.length) % shown.length;
    list.querySelectorAll('.pal-row').forEach((r, i) => {
      r.classList.toggle('on', i === sel);
      r.setAttribute('aria-selected', i === sel);
    });
    list.querySelector('.pal-row.on')?.scrollIntoView({ block: 'nearest' });
  };

  const close = overlay(node);
  const pick = (i) => {
    const hit = shown[i];
    if (!hit) return;
    close();
    // Let the overlay start fading before the action moves focus or opens another modal.
    setTimeout(() => hit.it.run(), 0);
  };

  input.addEventListener('input', () => ((sel = 0), render(), (list.scrollTop = 0)));
  input.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey && !e.metaKey;
    if (e.key === 'ArrowDown' || (ctrl && (e.key === 'n' || e.key === 'j'))) move(sel + 1);
    else if (e.key === 'ArrowUp' || (ctrl && (e.key === 'p' || e.key === 'k'))) move(sel - 1);
    else if (e.key === 'PageDown') move(Math.min(shown.length - 1, sel + 8));
    else if (e.key === 'PageUp') move(Math.max(0, sel - 8));
    else if (e.key === 'Enter' && !e.isComposing) pick(sel);
    else return;
    e.preventDefault();
  });
  // mousemove, not mouseenter: rows sliding under a still cursor while scrolling shouldn't steal the selection.
  list.addEventListener('mousemove', (e) => {
    const r = e.target.closest('.pal-row');
    if (r && Number(r.dataset.i) !== sel) move(Number(r.dataset.i));
  });
  list.addEventListener('click', (e) => {
    const r = e.target.closest('.pal-row');
    if (r) pick(Number(r.dataset.i));
  });

  render();
  input.focus();
  return close;
}
