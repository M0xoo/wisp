// The side panel's editor (design/side-panel.md): a file the task changed, opened from its row in
// Changes, edited in place and saved back to the task's folder (PUT /sessions/:id/source). The
// code is highlighted under a transparent textarea, so typing, selection, undo and the caret are
// the browser's own. Saving is instant and rolls back with a toast if the server refuses: while
// the agent works (its next edit would land on yours), or when the file changed since it opened.

import { esc, highlight, langOf } from '../md.js';
import { api } from '../core/api.js';
import { $, el, icon } from '../core/dom.js';
import { MOBILE, S } from '../core/state.js';
import { ask } from '../ui/confirm.js';
import { combo } from '../ui/kbd.js';
import { overlay } from '../ui/overlay.js';
import { popover, refocus } from '../ui/popover.js';
import { toast, toastError } from '../ui/toast.js';
import { palette } from '../palette.js';
import { changesOf } from './changes.js';

let cur = null; // { id, path, sec, hash, saved (text on disk), busy }

const live = (id) => ['running', 'waiting'].includes(S.sessions.get(id)?.state);
export const editing = () => cur && { id: cur.id, path: cur.path };

// Open path of task id over the panel's sections, at line if given; onClose runs once it's gone
// (Changes repaints). The same file again just moves to the line.
export async function openEditor(panel, id, path, { onClose, onSaved, line } = {}) {
  if (cur?.id === id && cur.path === path && ta()) return line && goLine(line);
  if (cur && !(await closeEditor())) return;
  const sec = el(`
    <section class="pn-edit" aria-label="Edit ${esc(path)}">
      <header class="ed-head">
        <button class="icon-btn ed-back" data-a="ed-close" title="Back to Changes (Esc)" aria-label="Back to Changes">${icon('back')}</button>
        <span class="ed-path mono" title="${esc(path)}">${esc(path)}</span>
        <button class="ghost xs ed-lsp" data-a="ed-install" hidden></button>
        <button class="ghost xs ed-probs" data-a="ed-probs" hidden></button>
        <span class="ed-state" aria-live="polite"></span>
        <button class="primary sm ed-save" data-a="ed-save" title="Save (${combo('S')})" disabled>Save</button>
      </header>
      <p class="ed-note" hidden></p>
      <div class="ed-body">
        <div class="ed-skel" aria-hidden="true">${[62, 48, 71, 35, 56, 66, 40, 52].map((w) => `<i class="sk" style="width:${w}%"></i>`).join('')}</div>
      </div>
    </section>`);
  panel.append(sec);
  cur = { id, path, sec, panel, hash: '', saved: '', busy: false, onClose, onSaved, line };
  sec.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'ed-close') closeEditor();
    if (a === 'ed-save') save();
    if (a === 'ed-theirs') load(true);
    if (a === 'ed-mine') save({ force: true });
    if (a === 'ed-probs') problemsList();
    if (a === 'ed-install') installSupport(e.target.closest('[data-lang]')?.dataset.lang);
  });
  sec.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') (e.preventDefault(), save());
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') (e.preventDefault(), openFileFinder(cur.panel, cur.id, { onClose: cur.onClose, onSaved: cur.onSaved }));
    else if (e.key === 'F12' && e.shiftKey && e.target.matches('textarea')) (e.preventDefault(), findReferences(e.target));
    else if (e.key === 'F2' && e.target.matches('textarea')) (e.preventDefault(), renameSymbol(e.target));
    else if (e.ctrlKey && e.key === ' ' && e.target.matches('textarea')) (e.preventDefault(), complete(e.target));
    else if (e.key === 'F12' && e.target.matches('textarea')) (e.preventDefault(), goToDefinition(e.target));
    else if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), closeEditor());
  });
  await load();
}

// Closing with unsaved work asks first. Resolves false when you chose to stay.
export async function closeEditor({ force = false } = {}) {
  if (!cur) return true;
  const ed = cur;
  if (!force && dirty() && !(await ask(`Discard your changes to ${ed.path}?`, { ok: 'Discard', danger: true, anchor: $('.ed-back', ed.sec) }))) {
    if (cur === ed) keysBack();
    return false;
  }
  if (cur !== ed) return true;
  cur = null;
  ed.sec.remove();
  refocus(rowOf(ed));
  ed.onClose?.();
  return true;
}

