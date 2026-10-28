// Comments on an answer: select words in it, or pin a spot on a picture, video or page, and say
// what you think of it there. They wait above the follow-up box, numbered like their marks on the
// answer, and go out at the top of the next follow-up (comment-text.js), so the agent knows exactly
// which part you meant.

import { esc } from '../md.js';
import { blockLabel, fmtTime, readComments, withComments } from '../comment-text.js';
import { $, $$, el, icon } from '../core/dom.js';
import { load, S, save } from '../core/state.js';
import { popover, TOUCH } from '../ui/popover.js';
import { sendReply, updateDock } from './composer.js';
import { scrollByPx, topInset } from './scroll.js';

// session id -> its comments, in the order they go out: { id, turn, i (block), label, kind, quote,
// x, y, at, note }. Kept like drafts: a reload doesn't lose them.
const pending = new Map(load('wisp.comments', []));
const keep = () => save('wisp.comments', [...pending].filter(([, l]) => l.length));
const listOf = (id) => pending.get(id) || [];

// Blocks that are buttons already: commenting on them means nothing.
const SKIP = new Set(['next', 'actions', 'question', 'blocked', 'spell']);
// Where a spot can be pinned: the picture, the video, the page's screen, the app.
const SPOT = '.img-box, .pv-screen, .app-box';
const MEDIA = '.presentation > :is(.blk-image, .blk-video, .blk-preview, .blk-app)';

export const commentCount = (id) => listOf(id).length;

// The comments for the next follow-up, in its words; take() empties the tray as it goes out, and
// restore() puts them back if the server refuses.
export function withPending(id, text, list = listOf(id)) {
  const s = S.full.get(id);
  const latest = s?.turns?.at(-1)?.id;
  list = list.map((c) => ({ ...c, of: c.turn !== latest ? s?.turns?.find((t) => t.id === c.turn)?.prompt : '' }));
  return withComments(list, text);
}
export function takeComments(id) {
  const list = listOf(id);
  pending.delete(id);
  changed(id);
  return list;
}
export function restoreComments(id, list) {
  if (!list?.length) return;
  pending.set(id, [...list, ...listOf(id)]);
  changed(id);
}

function changed(id) {
  keep();
  paintTray(id);
  paintMarks(id);
  updateDock(id);
}

// --- where things are --------------------------------------------------------

// The task, turn and block a node sits in, when it's an answer in a task with a follow-up box.
function spotOf(node) {
  const holder = node?.closest?.('.presentation > .blk');
  const turn = holder?.closest('.turn[data-turn]');
  const item = turn?.closest('.item[data-id]');
  if (!holder || !item || !holder.block || holder.closest('.trail-body, .ask') || !$('.composer .reply', item)) return null;
  if (SKIP.has(holder.block.type) || holder.parentElement.closest('.blk')) return null;
  return { id: item.dataset.id, turn: turn.dataset.turn, i: Number(holder.dataset.i), holder, block: holder.block };
}

// The picture inside a spot's box, in the box's pixels: an image or video is fitted (contain), so
// bands around it aren't part of it, and "42% across" means across the picture.
function frame(box) {
  const w = box.clientWidth;
  const h = box.clientHeight;
  const media = $(':scope > img, :scope > video', box);
  const nw = media?.naturalWidth || media?.videoWidth;
  const nh = media?.naturalHeight || media?.videoHeight;
  if (!nw || !nh) return { left: 0, top: 0, width: w, height: h };
  const mw = media.clientWidth;
  const mh = media.clientHeight;
  const k = Math.min(mw / nw, mh / nh);
  return { left: media.offsetLeft + (mw - nw * k) / 2, top: media.offsetTop + (mh - nh * k) / 2, width: nw * k, height: nh * k };
}
const at = (box, c) => {
  const f = frame(box);
  return { left: `${f.left + (c.x / 100) * f.width}px`, top: `${f.top + (c.y / 100) * f.height}px` };
};

const holderFor = (id, c) => $(`.item[data-id="${CSS.escape(id)}"] .turn[data-turn="${CSS.escape(c.turn)}"] > .presentation > .blk[data-i="${c.i}"]`);

