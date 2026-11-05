import { icon, el } from './blocks.js';
import { esc } from './md.js';
import { byScore, fuzzy, highlight, recency } from './fuzzy.js';
import { splitQuery, tagScore } from './tags.js';

// ⌘K command palette: one input over a grouped list of sessions, projects and
// actions. Generic over its items; app.js decides what's in it and what runs.
//
// item: { id, group, label, sub?, subHtml? (sub as safe HTML), icon?, dot?, kbd?, keywords?, tags?, run, rank?, at?, fill? }
// `at` (ms) is when the item was last touched: recent items score higher (fuzzy.js recency).
// `tags`: topic words (tags.js); "#auth" in the query keeps only items tagged auth. `fill`: picking
// the item types that into the input instead of running anything (a topic narrows the search).
// With an empty query each group shows its first `limit` items in the given order.

const GROUP_LIMIT = 6;

// deep(q): more items for a query, from the server (past work by its words); they follow the rest,
// once they come, so nothing above them moves (one with an id already listed isn't shown twice).
// loading: rows in their real shapes until close.set({ items, notice }) brings the list; notice is a
// line of HTML over it (why it's empty, and what fixes that). cls and label name the dialog.
export function palette({ items, overlay, deep, placeholder = 'Search tasks, #topics, projects and actions…', loading = false, cls = '', label = 'Command palette' }) {
  const node = el(`
    <div class="palette${cls ? ` ${esc(cls)}` : ''}" role="dialog" aria-label="${esc(label)}">
      <div class="pal-input">${icon('search')}<input type="text" placeholder="${esc(placeholder)}" spellcheck="false" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="palList"></div>
      <div class="pal-notice" role="status" hidden></div>
      <div class="pal-list" id="palList" role="listbox"></div>
      <footer class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></footer>
    </div>`);
  const input = node.querySelector('input');
  const list = node.querySelector('.pal-list');
  const status = node.querySelector('.pal-notice');
  // The note over the list (why it's empty, what fixes it) sits outside the listbox: only options in there
  const paintNotice = (html) => {
    if (status.dataset.h !== html) (status.innerHTML = html), (status.dataset.h = html);
    status.hidden = !html;
  };
  let shown = [];
  let sel = 0;
  let extra = { q: '', items: [] }; // deep()'s answer for the query it was asked
  let asking = 0;
  let waiting = loading;
  let notice = '';

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
    const listed = new Set(hits.map((h) => h.it.id).filter(Boolean));
    const deepHits = extra.q === q.trim() ? extra.items.filter((it) => !it.id || !listed.has(it.id)).map((it) => ({ it, idx: [] })) : [];
    return [...order.flatMap((g) => hits.filter((h) => h.it.group === g).slice(0, 12)), ...deepHits];
  };
  // Asked once typing pauses; an answer for words no longer in the box is dropped.
  const ask = () => {
    const q = input.value.trim();
    clearTimeout(asking);
    if (!deep || q.length < 3 || q.startsWith('#')) return;
    asking = setTimeout(async () => {
      const got = await deep(q).catch(() => []);
      if (input.value.trim() !== q || !node.isConnected) return;
      extra = { q, items: got };
      render();
    }, 160);
  };

  const render = () => {
    if (waiting) {
      shown = [];
      list.innerHTML = SKELETON;
      return;
    }
    shown = results(input.value);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    paintNotice(notice);
    list.setAttribute('role', shown.length ? 'listbox' : 'presentation');
    if (!shown.length) {
      list.innerHTML = notice && !input.value.trim() ? '' : `<div class="pal-empty">No results for “${esc(input.value.trim())}”</div>`;
      return;
    }
    let group = null;
    list.innerHTML = shown
      .map(({ it, idx, hit = [] }, i) => {
        const head = it.group !== group ? `<div class="pal-group">${esc((group = it.group))}</div>` : '';
        const lead = it.dot ? `<i class="p-dot c-${esc(it.dot)}"></i>` : icon(it.icon || 'arrow');
        return `${head}<div class="pal-row ${i === sel ? 'on' : ''}" role="option" data-i="${i}" aria-selected="${i === sel}"${it.tip ? ` title="${esc(it.tip)}"` : ''}>
          <span class="pal-lead">${lead}</span>
          <span class="pal-label">${highlight(it.label, idx, esc)}</span>
          ${!it.fill && it.tags?.length && input.value.trim() ? tagsHtml(it.tags, hit) : ''}
          ${it.subHtml || it.sub ? `<span class="pal-sub">${it.subHtml || esc(it.sub)}</span>` : ''}
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

  input.addEventListener('input', () => {
    sel = 0;
    render();
    list.scrollTop = 0;
    ask();
  });
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
  // The list once it's in (a loading palette), and the notice over it.
  close.set = ({ items: next, notice: html = '' }) => {
    items = next;
    notice = html;
    waiting = false;
    render();
  };
  return close;
}

// A loading list: a group line and rows the size of real ones.
const SKELETON = `<div class="pal-sk-wrap" aria-hidden="true"><i class="sk pal-sk-group"></i>${[64, 48, 72, 40, 58, 52]
  .map((w) => `<div class="pal-sk"><i class="sk pal-sk-lead"></i><span class="pal-sk-lines"><i class="sk pal-sk-label" style="width:${w}%"></i><i class="sk pal-sk-sub"></i></span></div>`)
  .join('')}</div>`;

// Up to three of a task's topics, the ones the query found first and marked.
function tagsHtml(tags, hit) {
  const list = [...hit, ...tags.filter((t) => !hit.includes(t))].slice(0, 3);
  return `<span class="pal-tags">${list.map((t) => `<span class="pal-tag${hit.includes(t) ? ' on' : ''}">#${esc(t)}</span>`).join('')}</span>`;
}
