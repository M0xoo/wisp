// /side: a side discussion about a task, on a page of its own (server/side.js). It's a task like
// any other (full answers, follow-ups, blocks) in the main task's folder: it runs commands and edits
// behind a clash check, or only reads on a harness that can't ask before a write (sideOf.edits).
// Here: starting one from a follow-up box, the chips that link the two, and the clash card with its
// warning rows.

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

// What a side discussion does to the main task's work, in a line.
export const sideDoes = (of) => (of?.edits === false ? 'reads its work, changes nothing' : 'runs and edits in its work, checks for clashes first');

// The bar's chips: on a side discussion, the task it's about; on that task, its side discussions.
export function sideChips(s, summary) {
  const of = s.sideOf;
  const sides = ((summary.id ? summary.sides : s.sides) || []).filter((x) => S.sessions.has(x) || x.startsWith('pending-'));
  const from = of
    ? S.sessions.has(of.id)
      ? `<button class="m side-of" data-a="side-of" title="${esc(`A side discussion of “${sideTitle(of)}”: it ${sideDoes(of)}. Open that task`)}">${icon('discuss')}<span>Side discussion of <b>${esc(sideTitle(of))}</b></span></button>`
      : `<span class="m side-of" title="The task this side discussion was about was deleted">${icon('discuss')}<span>Side discussion of <b>${esc(of.title)}</b></span></span>`
    : '';
  // Still starting (only the placeholder): a count, not a button that would open nothing yet.
  const starting = sides.every((x) => x.startsWith('pending-'));
  const list = !sides.length ? '' : starting ? `<span class="m sides" title="Starting the side discussion…">${icon('discuss')}<span>${sides.length} side discussion${sides.length > 1 ? 's' : ''}</span></span>` : `<button class="m sides" data-a="sides" title="${sides.length > 1 ? 'Side discussions about this task' : 'Open the side discussion about this task'}"${sides.length > 1 ? ' aria-haspopup="menu"' : ''}>${icon('discuss')}<span>${sides.length} side discussion${sides.length > 1 ? 's' : ''}</span></button>`;
  return from + list;
}

// Above a side discussion's first message: what it's about and what it may do.
export function sideLine(of) {
  const there = S.sessions.has(of.id);
  const line = el(`<div class="fork-line side-line"><span>${icon('discuss')}<i class="sl-of">Side discussion of ${there ? `<button class="link" title="${esc(`Open “${sideTitle(of)}”, the task this side discussion is about`)}">${esc(sideTitle(of))}</button>` : `<b title="${esc(of.title)}">${esc(of.title)}</b>`}</i><i class="sl-ro">· ${esc(sideDoes(of))}</i></span></div>`);
  const b = line.querySelector('button');
  if (b) b.onclick = () => reveal(of.id);
  return line;
}

// The rows under a side discussion's prompt: it touched a file the main task changed too. No card:
// an overlap is only said, and a command that hit main's file has already told the main task.
export function sideWarnRows(t) {
  if (!t.sideWarn?.length) return null;
  return el(`<ul class="side-warns">${t.sideWarn.map((w) => `<li class="side-warn">${icon('warn')}<span><code>${esc(w.file)}</code> ${w.kind === 'command' ? 'also changed by' : 'is being changed by'} the main task, <b>${esc(w.main)}</b>${w.kind === 'command' ? ': a command here changed it, and the main task was told' : ', on other lines'}</span></li>`).join('')}</ul>`);
}

const range = (r) => (r.from === r.to ? `line ${r.from}` : r.from > r.to ? `after line ${r.to}` : `lines ${r.from}–${r.to}`);
const CLASH_WHY = {
  lines: 'These are lines the main task changed.',
  write: 'This replaces a file the main task changed.',
  unlocated: 'wisp can’t tell which lines this touches, in a file the main task changed.',
  command: 'This command rewrites work the main task shares.',
  cleared: 'The main task moved: it no longer touches these lines.',
};

// A diff of what the side wants, as lines: what goes, what comes.
const proposedHtml = (p) => `${p.before ? p.before.split('\n').map((l) => `<span class="clash-del">${esc(l) || ' '}</span>`).join('') : ''}${p.after.split('\n').map((l) => `<span class="clash-add">${esc(l) || ' '}</span>`).join('')}`;

// The clash card: in the side discussion, before the write, whatever mode the main task is in. Only
// here: the main task's run never pauses for it. An approval, so spells can't reach it.
export function clashCardHtml(a) {
  const c = a.clash;
  const of = esc(c.mainTitle);
  const side = c.command ? `<pre class="perm-detail">${esc(c.command)}</pre>` : `<pre class="perm-detail clash-diff">${proposedHtml(c.proposed)}</pre>`;
  const main = c.main.length ? `<div class="clash-label">The main task’s ${esc(c.main.map(range).join(', '))}</div><pre class="perm-detail">${esc(c.main.map((m) => m.text).join('\n…\n'))}</pre>` : c.files?.length ? `<div class="clash-label">Files of the main task it removes</div><pre class="perm-detail">${esc(c.files.join('\n'))}</pre>` : '';
  return `
    <div class="ask-card perm clash">
      <div class="q-head">${icon('warn')}<span>${c.kind === 'cleared' ? 'No clash any more' : 'Clash with the main task'}</span></div>
      <p class="q-text">${c.command ? 'Run this command?' : `<code>${esc(c.file)}</code>`}</p>
      <p class="q-context">${c.moved ? `<b>The main task moved while this waited.</b> ` : ''}${esc(CLASH_WHY[c.kind] || '')} Main task: ${of}.</p>
      <div class="clash-label">${c.command ? 'This side discussion wants to run' : 'This side discussion’s change'}</div>
      ${side}
      ${main}
      <div class="q-opts">${a.options.map((o, i) => `<button class="opt ${i === 0 ? 'go' : 'no'}" data-i="${i}"><span class="k">${i + 1}</span>${esc(o)}</button>`).join('')}</div>
      <form class="q-own"><input class="input" aria-label="Say what to do instead" placeholder="Or say what to do instead (keeps main’s version)…"><button class="ghost sm">Send</button></form>
    </div>`;
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
