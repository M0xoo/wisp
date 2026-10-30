// The side panel's Changes (design/side-panel.md): every file the task changed, each diff opening
// in place under its row. A worktree's is git's (GET /sessions/:id/changes: since the branch left
// the base, committed or not); without one, or a wisp too old to say, the edits wisp captured, turn
// by turn, merged per file. Rows are keyed by path and patched in place while the agent works:
// never re-appended, open ones stay open.

import { countChanges, copy } from '../blocks.js';
import { diffLines, hunks } from '../diff.js';
import { esc, highlight, langOf } from '../md.js';
import { api } from '../core/api.js';
import { $, el, icon } from '../core/dom.js';
import { MOBILE, S } from '../core/state.js';
import { popover } from '../ui/popover.js';
import { toast } from '../ui/toast.js';
import { agentName } from './runners.js';
import { spellProp } from './spells.js';

const SHOWN_LINES = 300; // a file's diff past this waits for Show more
const SHOWN_FILES = 200;
const BADGE = { A: ['A', 'add'], M: ['M', 'mod'], D: ['D', 'del'], R: ['R', 'ren'] };

const data = new Map(); // task id -> { files, base, git, at, error } the last answer
const open = new Map(); // task id -> Set of paths whose diff shows
const whole = new Map(); // task id -> Set of paths shown past SHOWN_LINES
const unfolded = new Set(); // task ids with their generated files shown (and the 200+ ones)
const loading = new Map(); // task id -> the request on its way (one at a time, the last one wins)

export const CHANGES_HTML = '<section class="pn-changes" hidden><div class="cx-sum"></div><div class="cx-list"></div></section>';

const live = (s) => s?.state === 'running' || s?.state === 'waiting';
const setOf = (m, id) => m.get(id) || (m.set(id, new Set()), m.get(id));