// The words of a text comment, found again in its block after a repaint (the old range is gone).
function findRange(holder, quote) {
  if (!quote) return null;
  const nodes = [];
  let all = '';
  const walk = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement.closest('.cmt-mark, .cmt-add') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  for (let n; (n = walk.nextNode()); ) {
    nodes.push([n, all.length]);
    all += n.data;
  }
  // Selections and text nodes disagree on whitespace (line breaks between paragraphs): compare
  // both with every run of spaces as one.
  const map = [];
  let flat = '';
  for (let k = 0; k < all.length; k++) {
    if (/\s/.test(all[k]) && /\s/.test(all[k - 1] || '')) continue;
    map.push(k);
    flat += /\s/.test(all[k]) ? ' ' : all[k];
  }
  const want = quote.replace(/\s+/g, ' ').trim();
  const at = flat.indexOf(want);
  if (at < 0) return null;
  const from = map[at];
  const to = map[at + want.length - 1] + 1;
  const pos = (k) => {
    let j = nodes.length - 1;
    while (j > 0 && nodes[j][1] > k) j--;
    return [nodes[j][0], k - nodes[j][1]];
  };
  const r = document.createRange();
  const [end, off] = pos(to - 1);
  try {
    r.setStart(...pos(from));
    r.setEnd(end, off + 1);
  } catch {
    return null;
  }
  return r;
}

// How a comment is named on screen: by its words, else by its block; a pin says so, with the
// video's second (where on the picture is the agent's business, not a number to read).
const pinned = (at) => `<i>${at != null && at !== '' ? `${typeof at === 'number' ? fmtTime(at) : esc(at)} · ` : ''}pinned</i>`;
const nameOf = (c) => (c.kind === 'text' && c.quote ? `<q>${esc(c.quote.replace(/\s+/g, ' '))}</q>` : `${esc(c.label)}${c.kind === 'point' ? ` ${pinned(c.at)}` : ''}`);

// --- marks on the answer ------------------------------------------------------

const HL = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
const lit = new Map(); // session id -> the ranges of its text comments, all lit by one highlight

// Every task's marks: numbered tags at the end of the words, pins on the spots, a ring round a
// whole block. Only wisp's own little nodes are redrawn; the answer is left as it is.
export function paintMarks(id) {
  const item = $(`.item[data-id="${CSS.escape(id)}"]`);
  // A finger on a picture opens the viewer: there its pin button stays up, as its own tools do.
  if (item && TOUCH.matches) for (const h of $$(MEDIA, item)) {
    const s = spotOf(h);
    if (s) addButton(s);
  }
  // Marks are kept by comment and only moved: nothing is pulled out and put back on a repaint.
  const old = new Map(item ? $$('.cmt-mark:not(.cmt-draft)', item).map((m) => [m.dataset.c, m]) : []);
  const whole = new Set();
  const ranges = [];
  const tag = (parent, n, c, pos, cls) => {
    const m = old.get(c.id);
    old.delete(c.id);
    if (!m) return mark(parent, n, c, pos, cls);
    if (m.parentElement !== parent) parent.append(m);
    m.className = `cmt-mark ${cls}${m.classList.contains('cmt-flash') ? ' cmt-flash' : ''}`;
    if (m.textContent !== String(n)) ((m.textContent = n), m.setAttribute('aria-label', `Comment ${n}`));
    m.title = c.note || 'Comment';
    m.style.left = pos.left || '';
    m.style.top = pos.top || '';
    return m;
  };
  listOf(id).forEach((c, k) => {
    const holder = holderFor(id, c);
    if (!holder) return;
    const n = k + 1;
    if (c.kind === 'text') {
      const r = findRange(holder, c.quote);
      if (!r) return;
      ranges.push(r);
      const rects = r.getClientRects();
      const last = rects[rects.length - 1];
      if (!last) return;
      const box = holder.getBoundingClientRect();
      // Raised over the end of the words, like a footnote, so it hides none of the next ones.
      tag(holder, n, c, { left: `${last.right - box.left - 4}px`, top: `${last.top - box.top - 12}px` }, 'cmt-tag');
    } else if (c.kind === 'point') {
      const spot = $(SPOT, holder);
      if (!spot) return;
      // Drawn again once the picture has its size.
      const media = $(':scope > img, :scope > video', spot);
      if (media && !(media.naturalWidth || media.videoWidth)) media.addEventListener(media.tagName === 'IMG' ? 'load' : 'loadedmetadata', () => paintMarks(id), { once: true });
      tag(spot, n, c, at(spot, c), 'cmt-pin');
    } else {
      whole.add(holder);
      tag(holder, n, c, {}, 'cmt-corner');
    }
  });
  for (const m of old.values()) m.remove();
  if (item) for (const h of $$('.blk.cmt-whole', item)) if (!whole.has(h) && !h.classList.contains('cmt-drafting')) h.classList.remove('cmt-whole');
  for (const h of whole) h.classList.add('cmt-whole');
  if (HL) {
    lit.set(id, ranges);
    CSS.highlights.set('wisp-comment', new Highlight(...[...lit.values()].flat()));
  }
}

