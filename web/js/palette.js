import { icon, el } from './blocks.js';
import { esc } from './md.js';
import { byScore, fuzzy, highlight, recency } from './fuzzy.js';
import { splitQuery, tagScore } from './tags.js';

// ⌘K command palette: one input over a grouped list of sessions, projects and
// actions. Generic over its items; app.js decides what's in it and what runs.
//
// item: { id, group, label, sub?, icon?, dot?, kbd?, keywords?, tags?, run, rank?, at?, fill? }
// `at` (ms) is when the item was last touched: recent items score higher (fuzzy.js recency).
// `tags`: topic words (tags.js); "#auth" in the query keeps only items tagged auth. `fill`: picking
// the item types that into the input instead of running anything (a topic narrows the search).
// With an empty query each group shows its first `limit` items in the given order.

const GROUP_LIMIT = 6;

export function palette({ items, overlay, placeholder = 'Search tasks, #topics, projects and actions…' }) {
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
    const now = Date.now();
    const query = splitQuery(q);
    for (const it of items) {
      const t = tagScore(query, it.tags);
      if (!t || (it.fill && query.tags.includes(it.tags?.[0]))) continue; // a topic already in the query
      const tags = it.tags?.join(' ') || '';
      const m = query.text ? fuzzy(query.text, [it.label, it.sub || '', tags, it.keywords || '', it.group]) : { score: 0, idx: [] };
      if (m) hits.push({ it, idx: m.idx, hit: t.hit, at: it.at, score: m.score + t.score + (it.rank || 0) + recency(it.at, now) });
    }
    // Best match first, but keep groups together, ordered by their best hit.
    hits.sort(byScore);
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
      .map(({ it, idx, hit = [] }, i) => {
        const head = it.group !== group ? `<div class="pal-group">${esc((group = it.group))}</div>` : '';
        const lead = it.dot ? `<i class="p-dot c-${esc(it.dot)}"></i>` : icon(it.icon || 'arrow');
        return `${head}<div class="pal-row ${i === sel ? 'on' : ''}" role="option" data-i="${i}" aria-selected="${i === sel}">
          <span class="pal-lead">${lead}</span>
          <span class="pal-label">${highlight(it.label, idx, esc)}</span>
          ${!it.fill && it.tags?.length && input.value.trim() ? tagsHtml(it.tags, hit) : ''}
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
    if (hit.it.fill) {
      // A topic: narrow to it, keeping the words typed that weren't its name.
      const rest = splitQuery(input.value);
      const words = rest.text.split(/\s+/).filter((w) => w && !hit.it.tags[0].startsWith(w.toLowerCase()));
      input.value = `${[...rest.tags.filter((t) => !hit.it.tags[0].startsWith(t)).map((t) => `#${t}`), hit.it.fill.trim(), ...words].join(' ')} `;
      sel = 0;
      render();
      list.scrollTop = 0;
      return input.focus();
    }
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

// Up to three of a task's topics, the ones the query found first and marked.
function tagsHtml(tags, hit) {
  const list = [...hit, ...tags.filter((t) => !hit.includes(t))].slice(0, 3);
  return `<span class="pal-tags">${list.map((t) => `<span class="pal-tag${hit.includes(t) ? ' on' : ''}">#${esc(t)}</span>`).join('')}</span>`;
}