// Where the keyboard goes as the editor closes: the file's row in Changes (Edit here, or More when
// the row folds it), else Open file…
function rowOf({ panel, path }) {
  const row = [...panel.querySelectorAll('.pn-changes .cx-file')].find((n) => n.dataset.path === path);
  return [...(row ? [$('.cx-edit', row), $('.cx-more', row)] : []), $('.cx-find', panel)].find((b) => b?.offsetParent);
}

// The keyboard back in the file, caret and scroll where they were; a picker over it does this as it closes
const keysBack = () => refocus(ta(), { preventScroll: true });
const picker = (node) => overlay(node, { onClose: keysBack });

const ta = () => cur && $('textarea', cur.sec);
const dirty = () => !!cur && !!ta() && ta().value !== cur.saved;

async function load(theirs = false) {
  const ed = cur;
  let f;
  try {
    f = await api(`/sessions/${ed.id}/source?path=${encodeURIComponent(ed.path)}`);
  } catch (err) {
    if (cur !== ed) return;
    $('.ed-body', ed.sec).innerHTML = `<div class="cx-msg">${icon('warn')}<p>${esc(err.message)}</p></div>`;
    return;
  }
  if (cur !== ed) return;
  ed.hash = f.hash;
  ed.saved = f.text;
  // Loading the file again (Load theirs, a rename) keeps your place in it
  const place = ta() && [ta().selectionStart, $('.ed-scroll', ed.sec).scrollTop];
  if (theirs || !ta()) paintBody(f.text);
  if (place) (ta().setSelectionRange(place[0], place[0]), ($('.ed-scroll', ed.sec).scrollTop = place[1]));
  note('');
  paintState();
  if (!MOBILE) ta()?.focus({ preventScroll: true });
  if (ed.line) goLine(ed.line);
  ed.line = 0; // once: a later Load theirs stays where you are
  checkProblems();
}

function paintBody(text) {
  const body = $('.ed-body', cur.sec);
  body.innerHTML = `
    <div class="ed-scroll">
      <pre class="ed-gutter" aria-hidden="true"></pre>
      <div class="ed-code">
        <pre class="ed-hl" aria-hidden="true"><code></code></pre>
        <textarea spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off" aria-label="${esc(cur.path)}" title="${MOBILE ? '' : `${combo('')}click a name or F12: where it’s defined · ⇧F12: where it’s used · F2: rename · Ctrl+Space: complete · ${combo('P')}: find a file or text`}"></textarea>
      </div>
    </div>`;
  const t = ta();
  t.value = text;
  t.setSelectionRange(0, 0); // a new value leaves the caret after the last line, and focus would scroll there
  const lang = langOf(cur.path);
  const rows = changesOf(cur.id)?.files?.find((f) => f.path === cur.path)?.rows || [];
  let added = new Set(rows.filter((r) => r.op === '+' && r.b != null).map((r) => r.b));
  let lines = text.split('\n').length;
  // Lines typed in or taken out move the marks under them, so a mark stays on the task's line
  const follow = () => {
    const n = t.value.split('\n').length;
    const d = n - lines;
    if (!d) return;
    const at = t.value.slice(0, t.selectionStart).split('\n').length - Math.max(d, 0); // the line the change began on
    added = new Set([...added].flatMap((l) => (l <= at ? [l] : d < 0 && l <= at - d ? [] : [l + d])));
    lines = n;
  };
  const paint = () => {
    // The trailing newline keeps the last line's height when the file ends with one.
    $('.ed-hl code', body).innerHTML = `${highlight(t.value, lang)}\n`;
    const n = t.value.split('\n').length;
    const g = $('.ed-gutter', body);
    // The lines the task added are marked (the diff's numbers when the file opened, moved by your edits since)
    // and what the language server finds wrong, by line (its message as the tip)
    const probs = cur.problems || new Map();
    const key = `${n}:${[...added].join(',')}:${[...probs].map(([l, p]) => `${l}${p.severity}`).join(',')}`;
    const num = (l) => {
      const p = probs.get(l);
      const cls = [added.has(l) && 'g-add', p && `g-${p.severity}`].filter(Boolean).join(' ');
      return cls ? `<span class="${cls}" title="${esc(p ? p.message : 'Added by the task')}">${l}</span>` : l;
    };
    if (g.dataset.k !== key) (g.innerHTML = Array.from({ length: n }, (_, i) => num(i + 1)).join('\n')), (g.dataset.k = key);
    paintState();
  };
  cur.repaint = paint;
  let quiet = 0;
  t.addEventListener('input', () => {
    follow();
    paint();
    clearTimeout(quiet);
    quiet = setTimeout(checkProblems, 1200); // once typing pauses, what's wrong now
  });
  hoverOn(t);
  // ⌘-click (Ctrl on Windows and Linux) a name: where it's defined, as editors do
  t.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey) goToDefinition(t);
  });
  // Tab indents (and Shift+Tab outdents) the lines under the selection, as editors do.
  t.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    const unit = /^\t/m.test(t.value) ? '\t' : '  ';
    const { selectionStart: a, selectionEnd: b, value: v } = t;
    if (a === b && !e.shiftKey) return document.execCommand('insertText', false, unit);
    const from = v.lastIndexOf('\n', a - 1) + 1;
    const lines = v.slice(from, b).split('\n');
    const next = lines.map((l) => (e.shiftKey ? l.replace(unit === '\t' ? /^\t/ : /^ {1,2}/, '') : unit + l)).join('\n');
    t.setSelectionRange(from, b);
    document.execCommand('insertText', false, next); // keeps undo
    t.setSelectionRange(from, from + next.length);
  });
  paint();
}

