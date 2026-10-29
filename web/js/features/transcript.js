// The full transcript: everything the agent said and did in a turn, oldest first, on a timeline that
// ends with its presentation, rendered as blocks. Off by default (Settings → General → Full
// transcript); any card switches with its Transcript button or V.

import { countChanges, fmtDuration, renderPresentation } from '../blocks.js';
import { esc, md } from '../md.js';
import { $, el, icon } from '../core/dom.js';
import { load, S, save } from '../core/state.js';

export const KIND_ICON = { check: 'check', read: 'read', edit: 'pen', run: 'terminal', search: 'search', web: 'web', agent: 'agent', plan: 'plan', tool: 'tool', text: 'text', error: 'warn', ask: 'ask', answer: 'check', wait: 'ask', background: 'clock', account: 'clock', watch: 'eye' };

// --- which view a card shows ---------------------------------------------------

// Cards switched away from the setting: session id → true (transcript) or false (presentation).
const picked = new Map(Object.entries(load('wisp.transcript', {})));
const savePicks = () => save('wisp.transcript', Object.fromEntries(picked));

export const transcriptByDefault = () => S.config.defaults?.transcript === 'on';
export const transcriptOn = (id) => picked.get(id) ?? transcriptByDefault();

export function pickView(id, on) {
  if (on === transcriptByDefault()) picked.delete(id);
  else picked.set(id, on);
  if (S.sessions.size) for (const k of picked.keys()) if (!S.sessions.has(k)) picked.delete(k);
  savePicks();
}

// A new setting applies to every card, including the ones switched by hand before.
export function clearPicks() {
  picked.clear();
  savePicks();
}

// --- what the transcript shows -----------------------------------------------

// The agent's final answer is its presentation, shown as blocks at the end rather than as a message.
// It's the turn's last message (or last few: some harnesses stream it in parts); wisp's own notes
// after it (Auto's test check) don't break the run. Returns their indexes in turn.activity.
export function finalAnswer(t) {
  const out = new Set();
  const raw = typeof t.raw === 'string' ? t.raw : '';
  const acts = t.activity || [];
  if (!raw.trim()) return out;
  for (let i = acts.length - 1; i >= 0; i--) {
    const a = acts[i];
    if (a.by === 'wisp') continue;
    const head = a.kind === 'text' ? String(a.label || '').trim().slice(0, 200) : '';
    if (!head || !raw.includes(head)) break;
    out.add(i);
  }
  return out;
}

