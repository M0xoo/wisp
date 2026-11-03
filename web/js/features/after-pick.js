// The task picker after "/after " in a prompt or follow-up box: type a few letters of a task's title
// (or its ID) and pick it with ↑↓ and Enter (or a click); it goes in as a mention, `@Title` in the
// box and `@[Title](wisp:<id>)` in what's sent, which /after reads (slash-text.js afterAsk). A pasted
// ID becomes the same mention (mentions.js). Only tasks on this computer: its wisp sees them done.

import { esc } from '../md.js';
import { $$, el } from '../core/dom.js';
import { isScheduled, S } from '../core/state.js';
import { popover } from '../ui/popover.js';
import { cleanTitle } from '../mention-text.js';

const NATIVE = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
const LEAD = /^\/after\s+([^\n@]{0,60})$/i; // what the box shows up to the caret, before a task is picked
const MAX = 8;
let picker = null; // { ta, node, close, list, act, start }

const where = (s) => (s.archived ? 'Archived' : isScheduled(s) ? 'Scheduled' : s.state === 'done' ? 'Done' : s.state === 'running' ? 'Working' : s.state === 'waiting' || s.state === 'review' ? 'Needs you' : '');
// Unfinished first (what you'd wait for), then the most recently active.
const rank = (s) => (s.state === 'done' || s.archived ? 1 : 0);

export function afterMatches(q, list = [...S.sessions.values()]) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return list
    .filter((s) => !s.pending && !s.machine && !s.parentId && s.kind !== 'reminder' && s.agent !== 'wisp')
    .filter((s) => !words.length || words.every((w) => (s.title || '').toLowerCase().includes(w)) || (words.length === 1 && s.id.startsWith(words[0])))
    .sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
    .slice(0, MAX);
}

function pickerFor(ta) {
  if (!ta?.mentions) return closePicker();
  const caret = ta.selectionStart;
  if (caret !== ta.selectionEnd) return closePicker();
  const m = NATIVE.get.call(ta).slice(0, caret).match(LEAD);
  if (!m) return closePicker();
  const list = afterMatches(m[1].trim());
  if (!list.length) return closePicker();
  if (!picker || picker.ta !== ta) {
    closePicker();
    const node = el(`<div class="menu cr-pick af-pick" role="listbox" aria-label="Task to wait for"></div>`);
    node.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep the box focused
      const b = e.target.closest('[data-i]');
      if (b) choose(Number(b.dataset.i));
    });
    picker = { ta, node, close: popover(node, { anchor: ta, back: ta, onClose: () => (picker = null) }), act: 0 };
  }
  Object.assign(picker, { list, start: caret - m[1].length, act: Math.min(picker.act, list.length - 1) });
  picker.node.innerHTML = `<div class="wm-h">After which task? <small>↵ to pick · or paste its ID</small></div>${list
    .map((s, i) => `<button type="button" class="cr-pick-row${i === picker.act ? ' act' : ''}" data-i="${i}" role="option"><span class="cr-main"><b>${esc(cleanTitle(s.title))}</b><small>${esc([where(s), s.project].filter(Boolean).join(' · '))}</small></span></button>`)
    .join('')}`;
  // Under the box where there's room, else over it.
  const r = ta.getBoundingClientRect();
  const h = picker.node.offsetHeight;
  picker.node.style.left = `${Math.max(8, Math.min(r.left + 8, innerWidth - picker.node.offsetWidth - 8))}px`;
  picker.node.style.top = `${r.bottom + 6 + h < innerHeight ? r.bottom + 6 : Math.max(8, r.top - h - 6)}px`;
}

function closePicker() {
  picker?.close();
  picker = null;
}

function choose(i) {
  const p = picker;
  const s = p?.list[i];
  if (!s) return;
  const { ta } = p;
  const title = cleanTitle(s.title);
  if (!ta.mentions.some((x) => x.id === s.id)) ta.mentions.push({ id: s.id, title });
  ta.focus();
  ta.setSelectionRange(p.start, ta.selectionStart);
  closePicker();
  if (!document.execCommand('insertText', false, `@${title} `)) {
    ta.setRangeText(`@${title} `, ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// Capture: the / menu's pick fires an input that doesn't bubble.
document.addEventListener(
  'input',
  (e) => {
    if (e.target instanceof HTMLTextAreaElement && e.target.mentions) pickerFor(e.target);
  },
  true,
);
// Capture: ahead of the box's own Enter (which would send) and its ↑ (the prompts sent before).
document.addEventListener(
  'keydown',
  (e) => {
    if (!picker || e.target !== picker.ta || e.isComposing) return;
    const n = picker.list.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      picker.act = (picker.act + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      $$('.cr-pick-row', picker.node).forEach((b, i) => b.classList.toggle('act', i === picker.act));
    } else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') choose(picker.act);
    else if (e.key === 'Escape') closePicker();
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  },
  true,
);
document.addEventListener('focusout', (e) => {
  if (picker && e.target === picker.ta) setTimeout(() => document.activeElement !== picker?.ta && closePicker());
});