function paintState() {
  if (!cur) return;
  const d = dirty();
  const working = live(cur.id);
  // The word stays short, so the file name and Back keep their room. Why Save is off is the tip on
  // both; touch has no tips, so there the word says it
  const held = d && working && !cur.busy;
  const why = held ? 'The agent is working on this task: save once it stops' : '';
  const state = $('.ed-state', cur.sec);
  state.textContent = cur.busy ? 'Saving…' : held && (MOBILE || matchMedia('(hover: none)').matches) ? 'Agent working' : d ? 'Unsaved' : 'Saved';
  state.title = why;
  state.classList.toggle('dirty', d && !cur.busy);
  const btn = $('.ed-save', cur.sec);
  btn.disabled = !d || cur.busy || working;
  btn.style.visibility = d || cur.busy ? '' : 'hidden'; // "Saved" says it: no dead button beside it (its room stays)
  btn.title = why || `Save (${combo('S')})`;
}

function note(html) {
  const n = $('.ed-note', cur.sec);
  n.innerHTML = html;
  n.hidden = !html;
}

// At once: the box says Saved; back to Unsaved with a red toast if the server refuses. A file
// that changed underneath offers theirs or yours, never a silent overwrite.
async function save({ force = false } = {}) {
  const ed = cur;
  if (!ed || ed.busy || (!force && !dirty())) return;
  const text = ta().value;
  const was = ed.saved;
  ed.busy = true;
  ed.saved = text;
  paintState();
  try {
    if (force) ed.hash = (await api(`/sessions/${ed.id}/source?path=${encodeURIComponent(ed.path)}`)).hash;
    const r = await api(`/sessions/${ed.id}/source`, { method: 'PUT', body: { path: ed.path, text, hash: ed.hash } });
    ed.hash = r.hash;
    if (cur === ed) (note(''), checkProblems());
    ed.onSaved?.();
  } catch (err) {
    ed.saved = was;
    if (cur === ed && err.status === 409 && /changed since/.test(err.message))
      note(`${icon('warn')}<span>The file changed since you opened it (the agent, or another window).</span><button class="ghost xs" data-a="ed-theirs">Load theirs</button><button class="ghost xs" data-a="ed-mine">Keep mine</button>`);
    else toastError(err);
  } finally {
    ed.busy = false;
    if (cur === ed) paintState();
  }
  if (cur === ed && !dirty() && !ed.sec.querySelector('.ed-note:not([hidden])')) toast(`Saved ${esc(ed.path.split('/').pop())}`, { timeout: 1800 });
}

// The panel moved to another task (or back): the editor is its task's, so it hides with it, unsaved
// work and all, and shows again on the way back. Save follows the task starting or stopping work.
export function editorFor(id) {
  if (!cur) return;
  cur.sec.hidden = cur.id !== id;
  if (cur.id === id) paintState();
}