// What wisp captured, merged per file in turn order. Paths under the task's folder lose it.
function captured(id, root) {
  const s = S.full.get(id);
  if (!s) return null;
  const strip = (p) => (root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);
  const by = new Map();
  for (const t of s.turns || [])
    for (const c of t.changes || []) {
      const f = by.get(c.file) || { path: strip(c.file), status: c.op === 'create' ? 'A' : 'M', edits: [], reverted: true };
      if (!c.reverted) (f.edits.push(...(c.edits || [])), (f.reverted = false));
      by.set(c.file, f);
    }
  return [...by.values()]
    .map((f) => {
      const n = f.reverted ? { add: 0, del: 0 } : countChanges(f.edits);
      // Each edit is a snippet, not the whole file: its lines aren't numbered, a gap row sits between.
      const rows = f.edits.flatMap((e, i) => [...(i ? [{ op: 'sep' }] : []), ...hunks(diffLines(e.before || '', e.after || ''), 3).map((r) => ({ ...r, a: undefined, b: undefined }))]);
      return { path: f.path, status: f.status, add: n.add, del: n.del, reverted: f.reverted, rows, more: 0 };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

export async function loadChanges(id, { root } = {}) {
  if (loading.has(id)) return (loading.get(id).again = true), loading.get(id).p;
  const job = { again: false };
  loading.set(id, job);
  job.p = (async () => {
    let out;
    try {
      const r = await api(`/sessions/${id}/changes`);
      out = r.files ? { files: r.files, base: r.base, git: true, untracked: r.untracked } : null;
    } catch (err) {
      // An older wisp over there has no route: what wisp saw instead. Else keep what we had.
      if (err.status !== 404) out = { ...(data.get(id) || {}), error: err.message };
    }
    if (!out || (!out.files && out.error)) {
      const files = captured(id, root);
      out = files ? { files, git: false, ...(out?.error && !data.get(id)?.files ? { error: out.error } : {}) } : out || { files: null };
    }
    data.set(id, { ...out, at: Date.now() });
  })();
  await job.p;
  loading.delete(id);
  if (job.again) return loadChanges(id, { root });
}

export const changesOf = (id) => data.get(id);
// Stale: the next look fetches it again (the agent edited, a turn ended).
export const changesSeen = (id) => data.has(id);

// --- painting --------------------------------------------------------------------------------

const SKEL = `
  <div class="cx-skel" aria-hidden="true">
    ${[52, 38, 64, 45, 58, 33].map((w) => `<div class="cx-sk-row"><i class="sk cx-sk-badge"></i><i class="sk cx-sk-path" style="width:${w}%"></i><i class="sk cx-sk-n"></i><i class="sk cx-sk-n"></i></div>`).join('')}
  </div>`;
const SUM_SKEL = '<i class="sk cx-sk-a"></i><i class="sk cx-sk-b"></i>';

export function paintChanges(sec, id) {
  const s = S.sessions.get(id);
  const d = data.get(id);
  const sum = $('.cx-sum', sec);
  const list = $('.cx-list', sec);
  const files = d?.files;
  if (!files) {
    // First look: the real shapes. Failed with nothing to show: why, and Try again.
    const msg = d?.error ? `<div class="cx-msg">${icon('warn')}<p>Couldn’t read the changes: ${esc(d.error)}</p><button class="ghost sm" data-a="cx-retry">Try again</button></div>` : SKEL;
    setHtml(sum, d?.error ? '' : SUM_SKEL);
    sum.hidden = !!d?.error;
    setList(list, msg);
    return;
  }
  sum.hidden = false;
  if (!files.length) {
    setHtml(sum, '');
    sum.hidden = true;
    const text = live(s) ? `No changes yet. Files show here as ${esc(agentName(s.agent))} edits them.` : s?.pr?.state === 'MERGED' ? 'Everything here is in main now.' : 'This task didn’t change any files.';
    setList(list, `<div class="cx-msg">${icon('file')}<p>${text}</p></div>`);
    return;
  }
  const counted = files.filter((f) => !f.reverted);
  const add = counted.reduce((n, f) => n + f.add, 0);
  const del = counted.reduce((n, f) => n + f.del, 0);
  const openSet = setOf(open, id);
  const showGen = unfolded.has(id) || spellProp('panel.changes', 'generated') === true;
  const canOpen = files.filter((f) => !f.binary && f.rows?.length && (showGen || !f.generated) && f.rows.length + (f.more || 0) <= SHOWN_LINES);
  const allOpen = canOpen.length > 0 && canOpen.every((f) => openSet.has(f.path));
  const from = d.git ? `<span class="cx-vs" title="Compared with ${esc(d.base)} where this branch left it, uncommitted changes included">vs ${esc(d.base)}</span>` : '<span class="cx-vs" title="Not a git diff: the edits wisp saw the agent make">edits wisp saw</span>';
  setHtml(
    sum,
    `<span class="cx-files">${files.length} file${files.length > 1 ? 's' : ''}</span><span class="plus">+${add}</span><span class="minus">−${del}</span>${from}<span class="grow"></span>${d.error ? `<span class="cx-upd" title="${esc(d.error)}">Couldn’t check just now</span>` : ''}${canOpen.length ? `<button class="ghost xs cx-all" data-a="cx-all" aria-pressed="${allOpen}">${allOpen ? 'Collapse all' : 'Expand all'}</button>` : ''}`,
  );
  if (list.firstElementChild?.matches('.cx-skel, .cx-msg')) (list.replaceChildren(), delete list.dataset.msg);

  // Generated files (lockfiles, builds) fold into one row at the end; past 200, the rest wait too.
  const gen = files.filter((f) => f.generated);
  const main = showGen ? files : files.filter((f) => !f.generated);
  const shown = unfolded.has(id) ? main : main.slice(0, SHOWN_FILES);
  const keys = shown.map((f) => `f:${f.path}`);
  const rest = main.length - shown.length;
  if (rest > 0) keys.push('more');
  if (gen.length && !showGen) keys.push('gen');
  const byKey = new Map([...list.children].map((n) => [n.dataset.k, n]));
  keys.forEach((k, i) => {
    let node = byKey.get(k);
    if (!node) {
      node = el(`<div class="${k.startsWith('f:') ? 'cx-file' : 'cx-fold'}" data-k="${esc(k)}"></div>`);
      if (list.childElementCount) node.classList.add('cx-new'); // a file the agent just touched; not the first paint
    }
    if (k === 'more') setHtml(node, `<button class="pn-fold shut" data-a="cx-unfold">and ${rest} more${icon('chevron', 'chev')}</button>`);
    else if (k === 'gen') {
      const n = { add: gen.reduce((x, f) => x + f.add, 0), del: gen.reduce((x, f) => x + f.del, 0) };
      setHtml(node, `<button class="pn-fold shut" data-a="cx-unfold">${gen.length} generated file${gen.length > 1 ? 's' : ''}<span class="cx-nums"><span class="plus">+${n.add}</span><span class="minus">−${n.del}</span></span>${icon('chevron', 'chev')}</button>`);
    } else paintFile(node, id, shown[i], d.git);
    if (list.children[i] !== node) list.insertBefore(node, list.children[i] || null);
  });
  for (const [k, n] of byKey) if (!keys.includes(k)) n.remove();
}

function paintFile(node, id, f, git) {
  const isOpen = setOf(open, id).has(f.path) && !f.binary && f.rows?.length > 0;
  const [ch, cls] = BADGE[f.status] || BADGE.M;
  const nums = f.binary
    ? '<span class="cx-n cx-word">binary</span>'
    : f.status === 'R' && !f.add && !f.del
      ? '<span class="cx-n cx-word">renamed</span>'
      : `<span class="cx-n plus">${f.add ? `+${f.add}` : ''}</span><span class="cx-n minus">${f.del ? `−${f.del}` : ''}</span>`;
  const title = f.from ? `Renamed from ${f.from}` : f.path;
  const head = `
    <div class="cx-head">
      <button class="cx-row" data-a="cx-toggle" aria-expanded="${isOpen}" title="${esc(title)}"${f.binary || !f.rows?.length ? ' disabled' : ''}>
        <span class="cx-chev">${f.binary || !f.rows?.length ? '' : icon('chevron')}</span>
        <span class="badge ${cls}">${ch}</span>${pathOf(f.path)}${f.reverted ? '<span class="rev-tag">Reverted</span>' : ''}
        ${nums}
      </button>
      <button class="icon-btn xs cx-more" data-a="cx-more" title="More" aria-label="More for ${esc(f.path)}">${icon('dots')}</button>
    </div>`;
  node.classList.toggle('open', isOpen);
  node.classList.toggle('gone', f.status === 'D');
  const h = $('.cx-head', node);
  if (!h) node.innerHTML = head;
  else if (node.dataset.h !== head) h.outerHTML = head;
  node.dataset.h = head;
  node.dataset.path = f.path;
  // The diff is drawn once per version of the file, so its sideways scroll stays while it updates.
  let diff = $('.cx-diff', node);
  if (!isOpen) return void diff?.remove();
  const all = setOf(whole, id).has(f.path);
  const rows = all ? f.rows : f.rows.slice(0, SHOWN_LINES);
  const left = f.rows.length - rows.length + (f.more || 0);
  const v = `${hash(f.rows)}:${rows.length}:${f.more || 0}`;
  if (diff?.dataset.v === v) return;
  const lang = langOf(f.path);
  const numbered = git;
  const body = rows
    .map((o) =>
      o.op === 'sep'
        ? '<tr class="sep"><td colspan="3"></td></tr>'
        : o.op === '…'
          ? `<tr class="gap"><td colspan="3">${icon('dots')} ${o.count} unchanged line${o.count > 1 ? 's' : ''}</td></tr>`
          : `<tr class="${o.op === '+' ? 'add' : o.op === '-' ? 'del' : ''}"><td class="no">${numbered ? (o.op === '-' ? o.a : o.b) ?? '' : ''}</td><td class="sign">${o.op === ' ' ? '' : o.op === '-' ? '−' : '+'}</td><td class="src">${highlight(o.text, lang) || ' '}</td></tr>`,
    )
    .join('');
  const html = `
    ${f.from ? `<p class="cx-from">${icon('arrow')}Renamed from <code>${esc(f.from)}</code></p>` : ''}
    <div class="diff-scroll"><table><tbody>${body}</tbody></table></div>
    ${left > 0 ? (all ? `<p class="cx-cut">${left} more line${left > 1 ? 's' : ''} not shown: open the file to read them all.</p>` : `<button class="ghost xs cx-show" data-a="cx-whole">Show ${left} more line${left > 1 ? 's' : ''}</button>`) : ''}`;
  if (!diff) node.append((diff = el(`<div class="b-diff bare cx-diff ${numbered ? '' : 'nonum'}"></div>`)));
  const x = $('.diff-scroll', diff)?.scrollLeft || 0;
  diff.innerHTML = html;
  diff.dataset.v = v;
  if (x) $('.diff-scroll', diff).scrollLeft = x;
}

// The folder in a box cut from its start (rtl), its text isolated so the slashes stay put.
function pathOf(p) {
  const i = p.lastIndexOf('/');
  return `<span class="path">${i < 0 ? '' : `<span class="dir"><bdi>${esc(p.slice(0, i + 1))}</bdi></span>`}<span class="base">${esc(p.slice(i + 1))}</span></span>`;
}

function hash(rows) {
  let h = 5381;
  for (const r of rows) for (const c of `${r.op}${r.text ?? r.count}\n`) h = ((h << 5) + h + c.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}
const setHtml = (n, html) => n.dataset.h !== html && ((n.innerHTML = html), (n.dataset.h = html));
const setList = (list, html) => list.dataset.msg !== html && ((list.innerHTML = html), (list.dataset.msg = html));

// --- clicks ----------------------------------------------------------------------------------

// A click in the section; true when it was one of its own. ctx: { root, repaint, reload, s }.
export function changesClick(e, id, ctx) {
  const b = e.target.closest('.pn-changes [data-a]');
  if (!b) return false;
  const a = b.dataset.a;
  const d = data.get(id);
  const path = b.closest('.cx-file')?.dataset.path;
  if (a === 'cx-retry') return (data.delete(id), ctx.repaint(), ctx.reload(), true);
  if (a === 'cx-unfold') return (unfolded.add(id), ctx.repaint(), true);
  if (a === 'cx-all') {
    const set = setOf(open, id);
    // Expand all skips the folded generated files and the ones too long to read at a glance.
    const showGen = unfolded.has(id) || spellProp('panel.changes', 'generated') === true;
    const can = (d?.files || []).filter((f) => !f.binary && f.rows?.length && (showGen || !f.generated) && f.rows.length + (f.more || 0) <= SHOWN_LINES);
    if (can.every((f) => set.has(f.path))) set.clear();
    else for (const f of can) set.add(f.path);
    return (ctx.repaint(), true);
  }
  if (a === 'cx-toggle') {
    const set = setOf(open, id);
    set.has(path) ? set.delete(path) : set.add(path);
    return (ctx.repaint(), true);
  }
  if (a === 'cx-whole') return (setOf(whole, id).add(path), ctx.repaint(), true);
  if (a === 'cx-more') return (fileMenu(b, id, path, ctx), true);
  return false;
}

function fileMenu(anchor, id, path, ctx) {
  const f = data.get(id)?.files?.find((x) => x.path === path);
  if (!f) return;
  const abs = ctx.root && !path.startsWith('/') ? `${ctx.root}/${path}` : path;
  const r = anchor.getBoundingClientRect();
  const menu = el(`
    <div class="menu" style="top:${r.bottom + 6}px;right:${innerWidth - r.right}px">
      ${MOBILE || f.status === 'D' ? '' : `<button data-a="editor">${icon('external')}Open in editor</button>`}
      <button data-a="path">${icon('copy')}Copy path</button>
    </div>`);
  menu.onclick = (e) => {
    const a = e.target.closest('button')?.dataset.a;
    close();
    if (a === 'path') (copy(path), toast('Path copied'));
    if (a === 'editor') import('./actions.js').then((m) => m.openInEditor(ctx.s, abs));
  };
  const close = popover(menu);
}