function mark(parent, n, c, pos, cls = 'cmt-tag') {
  const b = el(`<button class="cmt-mark ${cls}" data-c="${esc(c.id)}" title="${esc(c.note || 'Comment')}" aria-label="Comment ${n}">${n}</button>`);
  Object.assign(b.style, pos);
  parent.append(b);
  return b;
}

// After a task's body is drawn again, or the window changes size.
export function repaintAll() {
  for (const id of pending.keys()) paintMarks(id);
}
let rt;
addEventListener('resize', () => {
  clearTimeout(rt);
  rt = setTimeout(repaintAll, 120);
});

// --- the tray over the follow-up box -----------------------------------------

export function commentTray(id) {
  const node = el(`<ol class="cmt-tray" aria-label="Comments for your next message" hidden></ol>`);
  node.addEventListener('click', (e) => {
    const row = e.target.closest('.cmt-row');
    const c = row && listOf(id).find((x) => x.id === row.dataset.c);
    if (!c) return;
    if (e.target.closest('.cmt-x')) return remove(id, c.id);
    jumpTo(id, c, true);
  });
  return node;
}

function paintTray(id) {
  const node = $(`.item[data-id="${CSS.escape(id)}"] .cmt-tray`);
  if (!node) return;
  const list = listOf(id);
  node.hidden = !list.length;
  // Rows are kept by comment: an edit changes its row in place, and only a new one comes in.
  const rows = new Map($$(':scope > .cmt-row', node).map((r) => [r.dataset.c, r]));
  const first = !node.dataset.drawn;
  node.dataset.drawn = '1';
  list.forEach((c, k) => {
    const inner = `<span class="cmt-n">${k + 1}</span>
        <button class="cmt-body" title="Show in the answer">
          <span class="cmt-say">${c.note ? esc(c.note) : '<i>No note</i>'}</span>
          <span class="cmt-on">${nameOf(c)}</span>
        </button>
        <button class="att-x cmt-x" title="Remove" aria-label="Remove comment ${k + 1}">${icon('x')}</button>`;
    let row = rows.get(c.id);
    rows.delete(c.id);
    if (!row) row = el(`<li class="cmt-row${first ? '' : ' cmt-new'}" data-c="${esc(c.id)}"></li>`);
    if (row.dataset.h !== inner) ((row.innerHTML = inner), (row.dataset.h = inner));
    if (node.children[k] !== row) node.insertBefore(row, node.children[k] || null);
  });
  for (const r of rows.values()) r.remove();
}
export const paintCommentTray = paintTray;

function remove(id, cid) {
  pending.set(
    id,
    listOf(id).filter((c) => c.id !== cid),
  );
  changed(id);
}

// Scroll the answer to a comment's mark, flash it, and (edit) open its note.
function jumpTo(id, c, edit) {
  const holder = holderFor(id, c);
  if (!holder) return;
  holder.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  const mark = $(`.cmt-mark[data-c="${CSS.escape(c.id)}"]`, holder);
  mark?.classList.remove('cmt-flash');
  void mark?.offsetWidth;
  mark?.classList.add('cmt-flash');
  if (edit && mark) setTimeout(() => openNote({ id, holder, c, anchor: mark }), 320);
}

// --- the note card -------------------------------------------------------------

let closeNote = null;

