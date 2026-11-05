// Comments on an answer: select words in it, or pin a spot on a picture, video or page, and say
// what you think of it there. Or on a line of a diff in the side panel's Changes, like a review.
// They wait above the follow-up box, numbered like their marks on the answer, and go out at the top
// of the next follow-up (comment-text.js), so the agent knows exactly which part you meant.

import { esc } from '../md.js';
import { blockLabel, fmtTime, lineComment, readComments, withComments } from '../comment-text.js';
import { $, $$, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { popover, TOUCH } from '../ui/popover.js';
import { toast } from '../ui/toast.js';
import { changesOf, openFile, rowKey } from './changes.js';
import { keep, listOf, pending } from './comment-store.js';
import { sendReply, updateDock } from './composer.js';
import { scrollByPx, topInset } from './scroll.js';
import { isStacked } from './split.js';

// Blocks that are buttons already: commenting on them means nothing.
const SKIP = new Set(['next', 'actions', 'question', 'blocked', 'spell']);
// Where a spot can be pinned: the picture, the video, the page's screen, the app.
const SPOT = '.img-box, .pv-screen, .app-box';
const MEDIA = '.presentation > :is(.blk-image, .blk-video, .blk-preview, .blk-app)';

export { commentCount } from './comment-store.js';

// The comments for the next follow-up, in its words; take() empties the tray as it goes out, and
// restore() puts them back if the server refuses.
export function withPending(id, text, list = listOf(id)) {
  const s = S.full.get(id);
  const latest = s?.turns?.at(-1)?.id;
  list = list.map((c) => ({ ...c, of: c.kind !== 'line' && c.turn !== latest ? s?.turns?.find((t) => t.id === c.turn)?.prompt : '' }));
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
// A diff line by its file and number(s), in mono, like a path.
const nameOf = (c) =>
  c.kind === 'line'
    ? `<span class="cmt-file">${esc(c.label)}</span>${c.side === 'old' ? ' <i>removed</i>' : ''}`
    : c.kind === 'text' && c.quote
      ? `<q>${esc(c.quote.replace(/\s+/g, ' '))}</q>`
      : `${esc(c.label)}${c.kind === 'point' ? ` ${pinned(c.at)}` : ''}`;

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
    if (c.kind === 'line') return; // in the side panel: paintLineMarks
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
  paintLineMarks(id);
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

// Over the rows, Send comments while the box is empty: they can go as they are, without a message.
export function commentTray(id) {
  const node = el(`
    <div class="cmt-tray" hidden>
      <div class="cmt-bar"><span class="cmt-for">For your next message</span><button class="ghost xs cmt-send" title="Send them to the agent now, as they are">${icon('send')}<span>Send comments</span></button></div>
      <ol class="cmt-list" aria-label="Comments for your next message"></ol>
    </div>`);
  node.addEventListener('click', (e) => {
    if (e.target.closest('.cmt-send')) return void sendReply(id, '');
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
  typing(node);
  const ol = $('.cmt-list', node);
  const n = list.length;
  $('.cmt-send span', node).textContent = n > 1 ? `Send ${n} comments` : 'Send comment';
  // Rows are kept by comment: an edit changes its row in place, and only a new one comes in.
  const rows = new Map($$(':scope > .cmt-row', ol).map((r) => [r.dataset.c, r]));
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
    if (ol.children[k] !== row) ol.insertBefore(row, ol.children[k] || null);
  });
  for (const r of rows.values()) r.remove();
}
export const paintCommentTray = paintTray;

// Send comments only while the box is empty: with words in it, Send takes both. It keeps its room
// (hidden, not gone), so the box doesn't move as you start typing.
function typing(tray) {
  const ta = $('.reply', tray.closest('.composer') || tray);
  tray.classList.toggle('typing', !!ta?.value.trim());
}
// In the capture phase: the composer's own 'input' events (a send clearing the box) don't bubble.
document.addEventListener(
  'input',
  (e) => {
    const tray = e.target.matches?.('.composer .reply') && $('.cmt-tray', e.target.closest('.composer'));
    if (tray) typing(tray);
  },
  true,
);

function remove(id, cid) {
  pending.set(
    id,
    listOf(id).filter((c) => c.id !== cid),
  );
  changed(id);
}

// Scroll the answer to a comment's mark, flash it, and (edit) open its note.
function jumpTo(id, c, edit) {
  if (c.kind === 'line') return void jumpToLine(id, c, edit);
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

// c: an existing comment to edit, or a new one ({ turn, i, label, kind, quote, x, y, at }, or a
// diff line's). rows: a line comment's rows in the diff; note: what was typed before a range grew.
function openNote({ id, holder, c, anchor, range, rect, rows, note = '' }) {
  closeNote?.();
  hideBubble();
  const list = listOf(id);
  const old = list.find((x) => x.id === c.id);
  const n = old ? list.indexOf(old) + 1 : list.length + 1;
  const card = el(`
    <div class="cmt-card" role="dialog" aria-label="Comment ${n}">
      <div class="cmt-head"><span class="cmt-n">${n}</span>${c.kind === 'text' && c.quote ? `<q title="${esc(c.quote)}">${esc(c.quote.replace(/\s+/g, ' '))}</q>` : `<span class="cmt-on${c.kind === 'line' ? ' cmt-on-line' : ''}">${nameOf(c)}</span>`}${c.kind === 'line' ? `<code class="cmt-code" title="${esc(c.quote)}">${esc(c.quote.split('\n')[0].trim())}</code>` : ''}</div>
      ${c.kind === 'line' && !old && c.from === c.to ? `<p class="cmt-hint">${TOUCH.matches ? 'Tap another line number to take in the lines between' : 'Shift-click another line to take in the lines between'}</p>` : ''}
      <textarea class="cmt-note textarea" rows="2" placeholder="${c.kind === 'point' ? 'What’s wrong at this spot?' : c.kind === 'text' || c.kind === 'line' ? 'What should change here?' : 'What about this part?'}"></textarea>
      <div class="cmt-foot">
        ${old ? `<button class="ghost sm cmt-del">${icon('trash')}Remove</button>` : ''}
        <span class="grow"></span>
        <button class="ghost sm cmt-now" title="Send it to the agent now, with the other comments and what you typed${TOUCH.matches ? '' : ' (⌘⏎)'}">${icon('send')}Send now</button>
        <button class="primary sm cmt-keep">${old ? 'Save' : 'Add to follow-up'}${TOUCH.matches ? '' : '<kbd>⏎</kbd>'}</button>
      </div>
    </div>`);
  const ta = $('.cmt-note', card);
  ta.value = old?.note || note;
  // A draft mark while the card is open: the words stay lit, the pin stays put, the lines are lit.
  let draft = null;
  if (c.kind === 'line') {
    lineDraft = { id, file: c.file, ta };
    for (const r of rows || []) r.classList.add('cmt-lit-draft');
  }
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
    // Stacked, the side panel is a page over the task, its tray out of sight: say where it went.
    if (c.kind === 'line' && !old && isStacked()) return toast('Comment added: it goes with your next follow-up');
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
    // A line's sheet (phones) stays at the bottom, where it covers none of the lines to tap next.
    anchor: c.kind === 'line' && matchMedia('(max-width: 520px)').matches ? undefined : anchor,
    // A line's card stays open for a click on another line: that one takes in the lines between.
    keep: c.kind === 'line' ? `.cmt-mark, ${LINE_HIT}` : '.cmt-mark',
    onClose: () => {
      closeNote = null;
      draft?.remove();
      if (HL) CSS.highlights.delete('wisp-comment-draft');
      holder?.classList.remove('cmt-drafting');
      if (lineDraft?.ta === ta) lineDraft = null;
      for (const r of rows || []) r.classList.remove('cmt-lit-draft');
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
    // Lines: under the last of them, so the card covers none of the range.
    if (rows?.[0]?.isConnected && a) {
      const [t, b] = [rows[0].getBoundingClientRect(), rows.at(-1).getBoundingClientRect()];
      a = { left: a.left, width: a.width, top: t.top, bottom: b.bottom };
    }
    // Words: under their paragraph, so the card covers none of what's around them.
    const para = range && !anchor && (range.endContainer.parentElement || range.endContainer).closest?.('p, li, pre, blockquote, h1, h2, h3, h4, td, .blk');
    if (para) {
      const pr = para.getBoundingClientRect();
      a = { left: a.left, width: a.width, top: Math.min(a.top, pr.top), bottom: Math.max(a.bottom, pr.bottom) };
    }
    if (!a) return;
    // A sheet along the bottom: any spot the popover gave it would pull it off-centre
    if (matchMedia('(max-width: 520px)').matches) return (Object.assign(card.style, { left: '', top: '', right: '', bottom: '' }), card.classList.add('cmt-sheet'));
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    // A line's beside the diff, level with its first line, like a note in the margin: every other
    // line stays in reach for a shift-click. Under them when there's no room on that side.
    const gutter = c.kind === 'line' && (rows?.[0] || anchor)?.closest('.pn-changes')?.getBoundingClientRect().left;
    if (gutter && gutter - 12 - w >= 8) {
      card.style.left = `${gutter - 12 - w}px`;
      card.style.top = `${Math.max(8, Math.min(innerHeight - h - 8, a.top - 12))}px`;
      return;
    }
    const below = a.bottom + 10 + h < innerHeight - 8;
    const x = c.kind === 'line' ? a.left + 8 : a.left + a.width / 2 - w / 2; // a line's from its gutter
    card.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, x))}px`;
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
  if (m.classList.contains('cmt-line')) return void editLine(m);
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

// --- lines of a diff (the side panel's Changes) --------------------------------------

// As on GitHub: a + over the sign of the line under the pointer (one button, moved to that line),
// or the line's number, clicked or tapped. Shift-click another line (on touch, tap one while the
// card is open) for the lines between them. Only numbered lines: a git diff, not captured edits.
const LINE = '.pn-changes[data-task] .cx-diff tr[data-ln]';
const LINE_HIT = `${LINE} > td.no, .cmt-line-add`;
const lineAdd = el(`<button class="cmt-line-add">${icon('plus')}</button>`);
let lineFrom = null; // { id, file, k }: the line a range starts from
let lineDraft = null; // the open card's, when it's a line's: { id, file, ta }

const said = (k) => `${k[0] === 'o' ? 'Comment on removed line' : 'Comment on line'} ${k.slice(1)}`;
document.addEventListener('pointerover', (e) => {
  if (e.pointerType === 'touch') return;
  const row = e.target.closest?.(LINE);
  if (!row || lineAdd.parentElement?.parentElement === row) return;
  lineAdd.setAttribute('aria-label', said(row.dataset.ln));
  lineAdd.title = `${said(row.dataset.ln)} (Shift-click another for a range)`;
  $(':scope > td.sign', row)?.append(lineAdd); // over the sign, out of the flow: the code doesn't move
});
// The keyboard's way in: the diff takes focus (Tab), ↑ ↓ pick a line and Enter comments on it,
// Shift+Enter on the lines from the last one picked, as a shift-click does.
document.addEventListener('keydown', (e) => {
  const box = e.target.closest?.('.pn-changes[data-task] .cx-diff .diff-scroll');
  if (!box || e.target !== box || e.metaKey || e.ctrlKey || e.altKey) return;
  const rows = $$('tr[data-ln]', box);
  if (!rows.length) return;
  let i = rows.findIndex((r) => r.classList.contains('kb-line'));
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    rows[i]?.classList.remove('kb-line');
    i = i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    rows[i].classList.add('kb-line');
    lineAdd.setAttribute('aria-label', said(rows[i].dataset.ln));
    $(':scope > td.sign', rows[i])?.append(lineAdd);
    rows[i].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && i >= 0) {
    e.preventDefault();
    $(':scope > td.no', rows[i]).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: e.shiftKey }));
  }
});
document.addEventListener('focusout', (e) => {
  if (e.target.matches?.('.cx-diff .diff-scroll')) $$('tr.kb-line', e.target).forEach((r) => r.classList.remove('kb-line'));
});
// A shift-click picks lines, not text.
document.addEventListener('mousedown', (e) => {
  if (e.shiftKey && e.target.closest?.(LINE_HIT)) e.preventDefault();
});
document.addEventListener('click', (e) => {
  const hit = e.target.closest?.(LINE_HIT);
  if (!hit || e.target.closest('.cmt-mark')) return;
  const row = hit.closest('tr[data-ln]');
  const id = row?.closest('.pn-changes')?.dataset.task;
  const file = row?.closest('.cx-file')?.dataset.path;
  if (!id || !file) return;
  const k = row.dataset.ln;
  const same = (x) => x?.id === id && x.file === file;
  const grow = (e.shiftKey || (TOUCH.matches && same(lineDraft))) && same(lineFrom) && lineFrom.k !== k;
  let rows = grow && rowsOf(id, file, lineFrom.k, k);
  if (!rows) {
    lineFrom = { id, file, k };
    rows = rowsOf(id, file, k, k);
  }
  if (!rows) return;
  const note = same(lineDraft) ? lineDraft.ta.value : '';
  const c = { ...lineComment(file, rows), first: rowKey(rows[0]), last: rowKey(rows.at(-1)) };
  const trs = domRows($(`.pn-changes[data-task="${CSS.escape(id)}"]`), c);
  openNote({ id, c, anchor: trs?.at(-1)?.querySelector('td.no') || row.querySelector('td.no'), rows: trs, note });
});

// The diff's rows between two keys, in order; none when a gap lies between (not one run of lines).
function rowsOf(id, file, k1, k2) {
  const all = changesOf(id)?.files?.find((f) => f.path === file)?.rows || [];
  const i = all.findIndex((r) => rowKey(r) === k1);
  const j = all.findIndex((r) => rowKey(r) === k2);
  if (i < 0 || j < 0) return null;
  const rows = all.slice(Math.min(i, j), Math.max(i, j) + 1);
  return rows.every((r) => r.op === '+' || r.op === '-' || r.op === ' ') ? rows : null;
}
// A line comment's rows on screen, while its file's diff shows and still says what was commented on
// (the agent may have moved the lines since).
function domRows(sec, c) {
  const id = sec?.dataset.task;
  const rows = id && rowsOf(id, c.file, c.first, c.last);
  if (!rows || lineComment(c.file, rows).quote !== c.quote) return null;
  const file = $$(':scope > .cx-list > .cx-file', sec).find((f) => f.dataset.path === c.file);
  const trs = file ? $$('.cx-diff tr[data-ln]', file) : [];
  const i = trs.findIndex((t) => t.dataset.ln === c.first);
  const j = trs.findIndex((t) => t.dataset.ln === c.last);
  return i < 0 || j < i ? null : trs.slice(i, j + 1);
}

// Their marks: the number on the first line's gutter, the lines lit. Kept and moved, like the others.
export function paintLineMarks(id) {
  const sec = $(`.pn-changes[data-task="${CSS.escape(id)}"]`);
  if (!sec) return;
  const old = new Map($$('.cmt-mark.cmt-line', sec).map((m) => [m.dataset.c, m]));
  const lit = new Set();
  listOf(id).forEach((c, k) => {
    if (c.kind !== 'line') return;
    const rows = domRows(sec, c);
    const cell = rows && $(':scope > td.no', rows[0]);
    if (!cell) return;
    for (const r of rows) lit.add(r);
    const n = k + 1;
    let m = old.get(c.id);
    old.delete(c.id);
    if (!m) return void mark(cell, n, c, {}, 'cmt-line');
    if (m.parentElement !== cell) cell.append(m);
    if (m.textContent !== String(n)) ((m.textContent = n), m.setAttribute('aria-label', `Comment ${n}`));
    m.title = c.note || 'Comment';
  });
  for (const m of old.values()) m.remove();
  for (const r of $$('tr.cmt-lit', sec)) if (!lit.has(r)) r.classList.remove('cmt-lit');
  for (const r of lit) r.classList.add('cmt-lit');
}

function editLine(m) {
  const sec = m.closest('.pn-changes');
  const id = sec?.dataset.task;
  const c = id && listOf(id).find((x) => x.id === m.dataset.c);
  if (c) openNote({ id, c, anchor: m, rows: domRows(sec, c) });
}

// From the tray: Changes opens on the file, its lines come into view and their mark flashes.
async function jumpToLine(id, c, edit) {
  const { openPanel } = await import('./panel.js');
  openFile(id, c.file);
  openPanel(id, 'changes');
  // Its diff may still be on its way (a first look at Changes): wait for it a little.
  for (let t = 0; t < 30; t++) {
    const sec = $(`.pn-changes[data-task="${CSS.escape(id)}"]`);
    const rows = sec && !sec.hidden && domRows(sec, c);
    const m = rows && $(`.cmt-mark[data-c="${CSS.escape(c.id)}"]`, rows[0]);
    if (m) {
      const list = $('.cx-list', sec);
      const r = rows[0].getBoundingClientRect();
      const l = list.getBoundingClientRect();
      if (r.top < l.top + 40 || rows.at(-1).getBoundingClientRect().bottom > l.bottom) list.scrollBy({ top: r.top - l.top - l.height / 3, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      m.classList.remove('cmt-flash');
      void m.offsetWidth;
      m.classList.add('cmt-flash');
      if (edit) setTimeout(() => openNote({ id, c, anchor: m, rows }), 320);
      return;
    }
    await new Promise((ok) => setTimeout(ok, 100));
  }
  // Not in the diff any more (the agent changed those lines): the note opens by itself.
  if (edit) openNote({ id, c, anchor: $(`.item[data-id="${CSS.escape(id)}"] .cmt-row[data-c="${CSS.escape(c.id)}"]`) });
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
  return { html, rest, count: notes.length, lines: notes.filter((c) => c.kind === 'line').length };
}