// A message as it reads mid-run: the presentation it ends with is on its way, not prose to show.
export const messageText = (text) => {
  const s = String(text || '');
  const open = s.search(/```wisp/);
  return (open < 0 ? s : s.slice(0, open)).trim();
};

// Steps between two messages, in runs. A run longer than FOLD_AT shows KEEP at each end and folds the
// middle behind one row.
const FOLD_AT = 12;
const KEEP = 4;
export function layout(items) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length > FOLD_AT) out.push(...run.slice(0, KEEP), { fold: run.slice(KEEP, -KEEP) }, ...run.slice(-KEEP));
    else out.push(...run);
    run = [];
  };
  for (const it of items) {
    if (it.kind === 'text') {
      flush();
      out.push(it);
    } else run.push(it);
  }
  flush();
  return out;
}

const OPENS = new Set(['run', 'search', 'web', 'tool', 'agent']);
const findChange = (t, file) => t?.changes?.find((c) => c.file === file);
// Edits a step made: its own slice of the file's edits when the server linked them, else the file's.
const editsOf = (a, t) => {
  const c = findChange(t, a.file);
  if (!c) return null;
  return Array.isArray(a.edits) ? c.edits.slice(a.edits[0], a.edits[1]) : c.edits;
};

// Whether a step opens up to more: a command and what it printed, an edit's diff, an error in full.
// Mid-run an edit's diff isn't loaded yet, so it opens anyway and fetches it.
function opens(a, t, live) {
  if (a.kind === 'error') return true;
  if (a.kind === 'edit') return !!a.file && (live || !!findChange(t, a.file));
  return OPENS.has(a.kind) && !!(a.output || a.detail);
}

// How far into the turn a step came, shown on hover.
const since = (a, t) => (a.t && t.startedAt ? `<time class="tx-t" title="Since the turn started">${fmtDuration(Math.max(0, a.t - t.startedAt))}</time>` : '');

function stepHtml(a, k, t, live) {
  const more = opens(a, t, live);
  // The command itself, unless the label already is it ("Running ls; …" when there was no description).
  const flat = a.kind === 'run' && a.detail ? a.detail.replace(/\s+/g, ' ').trim() : '';
  const cmd = flat && !String(a.label || '').replace(/\s+/g, ' ').includes(flat.slice(0, 24)) ? flat : '';
  const edits = a.kind === 'edit' && editsOf(a, t);
  const n = edits ? countChanges(edits) : null;
  return `<li class="tx-step k-${esc(a.kind)}${a.by === 'wisp' ? ' by-wisp' : ''}" data-k="${k}">
    <div class="tx-row" ${more ? 'role="button" tabindex="0" aria-expanded="false"' : ''}>
      <span class="tx-ic">${icon(a.kind === 'account' ? 'clock' : a.by === 'wisp' ? 'spark' : KIND_ICON[a.kind] || 'tool')}</span>
      <span class="tx-label">${esc(a.label || '')}</span>
      ${cmd ? `<code class="tx-cmd">${esc(cmd)}</code>` : ''}
      ${n ? `<span class="nums"><span class="plus">+${n.add}</span><span class="minus">−${n.del}</span></span>` : ''}
      ${since(a, t)}
      ${a.file && (a.kind === 'read' || a.kind === 'edit') ? `<button class="tx-open" title="Open in editor" aria-label="Open in editor">${icon('external')}</button>` : ''}
      ${more ? icon('chevron', 'chev') : ''}
    </div>
  </li>`;
}

function msgHtml(a, k, t) {
  const text = messageText(a.label);
  return text ? `<li class="tx-msg" data-k="${k}"><span class="tx-dot"></span><div class="prose">${md(text)}</div>${since(a, t)}</li>` : '';
}

const foldHtml = (n, k) => `<li class="tx-fold" data-k="${k}"><button class="tx-row"><span class="tx-ic">${icon('dots')}</span><span class="tx-label">${n} more step${n === 1 ? '' : 's'}</span></button></li>`;

// The steps rendered into a list, by data-k: the row's item, or a fold's hidden items.
const registry = new WeakMap();

function listHtml(list, items, t, live, { fold = true } = {}) {
  const reg = registry.get(list);
  return (fold ? layout(items) : items)
    .map((it) => {
      const k = reg.push(it) - 1;
      if (it.fold) return foldHtml(it.fold.length, k);
      return it.kind === 'text' ? msgHtml(it, k, t) : stepHtml(it, k, t, live);
    })
    .join('');
}

// --- rendering ---------------------------------------------------------------

// Where the timeline ends. How long it took is on the hero right under it.
const endLabel = (t) => {
  if (t.status === 'error') return ['Ended with an error', 'warn'];
  if (t.status === 'stopped') return [t.presentation?.blocks?.[0]?.title === 'Interrupted' ? 'Interrupted' : 'Stopped', 'stop'];
  return ['Finished', 'done'];
};

// A finished turn: the timeline, then the presentation. ctx is the block context (turns.js ctxFor).
export function renderTranscript(s, t, ctx) {
  const skip = finalAnswer(t);
  const items = (t.activity || []).filter((_, i) => !skip.has(i));
  const notes = t.presentation?.notes;
  if (notes) items.push({ kind: 'text', label: notes, t: t.endedAt });
  const msgs = items.filter((a) => a.kind === 'text').length;
  const steps = items.length - msgs;
  const [end, endIcon] = endLabel(t);
  const node = el(`
    <div class="tx">
      <div class="tx-head">
        <span class="tx-title">${icon('transcript')}Transcript</span>
        <span class="tx-count">${[msgs && `${msgs} message${msgs === 1 ? '' : 's'}`, steps && `${steps} step${steps === 1 ? '' : 's'}`].filter(Boolean).join(' · ') || 'Nothing recorded'}</span>
        ${t.trimmed ? `<span class="tx-count" title="A turn keeps its latest steps">· ${t.trimmed} earlier not kept</span>` : ''}
        <span class="grow"></span>
        ${items.length > 10 ? `<button class="link xs tx-jump">Jump to the result${icon('arrow')}</button>` : ''}
      </div>
      <ol class="tx-list"></ol>
    </div>`);
  const list = $('.tx-list', node);
  registry.set(list, []);
  list.innerHTML = listHtml(list, items, t, false) + `<li class="tx-end st-${esc(t.status)}"><span class="tx-ic">${icon(endIcon)}</span><span class="tx-label">${esc(end)}</span></li>`;
  node.append(renderPresentation(t.presentation, ctx));
  wire(node, s, t, ctx);
  return node;
}

// A running turn: the timeline so far, which onActivity grows (appendStep). The working panel with
// its Stop button and any question sits under it (turns.js).
export function renderLiveTranscript(s, t, ctx) {
  const node = el(`<div class="tx live"><ol class="tx-list"></ol></div>`);
  const list = $('.tx-list', node);
  registry.set(list, []);
  list.innerHTML = listHtml(list, t.activity || [], t, true);
  wire(node, s, t, ctx);
  return node;
}

// A new step. In a running turn it goes at the end, and the working panel under the timeline holds
// still on screen while the timeline grows above it, so watching a run reads like a chat; scrolled
// away, nothing moves. A finished turn still gets wisp's own steps after the agent's answer (Auto
// checking the tests): they go above the end marker, and what you're reading below doesn't move.
export function appendStep(turnNode, item, t, scrollBy) {
  const list = $('.tx-list', turnNode);
  const reg = list && registry.get(list);
  if (!reg) return;
  const live = !!list.closest('.live');
  const html = item.kind === 'text' ? msgHtml(item, reg.length, t) : stepHtml(item, reg.length, t, live);
  if (!html) return;
  reg.push(item);
  const end = $(':scope > .tx-end', list);
  const anchor = live ? $('.w-panel', turnNode) : end;
  const r = anchor?.getBoundingClientRect();
  const held = !r ? null : live ? (r.bottom > 0 && r.top < innerHeight ? r.top : null) : r.bottom <= 0 ? r.top : null;
  const li = el(html);
  li.classList.add('new');
  list.insertBefore(li, end);
  if (held !== null) scrollBy(anchor.getBoundingClientRect().top - held);
}

// A step that changed after it was shown (its output came in).
export const sameStep = (a, b) => (a.call || b.call ? a.call === b.call : a.t === b.t && a.kind === b.kind && a.label === b.label);
export function updateStep(turnNode, item, t) {
  for (const list of turnNode.querySelectorAll('.tx-list')) {
    const reg = registry.get(list) || [];
    const k = reg.findLastIndex((x) => !x.fold && sameStep(x, item));
    if (k < 0) continue;
    Object.assign(reg[k], item);
    const li = $(`.tx-step[data-k="${k}"]`, list);
    if (!li) continue;
    const open = li.classList.contains('open');
    const next = el(stepHtml(reg[k], k, t, list.closest('.live') !== null));
    li.replaceWith(next);
    if (open) toggleStep(next, reg[k], t, null);
  }
}

// What a step opens to.
function moreEl(a, t, ctx) {
  if (a.kind === 'edit') {
    const edits = editsOf(a, t);
    if (!edits) return el(`<div class="tx-more"><p class="tx-none">No captured edits for this file.</p></div>`);
    const blocks = edits.map((e) => ({ type: 'diff', file: a.file, before: e.before, after: e.after, bare: true }));
    const box = el(`<div class="tx-more tx-diff"></div>`);
    box.append(renderPresentation({ blocks }, { ...ctx, turn: t }));
    return box;
  }
  if (a.kind === 'error') return el(`<div class="tx-more"><pre class="tx-out err">${esc(a.label)}</pre></div>`);
  const cmd = a.detail ? `<span class="tx-cmdline">${a.kind === 'run' ? '<b>$</b> ' : ''}${esc(a.detail)}</span>` : '';
  const out = a.output ? `<span class="tx-res">${esc(a.output)}</span>` : '';
  return el(`<div class="tx-more"><pre class="tx-out">${cmd}${out}</pre></div>`);
}

async function toggleStep(li, a, t, ctx) {
  const row = $('.tx-row', li);
  const open = !li.classList.contains('open');
  li.classList.toggle('open', open);
  row.setAttribute('aria-expanded', open);
  $('.tx-more', li)?.remove();
  if (!open) return;
  // Mid-run, the card's copy of the turn predates this edit: load it first.
  if (a.kind === 'edit' && !findChange(t, a.file) && ctx?.refresh) {
    li.classList.add('loading');
    t = (await ctx.refresh())?.turns?.find((x) => x.id === t.id) || t;
    a.edits ??= t.activity?.findLast((x) => sameStep(x, a))?.edits; // linked to its edit after it was shown
    li.classList.remove('loading');
    if (!li.classList.contains('open')) return;
  }
  li.append(moreEl(a, t, ctx || {}));
}

function wire(node, s, t, ctx) {
  // The latest copy of the turn: a refetch replaces it while this node stays.
  const turn = () => S.full.get(s.id)?.turns?.find((x) => x.id === t.id) || t;
  const itemOf = (li) => registry.get(li.closest('.tx-list'))?.[li.dataset.k];
  const act = (e) => {
    if (e.target.closest('.tx-jump')) return $('.tx-end', node)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    const li = e.target.closest('.tx-step, .tx-fold');
    const a = li && itemOf(li);
    if (!a) return;
    if (e.target.closest('.tx-open')) return ctx.openFile(a.file);
    if (a.fold) {
      const list = li.closest('.tx-list');
      li.outerHTML = listHtml(list, a.fold, turn(), node.classList.contains('live'), { fold: false });
      return;
    }
    if (e.target.closest('.tx-row[role="button"]') && !e.target.closest('.tx-more')) toggleStep(li, a, turn(), ctx);
  };
  node.addEventListener('click', act);
  node.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.tx-row[role="button"]')) {
      e.preventDefault();
      e.stopPropagation(); // Enter on the page would fold the whole card (keys.js)
      act(e);
    }
  });
}