// c: an existing comment to edit, or a new one ({ turn, i, label, kind, quote, x, y, at }).
function openNote({ id, holder, c, anchor, range, rect }) {
  closeNote?.();
  hideBubble();
  const list = listOf(id);
  const old = list.find((x) => x.id === c.id);
  const n = old ? list.indexOf(old) + 1 : list.length + 1;
  const card = el(`
    <div class="cmt-card" role="dialog" aria-label="Comment ${n}">
      <div class="cmt-head"><span class="cmt-n">${n}</span>${c.kind === 'text' && c.quote ? `<q title="${esc(c.quote)}">${esc(c.quote.replace(/\s+/g, ' '))}</q>` : `<span class="cmt-on">${nameOf(c)}</span>`}</div>
      <textarea class="cmt-note textarea" rows="2" placeholder="${c.kind === 'point' ? 'What’s wrong at this spot?' : c.kind === 'text' ? 'What should change here?' : 'What about this part?'}"></textarea>
      <div class="cmt-foot">
        ${old ? `<button class="ghost sm cmt-del">${icon('trash')}Remove</button>` : ''}
        <span class="grow"></span>
        <button class="ghost sm cmt-now" title="Send it to the agent now, with the other comments and what you typed${TOUCH.matches ? '' : ' (⌘⏎)'}">${icon('send')}Send now</button>
        <button class="primary sm cmt-keep">${old ? 'Save' : 'Add to follow-up'}${TOUCH.matches ? '' : '<kbd>⏎</kbd>'}</button>
      </div>
    </div>`);
  const ta = $('.cmt-note', card);
  ta.value = old?.note || '';
  // A draft mark while the card is open: the words stay lit, the pin stays put.
  let draft = null;
  if (!old && range && HL) CSS.highlights.set('wisp-comment-draft', new Highlight(range));
  if (!old && c.kind === 'point') draft = mark($(SPOT, holder), n, c, at($(SPOT, holder), c), 'cmt-pin cmt-draft');
  if (!old && c.kind === 'block') holder.classList.add('cmt-whole', 'cmt-drafting');
  const commit = (now) => {
    const note = ta.value.trim();
    const next = { ...c, id: c.id || `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, note };
    pending.set(id, old ? list.map((x) => (x.id === old.id ? next : x)) : [...list, next]);
    close();
    changed(id);
    if (now) return sendReply(id, $(`.item[data-id="${CSS.escape(id)}"] .composer .reply`)?.value || '');
    // On a big screen the box is right there: back to it, so typing goes on. A phone keeps its
    // keyboard down, the tray says it's added.
    if (!TOUCH.matches) $(`.item[data-id="${CSS.escape(id)}"] .composer .reply`)?.focus({ preventScroll: true });
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      commit(e.metaKey || e.ctrlKey);
    }
  });
  $('.cmt-keep', card).onclick = () => {
    commit(false);
  };
  $('.cmt-now', card).onclick = () => {
    commit(true);
  };
  $('.cmt-del', card)?.addEventListener('click', () => {
    close();
    remove(id, old.id);
  });
  const close = popover(card, {
    anchor,
    keep: '.cmt-mark',
    onClose: () => {
      closeNote = null;
      draft?.remove();
      if (HL) CSS.highlights.delete('wisp-comment-draft');
      holder.classList.remove('cmt-drafting');
      // Done with that block: every picture's button comes back.
      for (const h of $$('.blk.cmt-touch')) h.classList.remove('cmt-touch');
      if (!old && c.kind === 'block' && !listOf(id).some((x) => x.kind === 'block' && x.i === c.i && x.turn === c.turn)) holder.classList.remove('cmt-whole');
      removeEventListener('scroll', place, true);
    },
  });
  closeNote = close;
  // Beside what it's about: under the words or the pin, above when there's no room below.
  const place = () => {
    let a = anchor?.isConnected ? anchor.getBoundingClientRect() : range ? range.getBoundingClientRect() : rect;
    // Words: under their paragraph, so the card covers none of what's around them.
    const para = range && !anchor && (range.endContainer.parentElement || range.endContainer).closest?.('p, li, pre, blockquote, h1, h2, h3, h4, td, .blk');
    if (para) {
      const pr = para.getBoundingClientRect();
      a = { left: a.left, width: a.width, top: Math.min(a.top, pr.top), bottom: Math.max(a.bottom, pr.bottom) };
    }
    if (!a) return;
    if (matchMedia('(max-width: 520px)').matches) return card.classList.add('cmt-sheet');
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const below = a.bottom + 10 + h < innerHeight - 8;
    card.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, a.left + a.width / 2 - w / 2))}px`;
    card.style.top = `${below ? a.bottom + 10 : Math.max(8, a.top - h - 10)}px`;
  };
  place();
  addEventListener('scroll', place, true);
  setTimeout(() => ta.focus({ preventScroll: true }));
}

// --- selecting words ---------------------------------------------------------

const bubble = el(`<div class="cmt-bubble" role="toolbar" hidden><button class="cmt-go">${icon('comment')}<span>Comment</span></button></div>`);
document.body.append(bubble);
let picked = null; // { spot, range, quote }
// Pressing the bubble must not clear the selection under it.
bubble.addEventListener('mousedown', (e) => e.preventDefault());
bubble.addEventListener('click', () => {
  if (!picked) return;
  const { spot, range, quote } = picked;
  const rect = range.getBoundingClientRect();
  openNote({ id: spot.id, holder: spot.holder, range, rect, c: { turn: spot.turn, i: spot.i, label: blockLabel(spot.block), kind: 'text', quote } });
  getSelection()?.removeAllRanges();
});
function hideBubble() {
  bubble.hidden = true;
  picked = null;
}

let st;
document.addEventListener('selectionchange', () => {
  clearTimeout(st);
  const sel = getSelection();
  if (!sel || sel.isCollapsed) return hideBubble();
  // Wait for the hand to settle (dragging, a phone's handles) before offering anything.
  st = setTimeout(readSelection, TOUCH.matches ? 380 : 160);
});
function readSelection() {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return hideBubble();
  const range = sel.getRangeAt(0);
  const from = spotOf(range.startContainer.parentElement || range.startContainer);
  const to = spotOf(range.endContainer.parentElement || range.endContainer);
  const quote = sel.toString().trim();
  if (!from || !to || from.holder !== to.holder || quote.length < 2 || range.startContainer.parentElement?.closest('input, textarea')) return hideBubble();
  picked = { spot: from, range: range.cloneRange(), quote: quote.length > 600 ? `${quote.slice(0, 599)}…` : quote };
  bubble.hidden = false;
  const r = range.getBoundingClientRect();
  const w = bubble.offsetWidth;
  const h = bubble.offsetHeight;
  // Above the words; on a phone under them, clear of the system's own copy menu.
  const under = TOUCH.matches || r.top - h - 8 < 56;
  bubble.classList.toggle('under', under);
  bubble.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
  bubble.style.top = `${under ? r.bottom + 8 : r.top - h - 8}px`;
}
addEventListener('scroll', () => bubble.hidden || readSelection(), true);

// --- a whole block, or a spot on it --------------------------------------------

// The button that comes up on a block under the pointer (or the one a finger touched).
function addButton(spot) {
  if ($(':scope > .cmt-add', spot.holder)) return;
  const pin = !!$(SPOT, spot.holder) && !spot.holder.querySelector('.broken, .pv-bad, .app-bad');
  const b = el(`<button class="cmt-add" title="${pin ? 'Pin a comment on a spot' : 'Comment on this'}" aria-label="${pin ? 'Pin a comment on a spot' : 'Comment on this'}">${icon('comment')}</button>`);
  b.onclick = (e) => {
    e.stopPropagation();
    const s = spotOf(b);
    if (!s) return;
    if (pin) return startPin(s);
    openNote({ id: s.id, holder: s.holder, anchor: b, c: { turn: s.turn, i: s.i, label: blockLabel(s.block), kind: 'block' } });
  };
  spot.holder.append(b);
}
document.addEventListener('pointerover', (e) => {
  if (e.pointerType === 'touch') return;
  const s = spotOf(e.target);
  if (s) addButton(s);
});
document.addEventListener('focusin', (e) => {
  const s = spotOf(e.target);
  if (s) addButton(s);
});
document.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  const s = spotOf(e.target);
  for (const h of $$('.blk.cmt-touch')) if (h !== s?.holder) h.classList.remove('cmt-touch');
  if (!s) return;
  addButton(s);
  s.holder.classList.add('cmt-touch');
});
// A mark: open its note.
document.addEventListener('click', (e) => {
  const m = e.target.closest('.cmt-mark');
  if (!m || m.classList.contains('cmt-draft')) return;
  const s = spotOf(m);
  const c = s && listOf(s.id).find((x) => x.id === m.dataset.c);
  if (c) openNote({ id: s.id, holder: s.holder, c, anchor: m });
});