// Open file…: any file of the task's folder, picked by name like ⌘K (GET /sessions/:id/files).
export async function openFileFinder(panel, id, { onClose, onSaved } = {}) {
  let r;
  try {
    r = await api(`/sessions/${id}/files`);
  } catch (err) {
    return toastError(err);
  }
  if (!r.files.length) return toast(r.git ? 'This task’s folder has no files yet' : 'Open file… needs a git folder: this task’s isn’t one');
  const changed = new Set((changesOf(id)?.files || []).map((f) => f.path));
  const items = r.files.map((f) => {
    const i = f.lastIndexOf('/');
    return { group: changed.has(f) ? 'Changed by this task' : 'Files', label: f.slice(i + 1), sub: i < 0 ? '' : f.slice(0, i), icon: 'file', keywords: f, rank: changed.has(f) ? 2 : 0, run: () => openEditor(panel, id, f, { onClose, onSaved }) };
  });
  // Changed files lead, as in Changes
  items.sort((a, b) => b.rank - a.rank);
  palette({ items, overlay: (node) => overlay(node, { onClose: () => (ta() ? keysBack() : refocus($('.cx-find', panel))) }), deep: grepIn(panel, id, { onClose, onSaved }), placeholder: `Find a file or text in this task’s folder${r.more ? ` (names: the first ${r.files.length.toLocaleString()})` : ''}…` });
}

// Put the caret at the start of line n and bring it into view, a little below the top.
function goLine(n) {
  const t = ta();
  if (!t) return;
  const lines = t.value.split('\n');
  n = Math.max(1, Math.min(n, lines.length));
  const at = lines.slice(0, n - 1).reduce((x, l) => x + l.length + 1, 0);
  t.focus({ preventScroll: true });
  t.setSelectionRange(at, at + lines[n - 1].length);
  const lh = parseFloat(getComputedStyle(t).lineHeight) || 20;
  $('.ed-scroll', cur.sec).scrollTop = Math.max(0, (n - 4) * lh);
}

// The caret's line and column (1-based), and the name under it.
function caretAt(t) {
  const v = t.value;
  const before = v.slice(0, t.selectionStart);
  const line = before.split('\n').length;
  const col = t.selectionStart - before.lastIndexOf('\n');
  let a = t.selectionStart;
  let b = a;
  while (a > 0 && /[\w$]/.test(v[a - 1])) a--;
  while (b < v.length && /[\w$]/.test(v[b])) b++;
  return { line, col, name: v.slice(a, b) };
}

// Ask the task's language server (POST /lsp). null when there's none for this file: the caller
// falls back to the text search, and the editor offers to install one where wisp can.
async function lsp(op, extra = {}) {
  const ed = cur;
  try {
    const r = await api(`/sessions/${ed.id}/lsp`, { method: 'POST', body: { op, path: ed.path, text: ta()?.value, ...extra } });
    // No server here but one wisp can install: a quiet offer in the head, where it moves nothing
    const offer = $('.ed-lsp', ed.sec);
    if (cur === ed && offer && !MOBILE && !offer.disabled) {
      offer.hidden = !(!r.lsp && r.install);
      if (!offer.hidden) {
        offer.dataset.lang = langKey(ed.path);
        offer.innerHTML = `${icon('spark')}<span>Add ${esc(r.install)} support</span>`;
        offer.setAttribute('aria-label', `Add ${r.install} support`);
        offer.title = `Definitions and references use text search for now. ${r.install} support (a language server, installed once for every task) gives exact answers, types on hover, rename and problems as you type.`;
      }
    }
    return r.lsp ? r : null;
  } catch {
    return null;
  }
}
const langKey = (p) => (/\.py[i]?$/i.test(p) ? 'py' : 'ts');

// Places to open: one opens at its line, several are picked from like a file.
function goTo(hits, title) {
  const ed = cur;
  const opts = { onClose: ed.onClose, onSaved: ed.onSaved };
  if (hits.length === 1) return openEditor(ed.panel, ed.id, hits[0].path, { ...opts, line: hits[0].line });
  palette({ items: hits.map((h) => ({ group: `${hits.length} ${title}`, label: `${h.path.split('/').pop()}:${h.line}`, sub: h.text, icon: 'file', keywords: h.path, run: () => openEditor(ed.panel, ed.id, h.path, { ...opts, line: h.line }) })), overlay: picker, placeholder: `${hits.length} ${title}…` });
}

