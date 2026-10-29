// The rows above the reply box: follow-ups queued for after the run (session.queue), then the ones
// scheduled for a time (later.js). Each row says what goes out; the pencil (on hover, always there
// on a touch screen) edits it in place, Enter saves, Esc keeps what it said. Two or more queued:
// drag a row by its grip (or Move up / Move down in its menu) to change the order they go out in.
// Every change is optimistic and rolls back with a toast. Rows are kept by id, so a refresh never
// re-inserts (and replays) one that's already there.

import { esc } from '../md.js';
import { mentionHtml } from '../mention-text.js';
import { api } from '../core/api.js';
import { $, $$, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { clampToViewport, popover } from '../ui/popover.js';
import { toast, toastError } from '../ui/toast.js';
import { ask } from '../ui/confirm.js';
import { autosize } from './attachments.js';
import { runnerTip } from './runners.js';

// Rows by key, each with the HTML it shows and what wires it (once, when made). A row being edited
// keeps its box until it's saved or dropped.
export function keyedRows(list, items) {
  const rows = (list._rows ||= new Map());
  const want = new Set(items.map((x) => x.key));
  for (const [k, li] of rows) if (!want.has(k)) (li.remove(), rows.delete(k));
  items.forEach((x, i) => {
    let li = rows.get(x.key);
    if (!li) {
      li = el(`<li class="${x.cls}" data-k="${esc(x.key)}"></li>`);
      rows.set(x.key, li);
      x.make?.(li);
    } else if (list.children[i] !== li) li.style.animation = 'none'; // moved, not new: no entrance
    li.className = x.cls + (li.classList.contains('editing') ? ' editing' : '');
    li.item = x.item;
    if (!li.classList.contains('editing') && li.dataset.h !== x.html) (li.innerHTML = x.html), (li.dataset.h = x.html);
    if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null);
  });
}

// Edit a row's text in place: its text becomes a box. save(text) resolves true once it's taken
// (the row shows the new text at once); false puts the box back with what you typed.
export function editRow(li, text, save) {
  if (li.classList.contains('editing')) return $('.cq-edit', li)?.focus();
  li.classList.add('editing');
  const box = el(`<span class="cq-editbox"><textarea class="cq-edit" rows="1" aria-label="Edit follow-up" enterkeyhint="done"></textarea><span class="cq-keys"><kbd>↵</kbd> save · <kbd>esc</kbd> cancel</span></span>`);
  const ta = $('textarea', box);
  ta.value = text;
  const old = $('.cq-text', li);
  old.replaceWith(box);
  const fit = autosize(ta, 200);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  let done = false;
  const close = () => {
    done = true;
    li.classList.remove('editing');
    li.dataset.h = ''; // the next paint draws it again, with whatever it says now
    box.replaceWith(old);
  };
  const commit = async () => {
    if (done) return;
    const v = ta.value.trim();
    if (!v || v === text.trim()) return close(); // emptied: cancel it with ×, not by editing
    close();
    $('.cq-text', li).textContent = v;
    if (!(await save(v))) $('.cq-text', li).textContent = text;
  };
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation(); // the page's keys (Esc goes back, j/k) aren't for this box
    if (e.isComposing) return;
    if (e.key === 'Escape') return e.preventDefault(), close(), $('.reply', li.closest('.composer'))?.focus();
    if (e.key === 'Enter' && !e.shiftKey) return e.preventDefault(), commit();
  });
  ta.addEventListener('blur', commit);
  for (const t of ['click', 'contextmenu', 'pointerdown']) box.addEventListener(t, (e) => e.stopPropagation());
  requestAnimationFrame(fit);
}

// --- the queue ----------------------------------------------------------------------------------

// The session's queue, changed here first, then on the server; a refusal puts it back.
async function changeQueue(id, next, call) {
  const s = S.full.get(id);
  if (!s) return false;
  const was = s.queue;
  s.queue = next;
  repaint(id);
  try {
    await call();
    return true;
  } catch (err) {
    if (S.full.get(id) === s && s.queue === next) (s.queue = was), repaint(id);
    toastError(err);
    return false;
  }
}
const repaint = (id) => import('./composer.js').then((m) => m.updateDock(id));

const editQueued = (id, q, text) =>
  changeQueue(
    id,
    S.full.get(id).queue.map((x) => (x.id === q.id ? { ...x, text } : x)),
    () => api(`/sessions/${id}/queue`, { method: 'PATCH', body: { item: q.id, text } }),
  );

export function moveQueued(id, from, to) {
  const list = [...(S.full.get(id)?.queue || [])];
  if (from === to || to < 0 || to >= list.length) return;
  list.splice(to, 0, ...list.splice(from, 1));
  changeQueue(id, list, () => api(`/sessions/${id}/queue`, { method: 'PATCH', body: { order: list.map((x) => x.id) } }));
}

async function cancelQueued(id, q, anchor) {
  // Items queued by a wisp older than queue ids get one when wisp restarts.
  if (!q.id) return toast('Restart wisp to cancel this follow-up.', { tone: 'bad' });
  const short = q.text.length > 80 ? `${q.text.slice(0, 80)}…` : q.text;
  if (!(await ask(`Cancel this queued follow-up?\n\n“${short}”`, { ok: 'Cancel follow-up', danger: true, anchor }))) return;
  api(`/sessions/${id}/queue?item=${encodeURIComponent(q.id)}`, { method: 'DELETE' }).catch(toastError);
}

