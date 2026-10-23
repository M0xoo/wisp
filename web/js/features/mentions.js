// Task mentions in a prompt box, the way Linear does issue links: copy a task's id (right-click a
// card → Copy task ID), paste it into a prompt, and it shows as the task's title. The agent gets
// the id and reads that task with wisp_session.
//
// A textarea can't hold chips, so the box shows `@Title` as plain text and a mirror behind it,
// laid out exactly like the textarea, paints a chip under each mention. The ids stay on the box
// (ta.mentions). Its `value` reads and writes the stored form, `@[Title](wisp:<id>)`, so drafts,
// sends and restores elsewhere keep the mentions without knowing about them.

import { esc } from '../md.js';
import { el } from '../core/dom.js';
import { MOBILE, S } from '../core/state.js';
import { toast } from '../ui/toast.js';
import { cleanTitle, decode, encode, pastedTasks, spans } from '../mention-text.js';

const NATIVE = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
// What the mirror copies from the textarea, so its text wraps on the same lines.
const METRICS = ['font', 'letterSpacing', 'wordSpacing', 'lineHeight', 'textTransform', 'textIndent', 'tabSize', 'whiteSpace', 'overflowWrap', 'wordBreak', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing'];

export function mentionBox(ta) {
  if (ta.mentions) return ta;
  ta.mentions = [];
  const wrap = el('<div class="mn-wrap"></div>');
  const mirror = el('<div class="mn-mirror" aria-hidden="true"></div>');
  ta.replaceWith(wrap);
  wrap.append(mirror, ta);
  const shown = () => NATIVE.get.call(ta);

  Object.defineProperty(ta, 'value', {
    configurable: true,
    get: () => encode(shown(), ta.mentions),
    set: (v) => {
      const d = decode(v);
      ta.mentions = d.mentions;
      NATIVE.set.call(ta, d.text);
      paint();
    },
  });

  function paint() {
    const text = shown();
    const found = ta.mentions.length ? spans(text, ta.mentions) : [];
    wrap.classList.toggle('has-mn', found.length > 0);
    if (!found.length) return (mirror.textContent = '');
    const cs = getComputedStyle(ta);
    for (const k of METRICS) mirror.style[k] = cs[k];
    // A scrollbar narrows the textarea's text; narrow the mirror's the same.
    const bar = ta.offsetWidth - ta.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
    mirror.style.paddingRight = `${parseFloat(cs.paddingRight) + Math.max(0, bar)}px`;
    let html = '';
    let at = 0;
    for (const s of found) {
      html += `${esc(text.slice(at, s.start))}<mark class="mn">${esc(text.slice(s.start, s.end))}</mark>`;
      at = s.end;
    }
    mirror.innerHTML = `${html}${esc(text.slice(at))}​`;
    sync();
  }
  const sync = () => {
    mirror.scrollTop = ta.scrollTop;
    mirror.scrollLeft = ta.scrollLeft;
  };

  ta.addEventListener('input', paint);
  ta.addEventListener('scroll', sync);
  new ResizeObserver(paint).observe(ta);

  ta.addEventListener('paste', (e) => {
    if (e.clipboardData?.files?.length) return; // attachments take those
    const ids = pastedTasks(e.clipboardData?.getData('text/plain'), (id) => S.sessions.has(id) && !S.sessions.get(id).pending);
    if (!ids) return;
    e.preventDefault();
    for (const id of ids) {
      const title = cleanTitle(S.sessions.get(id).title);
      if (!ta.mentions.some((m) => m.id === id)) ta.mentions.push({ id, title });
    }
    const before = shown().slice(0, ta.selectionStart);
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    insert(lead + ids.map((id) => `@${ta.mentions.find((m) => m.id === id).title}`).join(' ') + ' ');
  });

  // Backspace right after a mention (or Delete right before one) takes the whole mention.
  ta.addEventListener('keydown', (e) => {
    if ((e.key !== 'Backspace' && e.key !== 'Delete') || e.isComposing || e.altKey || e.metaKey || e.ctrlKey) return;
    const { selectionStart: a, selectionEnd: b } = ta;
    if (a !== b || !ta.mentions.length) return;
    const hit = spans(shown(), ta.mentions).find((s) => (e.key === 'Backspace' ? s.end === a : s.start === a));
    if (!hit) return;
    e.preventDefault();
    ta.setSelectionRange(hit.start, hit.end);
    insert('');
  });

  // Through the editing commands, so Cmd+Z undoes it like typing.
  function insert(text) {
    if (!document.execCommand('insertText', false, text)) {
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  paint();
  return ta;
}

export async function copyTaskId(id) {
  const s = S.sessions.get(id);
  if (!s || s.pending) return;
  try {
    await navigator.clipboard.writeText(id);
    toast(`Copied the ID of <b>${esc(cleanTitle(s.title))}</b>. Paste it into a prompt to point an agent at this task.`);
  } catch {
    toast(`Couldn’t copy. The task ID is <code>${id}</code>`, { tone: 'bad', timeout: 8000 });
  }
}

// Clicking a mention chip in a turn's prompt opens that task, or says it's gone.
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a.mn[href^="#/s/"]');
  if (!a) return;
  const id = a.getAttribute('href').slice(4);
  if (S.sessions.has(id) && MOBILE) {
    // The phone keeps its history for Back (ui/back.js): open it without a new entry.
    e.preventDefault();
    if (location.hash === `#/s/${id}`) window.dispatchEvent(new HashChangeEvent('hashchange'));
    else location.replace(`#/s/${id}`);
    return;
  }
  if (S.sessions.has(id)) {
    // the #/s/ route reveals it; the address may already name it (it's open), so no hashchange
    if (location.hash === `#/s/${id}`) window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  e.preventDefault();
  toast('That task is no longer in wisp.', { tone: 'bad' });
});