// ⌘-click or F12: where the name under the caret is defined. The language server's answer when
// there is one; else the text search's (a declaring keyword before the name, GET /grep?def=).
async function goToDefinition(t) {
  const ed = cur;
  const { line, col, name } = caretAt(t);
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return;
  const r = await lsp('definition', { line, col });
  if (cur !== ed) return;
  if (r?.hits?.length) return goTo(r.hits, `places define ${name}`);
  let g;
  try {
    g = await api(`/sessions/${ed.id}/grep?def=${encodeURIComponent(name)}`);
  } catch (err) {
    return toastError(err);
  }
  if (cur !== ed) return;
  if (!g.hits.length) return toast(`No definition of <b>${esc(name)}</b> in this task’s folder`);
  goTo(g.hits, `places define ${name}`);
}

// ⇧F12: every place the name is used, the language server's, else the text search's.
async function findReferences(t) {
  const ed = cur;
  const { line, col, name } = caretAt(t);
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return;
  const r = await lsp('references', { line, col });
  if (cur !== ed) return;
  let hits = r?.hits;
  if (!hits) {
    const g = await api(`/sessions/${ed.id}/grep?q=${encodeURIComponent(name)}`).catch(() => ({ hits: [] }));
    hits = g.hits.filter((h) => new RegExp(`(^|[^\\w$])${name.replace(/\$/g, '\\$')}([^\\w$]|$)`).test(h.text));
  }
  if (cur !== ed) return;
  if (!hits.length) return toast(`No uses of <b>${esc(name)}</b> found`);
  goTo(hits, r ? `references to ${name}` : `text matches for ${name}`);
}

// Ctrl+Space: what the language server would write here, picked like ⌘K; it replaces the word typed so far.
async function complete(t) {
  const ed = cur;
  const { line, col } = caretAt(t);
  const r = await lsp('completion', { line, col });
  if (cur !== ed) return;
  if (!r) return toast('Completions need language support for this file');
  if (!r.items.length) return toast('Nothing to complete here');
  const end = t.selectionStart;
  let start = end;
  while (start > 0 && /[\w$]/.test(t.value[start - 1])) start--;
  const typed = t.value.slice(start, end);
  palette({
    items: r.items.map((x) => ({ group: 'Complete', label: x.label, sub: x.detail, icon: 'spark', run: () => (t.focus(), t.setSelectionRange(start, end), document.execCommand('insertText', false, x.insert)) })),
    overlay: picker,
    placeholder: typed ? `Complete ${typed}…` : 'Complete…',
  });
}

// F2: rename the name under the caret everywhere the language server knows it is, across files.
// The file must be saved (the server writes the files), and not while the agent works.
async function renameSymbol(t) {
  const ed = cur;
  const { line, col, name } = caretAt(t);
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return;
  if (dirty()) return toast('Save first: renaming writes the files');
  const r = t.getBoundingClientRect();
  const box = el(`<div class="menu ed-rename" role="dialog" aria-label="Rename ${esc(name)}" style="top:${Math.min(innerHeight - 90, r.top + 40)}px;left:${r.left + 40}px"><label class="ed-rn"><span>Rename <b class="mono">${esc(name)}</b> everywhere to</span><input class="input mono" value="${esc(name)}" spellcheck="false" autocomplete="off"></label></div>`);
  const close = popover(box, { anchor: t, back: t });
  const input = $('input', box);
  input.focus();
  input.select();
  input.onkeydown = async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const to = input.value.trim();
    close();
    keysBack();
    if (!to || to === name) return;
    try {
      const res = await api(`/sessions/${ed.id}/lsp`, { method: 'POST', body: { op: 'rename', path: ed.path, text: t.value, line, col, newName: to } });
      if (!res.lsp) return toast(res.install ? `Rename needs ${esc(res.install)} support: add it at the top of the file` : 'Rename needs language support for this file');
      toast(`Renamed <b>${esc(name)}</b> to <b>${esc(to)}</b> in ${res.count} place${res.count === 1 ? '' : 's'}, ${res.files.length} file${res.files.length === 1 ? '' : 's'}`);
      if (cur === ed) (await load(true), ed.onSaved?.());
    } catch (err) {
      toastError(err);
    }
  };
}