// What a queued follow-up's row offers: yours can be edited, wisp's own (reports back) can't.
const editable = (q) => !!q.id && q.by !== 'wisp';

// The queued rows' items for keyedRows. name: the harness the run is on.
export function queuedItems(s, name) {
  const q = s.queue || [];
  const many = q.length > 1;
  return q.map((x, i) => ({
    key: `q-${x.id || i}`,
    cls: `cq${many ? ' sortable' : ''}`,
    item: x,
    html: `${many ? `<span class="cq-grip" aria-hidden="true" title="Drag to change the order">${icon('grip')}</span>` : ''}
      <span class="cq-tag">${i === 0 ? `Next · after ${esc(name)} finishes` : `Queued #${i + 1}`}${x.run ? ` · on ${esc(runnerTip(x.run.agent, x.run.model, ''))}` : ''}</span>
      <span class="cq-text">${mentionHtml(esc(x.text), { link: false })}</span>
      ${editable(x) ? `<button class="cq-pen" aria-label="Edit follow-up" title="Edit follow-up">${icon('pen')}</button>` : ''}
      <button class="att-x" aria-label="Cancel this follow-up" title="Cancel this follow-up">${icon('x')}</button>`,
    make: (li) => {
      li.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (b?.classList.contains('att-x')) return cancelQueued(s.id, li.item, b);
        if (b?.classList.contains('cq-pen')) return startEdit(s.id, li);
      });
      li.addEventListener('dblclick', (e) => {
        if (!e.target.closest('button, .cq-grip') && editable(li.item)) startEdit(s.id, li);
      });
      li.addEventListener('contextmenu', (e) => {
        if (li.classList.contains('editing')) return;
        e.preventDefault();
        e.stopPropagation();
        queuedMenu(e, s.id, li);
      });
      li.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.cq-grip')) dragRow(e, s.id, li);
      });
    },
  }));
}

function startEdit(id, li) {
  const q = li.item;
  editRow(li, q.text, (text) => editQueued(id, q, text));
}

// Right-click on a queued follow-up: Edit, Move up / Move down, Cancel.
function queuedMenu(e, id, li) {
  $('.menu.queued')?.close();
  const list = S.full.get(id)?.queue || [];
  const i = list.findIndex((x) => x.id === li.item.id);
  const menu = el(`
    <div class="menu queued" role="menu">
      ${editable(li.item) ? `<button data-a="edit">${icon('pen')}Edit follow-up</button>` : ''}
      ${list.length > 1 && i > 0 ? `<button data-a="up">${icon('arrow', 'rot-up')}Move up</button>` : ''}
      ${list.length > 1 && i >= 0 && i < list.length - 1 ? `<button data-a="down">${icon('arrow', 'rot-down')}Move down</button>` : ''}
      <button data-a="cancel" class="danger">${icon('x')}Cancel follow-up</button>
    </div>`);
  menu.onclick = (ev) => {
    const a = ev.target.closest('button')?.dataset.a;
    if (!a) return;
    close();
    if (a === 'edit') startEdit(id, li);
    if (a === 'up') moveQueued(id, i, i - 1);
    if (a === 'down') moveQueued(id, i, i + 1);
    if (a === 'cancel') cancelQueued(id, li.item, li);
  };
  const close = popover(menu);
  clampToViewport(menu, e.clientX, e.clientY);
}

// Drag a queued row by its grip: it follows the pointer, the others make room, and where you let
// go is its place. Moving it past nothing changes nothing.
function dragRow(e, id, li) {
  if (e.button !== 0) return;
  e.preventDefault();
  const list = li.parentElement;
  const rows = $$('.cq.sortable', list);
  const from = rows.indexOf(li);
  const boxes = rows.map((r) => r.getBoundingClientRect());
  const step = boxes.length > 1 ? boxes[1].top - boxes[0].top : boxes[0].height;
  const y0 = e.clientY;
  let to = from;
  li.setPointerCapture(e.pointerId);
  list.classList.add('sorting');
  li.classList.add('dragged');
  const move = (ev) => {
    const dy = Math.max(boxes[0].top - boxes[from].top, Math.min(boxes.at(-1).top - boxes[from].top, ev.clientY - y0));
    li.style.translate = `0 ${dy}px`;
    to = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / step)));
    rows.forEach((r, i) => {
      if (r === li) return;
      r.style.translate = i > from && i <= to ? `0 ${-step}px` : i < from && i >= to ? `0 ${step}px` : '';
    });
  };
  const up = () => {
    li.removeEventListener('pointermove', move);
    li.removeEventListener('pointerup', up);
    li.removeEventListener('pointercancel', up);
    list.classList.remove('sorting');
    li.classList.remove('dragged');
    for (const r of rows) r.style.translate = '';
    moveQueued(id, from, to);
  };
  li.addEventListener('pointermove', move);
  li.addEventListener('pointerup', up);
  li.addEventListener('pointercancel', up);
}
