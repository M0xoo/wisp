// /side: a side discussion about a task, on a page of its own (server/side.js). It's a task like
// any other (full answers, follow-ups, blocks) that reads the main task's work and changes nothing.
// Here: starting one from a follow-up box, and the chips that link the two.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import { el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { toast, toastError } from '../ui/toast.js';
import { popover } from '../ui/popover.js';
import { expand, reveal } from './feed.js';
import { sideAsk } from '../slash-text.js';
import { launchBehind } from './launcher.js';
import { paintMeta } from './turns.js';

// Optimistic: a placeholder task opens in the list at once and the main task counts it; a refusal
// takes both back and gives the text back (restore).
// run: { agent, model, effort } to talk it over on another harness (a spell's side action).
export async function startSide(id, text, { attachments = [], restore, agent, model, effort } = {}) {
  const main = S.sessions.get(id) || S.full.get(id);
  if (!main) return;
  // Refused here before anything shows, where the server would refuse it anyway.
  if (!sideable(main)) return (restore?.(), toast(main.machine ? 'Side discussions are for tasks on this computer for now.' : main.sideOf ? 'This is a side discussion already: carry on here, or start another from the main task.' : 'This task can’t have a side discussion.', { tone: 'bad' }));
  const ghost = `pending-side-${Date.now()}`;
  const count = (fn) => {
    const cur = S.sessions.get(id);
    if (cur) S.sessions.set(id, { ...cur, sides: fn(cur.sides || []) });
    paintMeta(id);
  };
  count((l) => [...l, ghost]);
  try {
    const runner = { agent: agent || main.agent, model: model ?? (agent ? '' : main.model), effort: effort ?? (agent ? '' : main.effort) };
    const next = await launchBehind({ prompt: text, cwd: main.cwd, runner, sideOf: { id, title: main.title } }, () => api(`/sessions/${id}/side`, { method: 'POST', body: { text, attachments, agent: agent || undefined, model: model || undefined, effort: effort || undefined } }));
    count((l) => [...l.filter((x) => x !== ghost && x !== next.id), next.id]);
    // Opens if you're still on the main task; moved on meanwhile, you're told instead of pulled away.
    if (S.focus === id || !S.focus) reveal(next.id);
    else toast('Side discussion started', { action: { label: 'Open', run: () => reveal(next.id) } });
  } catch (err) {
    count((l) => l.filter((x) => x !== ghost));
    restore?.();
    toastError(err);
  }
}

const sideTitle = (f) => S.sessions.get(f.id)?.title || f.title;

// The bar's chips: on a side discussion, the task it's about; on that task, its side discussions.
export function sideChips(s, summary) {
  const of = s.sideOf;
  const sides = ((summary.id ? summary.sides : s.sides) || []).filter((x) => S.sessions.has(x) || x.startsWith('pending-'));
  const from = of
    ? S.sessions.has(of.id)
      ? `<button class="m side-of" data-a="side-of" title="${esc(`A read-only side discussion: it reads “${sideTitle(of)}” and its work as they are now, and changes nothing. Open that task`)}">${icon('discuss')}<span>Side discussion of <b>${esc(sideTitle(of))}</b></span></button>`
      : `<span class="m side-of" title="The task this side discussion was about was deleted">${icon('discuss')}<span>Side discussion of <b>${esc(of.title)}</b></span></span>`
    : '';
  // Still starting (only the placeholder): a count, not a button that would open nothing yet.
  const starting = sides.every((x) => x.startsWith('pending-'));
  const list = !sides.length ? '' : starting ? `<span class="m sides" title="Starting the side discussion…">${icon('discuss')}<span>${sides.length} side discussion${sides.length > 1 ? 's' : ''}</span></span>` : `<button class="m sides" data-a="sides" title="${sides.length > 1 ? 'Side discussions about this task' : 'Open the side discussion about this task'}"${sides.length > 1 ? ' aria-haspopup="menu"' : ''}>${icon('discuss')}<span>${sides.length} side discussion${sides.length > 1 ? 's' : ''}</span></button>`;
  return from + list;
}

// Above a side discussion's first message: what it's about and that it only reads.
export function sideLine(of) {
  const there = S.sessions.has(of.id);
  const line = el(`<div class="fork-line side-line"><span>${icon('discuss')}<i class="sl-of">Side discussion of ${there ? `<button class="link" title="${esc(`Open “${sideTitle(of)}”, the task this side discussion is about`)}">${esc(sideTitle(of))}</button>` : `<b title="${esc(of.title)}">${esc(of.title)}</b>`}</i><i class="sl-ro">· reads its work, changes nothing</i></span></div>`);
  const b = line.querySelector('button');
  if (b) b.onclick = () => reveal(of.id);
  return line;
}

const STATE_WORD = { running: 'Working', waiting: 'Asking', review: 'Review', done: 'Done' };

// The "N side discussions" chip: one opens at once, several in a menu.
export function sidesMenu(id, btn) {
  const ids = (S.sessions.get(id)?.sides || S.full.get(id)?.sides || []).filter((x) => S.sessions.has(x));
  if (ids.length === 1) return reveal(ids[0]);
  if (!ids.length) return;
  const r = btn.getBoundingClientRect();
  const menu = el(`<div class="menu forks-menu sides-menu" style="top:${r.bottom + 6}px;left:${r.left}px">
      ${ids.map((x) => { const f = S.sessions.get(x); return `<button data-id="${esc(x)}">${icon('discuss')}<span class="fm-title">${esc(f.title)}</span><span class="fm-state st-${esc(f.state)}">${esc(STATE_WORD[f.state] || f.state)}</span></button>`; }).join('')}
    </div>`);
  menu.onclick = (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    close();
    reveal(b.dataset.id);
  };
  const close = popover(menu);
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 8 - menu.offsetWidth))}px`;
  if (r.bottom + 6 + menu.offsetHeight > innerHeight - 8) menu.style.top = `${Math.max(8, r.top - 6 - menu.offsetHeight)}px`;
}

// Side discussion… (More, right-click, ⌘K): the task opens with "/side " in its follow-up box.
export const sideable = (s) => !!s && s.agent !== 'wisp' && !s.parentId && !s.pending && !s.delegated && !s.sideOf && s.kind !== 'reminder' && !s.machine;
export function sideDraft(id) {
  reveal(id);
  const go = () => {
    const ta = document.querySelector(`.item[data-id="${CSS.escape(id)}"] .reply`);
    if (!ta) return;
    if (sideAsk(ta.value) === null) ta.value = `/side ${ta.value.trim()}`; // a draft already there becomes the opening message
    ta.dispatchEvent(new Event('input'));
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  };
  S.open.has(id) ? setTimeout(go, 50) : expand(id).then(go);
}