// What's wrong in the file, from its language server: marked in the gutter, listed from the head.
async function checkProblems() {
  const ed = cur;
  const r = await lsp('diagnostics');
  if (cur !== ed || !ed.repaint) return;
  ed.problems = new Map();
  for (const d of r?.diagnostics || []) if (!ed.problems.has(d.line) || d.severity === 'error') ed.problems.set(d.line, d);
  ed.problemList = r?.diagnostics || [];
  const b = $('.ed-probs', ed.sec);
  const errs = ed.problemList.filter((d) => d.severity === 'error').length;
  b.hidden = !ed.problemList.length;
  b.className = `ghost xs ed-probs${errs ? ' bad' : ''}`;
  b.innerHTML = `${icon('warn')}<span>${ed.problemList.length} problem${ed.problemList.length === 1 ? '' : 's'}</span>`;
  ed.repaint();
}
function problemsList() {
  const ed = cur;
  if (!ed?.problemList?.length) return;
  palette({ items: ed.problemList.map((d) => ({ group: d.severity === 'error' ? 'Errors' : 'Warnings and notes', label: `Line ${d.line}`, sub: d.message, icon: 'warn', run: () => goLine(d.line) })), overlay: picker, placeholder: `${ed.problemList.length} problems in ${ed.path.split('/').pop()}…` });
}

// Rest the pointer on a name: what it is, from the language server (types, signatures, docs).
function hoverOn(t) {
  if (MOBILE) return;
  let timer = 0;
  let tip = null;
  let cw = 0;
  const hide = () => (clearTimeout(timer), tip?.remove(), (tip = null));
  t.addEventListener('mouseleave', hide);
  t.addEventListener('keydown', hide);
  t.addEventListener('mousemove', (e) => {
    hide();
    timer = setTimeout(async () => {
      const ed = cur;
      const cs = getComputedStyle(t);
      if (!cw) {
        const c = document.createElement('canvas').getContext('2d');
        c.font = `${cs.fontSize} ${cs.fontFamily}`;
        cw = c.measureText('M'.repeat(40)).width / 40;
      }
      const rect = t.getBoundingClientRect();
      const line = Math.floor((e.clientY - rect.top - parseFloat(cs.paddingTop)) / (parseFloat(cs.lineHeight) || 20)) + 1;
      const col = Math.floor((e.clientX - rect.left - parseFloat(cs.paddingLeft)) / cw) + 1;
      const l = t.value.split('\n')[line - 1];
      if (!l || col < 1 || col > l.length || !/[\w$]/.test(l[col - 1])) return;
      const r = await lsp('hover', { line, col });
      if (cur !== ed || !r?.hover) return;
      tip = el(`<div class="ed-hover" role="tooltip"><pre>${esc(r.hover.replace(/^```\w*\n?|\n?```$/gm, '').trim())}</pre></div>`);
      ed.sec.append(tip);
      const box = ed.sec.getBoundingClientRect();
      tip.style.left = `${Math.min(e.clientX - box.left, box.width - tip.offsetWidth - 8)}px`;
      // Above the name's line (never over it); under it only when there's no room above
      const lh = parseFloat(cs.lineHeight) || 20;
      const lineTop = rect.top + parseFloat(cs.paddingTop) + (line - 1) * lh - box.top;
      tip.style.top = `${lineTop - tip.offsetHeight - 6 < 48 ? lineTop + lh + 6 : lineTop - tip.offsetHeight - 6}px`;
    }, 600);
  });
}

// Install the npm language servers wisp knows into its own folder (POST /lsp/install).
async function installSupport(lang) {
  const b = cur && $('.ed-lsp', cur.sec);
  if (!b) return;
  b.disabled = true;
  $('span', b).textContent = 'Installing…';
  try {
    await api('/lsp/install', { method: 'POST', body: { lang } });
    toast('Language support is in: definitions, references, types and problems are exact now');
    b.hidden = true;
  } catch (err) {
    $('span', b).textContent = 'Add language support';
    toastError(err);
  } finally {
    b.disabled = false;
  }
  checkProblems();
}

// Open file…'s second half: what the words typed say inside the files (GET /grep?q=), after the names.
const grepIn = (panel, id, opts) => async (q) => {
  const { hits } = await api(`/sessions/${id}/grep?q=${encodeURIComponent(q)}`);
  const re = new RegExp(`(${esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return hits.map((h) => ({ group: 'In files', label: `${h.path.split('/').pop()}:${h.line}`, sub: h.text, subHtml: esc(h.text).replace(re, '<mark class="pal-hit">$1</mark>'), icon: 'search', run: () => openEditor(panel, id, h.path, { ...opts, line: h.line }) }));
};