// Pinning: the picture (video, page) takes one click for where; Esc, or Whole, skips the spot.
function startPin(s) {
  closeNote?.();
  const box = $(SPOT, s.holder);
  const video = $('video', box);
  video?.pause();
  const sec = video && Number.isFinite(video.currentTime) && video.currentTime > 0 ? Math.round(video.currentTime) : null;
  const what = { image: 'picture', video: 'frame', preview: 'page', app: 'app' }[s.block.type] || 'block';
  const layer = el(`
    <div class="cmt-layer" role="button" tabindex="0" aria-label="Pick the spot">
      <div class="cmt-aim">${icon('comment')}<span>${TOUCH.matches ? 'Tap' : 'Click'} a spot${sec != null ? ` at ${fmtTime(sec)}` : ''}</span><button class="link cmt-whole-btn">Whole ${what}</button><kbd>Esc</kbd><button class="link cmt-cancel">Cancel</button></div>
    </div>`);
  box.append(layer);
  s.holder.classList.add('cmt-pinning');
  // The follow-up box and its rows sit over the bottom of the answer: bring the picture up clear of
  // them, so every spot on it can be picked.
  const dock = s.holder.closest('.it-body')?.querySelector('.it-dock');
  const r = box.getBoundingClientRect();
  const floor = dock ? dock.getBoundingClientRect().top - 12 : innerHeight - 12;
  if (r.bottom > floor) scrollByPx(Math.min(r.bottom - floor, r.top - topInset() - 12));
  const end = () => {
    layer.remove();
    s.holder.classList.remove('cmt-pinning');
    removeEventListener('keydown', esc_, true);
  };
  const esc_ = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    end();
  };
  addEventListener('keydown', esc_, true);
  layer.addEventListener('click', (e) => {
    e.stopPropagation();
    // The pill is words, not a spot: a click on them (or on its Esc) does nothing.
    if (e.target.closest('.cmt-aim') && !e.target.closest('button')) return;
    end();
    const base = { turn: s.turn, i: s.i, label: blockLabel(s.block) };
    if (e.target.closest('.cmt-cancel')) return;
    if (e.target.closest('.cmt-whole-btn')) {
      return openNote({ id: s.id, holder: s.holder, anchor: $(':scope > .cmt-add', s.holder), c: { ...base, kind: 'block' } });
    }
    const r = box.getBoundingClientRect();
    const f = frame(box);
    const x = Math.max(0, Math.min(100, ((e.clientX - r.left - f.left) / f.width) * 100));
    const y = Math.max(0, Math.min(100, ((e.clientY - r.top - f.top) / f.height) * 100));
    openNote({ id: s.id, holder: s.holder, rect: { left: e.clientX - 9, width: 18, top: e.clientY - 9, bottom: e.clientY + 9 }, c: { ...base, kind: 'point', x, y, at: sec } });
  });
  layer.focus({ preventScroll: true });
}

// --- a sent prompt -------------------------------------------------------------

// The comments a turn's prompt went out with, as cards over the words typed with them.
export function sentComments(prompt) {
  const { notes, rest } = readComments(prompt);
  if (!notes.length) return null;
  const html = `<ol class="ask-notes">${notes
    .map(
      (c) => `<li class="ask-note">
        <span class="cmt-n">${c.n}</span>
        <div class="an-body">
          <span class="cmt-on">${nameOf(c)}${c.earlier ? ' <i>earlier answer</i>' : ''}</span>
          ${c.note ? `<span class="cmt-say">${esc(c.note)}</span>` : ''}
        </div>
      </li>`,
    )
    .join('')}</ol>`;
  return { html, rest, count: notes.length };
}
