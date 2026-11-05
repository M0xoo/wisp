// The side panel's Changes (design/side-panel.md): every file the task changed, each diff opening
// in place under its row. A worktree's is git's (GET /sessions/:id/changes: since the branch left
// the base, committed or not); without one, or a wisp too old to say, the edits wisp captured, turn
// by turn, merged per file. Rows are keyed by path and patched in place while the agent works:
// never re-appended, open ones stay open. A git diff's hunks each have a Revert, a file's ⋯ has
// Revert file…, and a file can be ticked Viewed until its diff changes (GitHub's way). In a
// worktree a file, or a hunk, is staged or unstaged and what's staged committed (VS Code's way).

import { countChanges, copy } from '../blocks.js';
import { diffLines, hunks, opensFirst } from '../diff.js';
import { esc, highlight, langOf } from '../md.js';
import { api } from '../core/api.js';
import { $, el, icon } from '../core/dom.js';
import { MOBILE, S } from '../core/state.js';
import { ask } from '../ui/confirm.js';
import { popover } from '../ui/popover.js';
import { toast, toastError } from '../ui/toast.js';
import { agentName } from './runners.js';
import { spellProp } from './spells.js';
import { wholeTask } from './feed.js';
import { paintLineMarks } from './comments.js';
import { hide, maskBar, reveal, revealedOf } from '../env-mask.js';

const SHOWN_LINES = 300; // a file's diff past this waits for Show more
const SHOWN_FILES = 200;
const BADGE = { A: ['A', 'add'], M: ['M', 'mod'], D: ['D', 'del'], R: ['R', 'ren'] };

const data = new Map(); // task id -> { files, base, git, at, error } the last answer
const open = new Map(); // task id -> Set of paths whose diff shows
const opened = new Set(); // task ids whose first files have opened: what you fold after that stays folded
const whole = new Map(); // task id -> Set of paths shown past SHOWN_LINES
const unfolded = new Set(); // task ids with their generated files shown (and the 200+ ones)
const loading = new Map(); // task id -> the request on its way (one at a time, the last one wins)
const going = new Set(); // `${task id}\n${path}`: files being reverted, hidden until Changes reloads
const drafts = new Map(); // task id -> the commit message typed and not sent yet
let wantCommit = null; // a task whose commit box should take focus once its Changes are in (⌘K)

export const CHANGES_HTML = '<section class="pn-changes" hidden><div class="cx-sum"></div><div class="cx-commit" hidden></div><div class="cx-list"></div></section>';

const live = (s) => s?.state === 'running' || s?.state === 'waiting';

// Viewed, per task, in this browser: path -> the file's diff when it was ticked. A file whose diff
// changed since isn't viewed any more. The 100 tasks looked at last are kept.
const VIEWED = 'wisp.viewed';
const seenAll = () => {
  try {
    return JSON.parse(localStorage.getItem(VIEWED)) || {};
  } catch {
    return {};
  }
};
const seenOf = (id) => seenAll()[id]?.files || {};
const seenKey = (f) => `${hash(f.rows || [])}:${f.status}:${f.add}:${f.del}:${f.more || 0}`;
const isSeen = (id, f, seen = seenOf(id)) => seen[f.path] === seenKey(f);
function setSeen(id, f, on) {
  const all = seenAll();
  const files = { ...(all[id]?.files || {}) };
  if (on) files[f.path] = seenKey(f);
  else delete files[f.path];
  all[id] = { at: Date.now(), files };
  const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 100);
  try {
    localStorage.setItem(VIEWED, JSON.stringify(Object.fromEntries(keep)));
  } catch {}
}
const setOf = (m, id) => m.get(id) || (m.set(id, new Set()), m.get(id));
// .env files whose Reveal is on, per task (server/env-mask.js): /changes sends those unmasked.
const unmaskedPaths = new Map();

// What wisp captured, merged per file in turn order. Paths under the task's folder lose it.
function captured(id, root) {
  const s = S.full.get(id);
  if (!s) return null;
  if (s.turns?.some((t) => t.stub)) wholeTask(id); // the phone's copy has only the latest turns' edits: the rest follow (bus 'task')
  const strip = (p) => (root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);
  const by = new Map();
  for (const t of s.turns || [])
    for (const c of t.changes || []) {
      const f = by.get(c.file) || { path: strip(c.file), status: c.op === 'create' ? 'A' : 'M', edits: [], reverted: true, envq: [] };
      // A .env file's edits come masked: Reveal fetched them as they are (env-mask.js).
      const raw = revealedOf(id, c.masked);
      if (c.masked) f.envq.push(c.masked);
      if (!c.reverted) (f.edits.push(...((raw || c).edits || [])), (f.reverted = false));
      by.set(c.file, f);
    }
  return [...by.values()]
    .map((f) => {
      const n = f.reverted ? { add: 0, del: 0 } : countChanges(f.edits);
      // Each edit is a snippet, not the whole file: its lines aren't numbered, a gap row sits between.
      const rows = f.edits.flatMap((e, i) => [...(i ? [{ op: 'sep' }] : []), ...hunks(diffLines(e.before || '', e.after || ''), 3).map((r) => ({ ...r, a: undefined, b: undefined }))]);
      const shown = f.envq.length && f.envq.every((q) => revealedOf(id, q));
      return { path: f.path, status: f.status, add: n.add, del: n.del, reverted: f.reverted, rows, more: 0, ...(f.envq.length && { envq: f.envq, ...(shown ? { unmasked: true } : { masked: true }) }) };
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
      const reveal = [...(unmaskedPaths.get(id) || [])].map((p) => `reveal=${encodeURIComponent(p)}`).join('&');
      const r = await api(`/sessions/${id}/changes${reveal ? `?${reveal}` : ''}`);
      // staging: the server says what's staged (a wisp too old to say has neither field)
      out = r.files ? { files: r.files, base: r.base, git: true, untracked: r.untracked, staging: r.files.every((f) => 'staged' in f) } : null;
    } catch (err) {
      // An older wisp over there has no route: what wisp saw instead. Else keep what we had.
      if (err.status !== 404) out = { ...(data.get(id) || {}), error: err.message };
    }
    if (!out || (!out.files && out.error)) {
      const files = captured(id, root);
      out = files ? { files, git: false, ...(out?.error && !data.get(id)?.files ? { error: out.error } : {}) } : out || { files: null };
    }
    for (const f of out?.git ? out.files || [] : []) if (unmaskedPaths.get(id)?.has(f.path)) f.unmasked = true;
    data.set(id, { ...out, at: Date.now() });
  })();
  await job.p;
  loading.delete(id);
  if (job.again) return loadChanges(id, { root });
}

export const changesOf = (id) => data.get(id);
// A diff row's key: its new number, or its old one for a line only removed. Comments find it by that.
export const rowKey = (o) => (o.op === '-' ? (o.a != null ? `o${o.a}` : '') : o.b != null ? `n${o.b}` : '');
// Open a file's diff (a comment on it was clicked in the tray); paint it after.
export const openFile = (id, path) => setOf(open, id).add(path);
// Files whose diff opens at a click (Expand all, or by themselves): not the folded generated ones, or
// ones too long to read at a glance or already viewed.
function openable(id, files, seen = seenOf(id)) {
  const showGen = unfolded.has(id) || spellProp('panel.changes', 'generated') === true;
  return files.filter((f) => !f.binary && f.rows?.length && (showGen || !f.generated) && f.rows.length + (f.more || 0) <= SHOWN_LINES && !isSeen(id, f, seen));
}
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
  sec.dataset.task = id; // comments on its lines find the task by it
  if (!files) {
    // First look: the real shapes. Failed with nothing to show: why, and Try again.
    const msg = d?.error ? `<div class="cx-msg">${icon('warn')}<p>Couldn’t read the changes: ${esc(d.error)}</p><button class="ghost sm" data-a="cx-retry">Try again</button></div>` : SKEL;
    setHtml(sum, d?.error ? '' : SUM_SKEL);
    sum.hidden = !!d?.error;
    $('.cx-commit', sec).hidden = true;
    setList(list, msg);
    return;
  }
  sum.hidden = false;
  if (!files.length) {
    setHtml(sum, '');
    sum.hidden = true;
    paintCommit(sec, id, d);
    const text = live(s) ? `No changes yet. Files show here as ${esc(agentName(s.agent))} edits them.` : s?.pr?.state === 'MERGED' ? 'Everything here is in main now.' : 'This task didn’t change any files.';
    setList(list, `<div class="cx-msg">${icon('file')}<p>${text}</p></div>`);
    return;
  }
  const counted = files.filter((f) => !f.reverted);
  const add = counted.reduce((n, f) => n + f.add, 0);
  const del = counted.reduce((n, f) => n + f.del, 0);
  const openSet = setOf(open, id);
  const showGen = unfolded.has(id) || spellProp('panel.changes', 'generated') === true;
  const seen = seenOf(id);
  const nSeen = files.filter((f) => isSeen(id, f, seen)).length;
  const canOpen = openable(id, files, seen);
  // The first time this task's files show, the diff is there without a click. A comment clicked in
  // the tray may have opened one already: that one is what you came for.
  if (!opened.has(id)) {
    opened.add(id);
    if (!openSet.size && spellProp('panel.changes', 'autoOpen') !== false) for (const f of opensFirst(canOpen)) openSet.add(f.path);
  }
  const allOpen = canOpen.length > 0 && canOpen.every((f) => openSet.has(f.path));
  const from = d.git ? `<span class="cx-vs" title="Compared with ${esc(d.base)} where this branch left it, uncommitted changes included">vs ${esc(d.base)}</span>` : '<span class="cx-vs" title="Not a git diff: the edits wisp saw the agent make">edits wisp saw</span>';
  setHtml(
    sum,
    `<span class="cx-files">${files.length} file${files.length > 1 ? 's' : ''}</span><span class="plus">+${add}</span><span class="minus">−${del}</span>${from}<span class="grow"></span>${nSeen ? `<span class="cx-seen">${nSeen} of ${files.length} viewed</span>` : ''}${d.error ? `<span class="cx-upd" title="${esc(d.error)}">Couldn’t check just now</span>` : ''}${canOpen.length ? `<button class="ghost xs cx-all" data-a="cx-all" aria-pressed="${allOpen}">${allOpen ? 'Collapse all' : 'Expand all'}</button>` : ''}${d.git ? `<button class="ghost xs cx-find" data-a="cx-find" title="Open any file of this task in the editor">${icon('search')}<span>Open file…</span></button>` : ''}`,
  );
  paintCommit(sec, id, d);
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
    } else paintFile(node, id, shown[i], d.git, isSeen(id, shown[i], seen), d.staging);
    if (list.children[i] !== node) list.insertBefore(node, list.children[i] || null);
  });
  for (const [k, n] of byKey) if (!keys.includes(k)) n.remove();
  paintLineMarks(id); // a redrawn diff lost its comments' marks
}

function paintFile(node, id, f, git, seen, staging) {
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
      </button>
      <div class="cx-acts">
      ${nums}
      ${staging ? stageBtn(f) : ''}
      <button class="cx-viewed" data-a="cx-viewed" aria-pressed="${seen}" title="${seen ? 'Viewed: untick to review it again' : 'Mark as viewed: folds it until its diff changes'}" aria-label="Viewed ${esc(f.path)}"><span class="cx-box">${icon('check')}</span><span class="cx-vw">Viewed</span></button>
      ${editable(f) ? `<button class="icon-btn xs cx-edit" data-a="cx-edit" title="Edit here" aria-label="Edit ${esc(f.path)}">${icon('pen')}</button>` : ''}
      <button class="icon-btn xs cx-more" data-a="cx-more" title="More" aria-label="More for ${esc(f.path)}">${icon('dots')}</button>
      </div>
    </div>`;
  node.classList.toggle('open', isOpen);
  node.classList.toggle('gone', f.status === 'D');
  node.classList.toggle('viewed', seen);
  node.hidden = going.has(`${id}\n${f.path}`);
  const h = $('.cx-head', node);
  if (!h) node.innerHTML = head;
  else if (node.dataset.h !== head) h.outerHTML = head;
  node.dataset.h = head;
  node.dataset.path = f.path;
  // The diff is drawn once per version of the file, so its sideways scroll stays while it updates.
  let diff = $('.cx-diff', node);
  if (!isOpen) return void diff?.remove();
  if (diff) paintHunkStage(diff, f, staging);
  const all = setOf(whole, id).has(f.path);
  const rows = all ? f.rows : f.rows.slice(0, SHOWN_LINES);
  const left = f.rows.length - rows.length + (f.more || 0);
  const env = f.masked || f.unmasked;
  const v = `${hash(f.rows)}:${rows.length}:${f.more || 0}:${f.masked ? 'm' : f.unmasked ? 'u' : ''}`;
  if (diff?.dataset.v === v) return;
  const lang = langOf(f.path);
  const numbered = git;
  const line = (o, rev = '') =>
    `<tr class="${o.op === '+' ? 'add' : o.op === '-' ? 'del' : ''}"${numbered && rowKey(o) ? ` data-ln="${rowKey(o)}"` : ''}><td class="no">${numbered ? (o.op === '-' ? o.a : o.b) ?? '' : ''}</td><td class="sign">${o.op === ' ' ? '' : o.op === '-' ? '−' : '+'}</td><td class="src">${rev}${highlight(o.text, lang) || ' '}</td></tr>`;
  const gap = (o) => `<tr class="gap"><td colspan="3">${icon('dots')} ${o.count} unchanged line${o.count > 1 ? 's' : ''}</td></tr>`;
  let body;
  if (revertable(f, git)) {
    // A git diff: one tbody per hunk (the gaps between in their own), so a hunk's Revert shows while
    // the pointer is anywhere on it. A hunk cut short here (Show more, or past what git sent) has none.
    const hs = hunkRuns(f.rows);
    body = hs
      .map((h, i) => {
        const end = h.from + h.rows.length;
        if (h.from >= rows.length) return '';
        const shownAll = end <= rows.length && !(f.more && i === hs.length - 1);
        // Its own head row, like git's @@ line: where it is, and Revert, never over the code
        const head = `<tr class="hk-head"><td colspan="3"><div class="hk-bar"><span class="hk-at">Line ${firstLine(h)}</span>${shownAll && staging ? `<button class="cx-hk-stage" data-a="cx-hunk-stage" data-h="${i}" data-key="${hash(h.rows)}" hidden></button>` : ''}${shownAll ? `<button class="cx-hk-rev" data-a="cx-hunk" data-h="${i}" data-key="${hash(h.rows)}" title="Put this change back as it was before the task" aria-label="Revert the change at line ${firstLine(h)} of ${esc(f.path)}">Revert</button>` : ''}</div></td></tr>`;
        const own = rows.slice(h.from, end);
        return `${h.gap ? `<tbody class="cx-gapb">${gap(h.gap)}</tbody>` : ''}<tbody class="cx-hunk" data-h="${i}">${head}${own.map((o) => line(o)).join('')}</tbody>`;
      })
      .join('');
  } else body = `<tbody>${rows.map((o) => (o.op === 'sep' ? '<tr class="sep"><td colspan="3"></td></tr>' : o.op === '…' ? gap(o) : line(o))).join('')}</tbody>`;
  const html = `
    ${env ? maskBar(f.path, '', !!f.unmasked, ' data-a="cx-env"') : ''}
    ${f.from ? `<p class="cx-from">${icon('arrow')}Renamed from <code>${esc(f.from)}</code></p>` : ''}
    <div class="diff-scroll"${numbered ? ` tabindex="0" aria-label="${esc(`Diff of ${f.path}: ↑ ↓ pick a line, Enter comments on it`)}"` : ''}><table>${body}</table></div>
    ${left > 0 ? (all ? `<p class="cx-cut">${left} more line${left > 1 ? 's' : ''} not shown: open the file to read them all.</p>` : `<button class="ghost xs cx-show" data-a="cx-whole">Show ${left} more line${left > 1 ? 's' : ''}</button>`) : ''}`;
  if (!diff) node.append((diff = el(`<div class="b-diff bare cx-diff ${numbered ? '' : 'nonum'}"></div>`)));
  const x = $('.diff-scroll', diff)?.scrollLeft || 0;
  diff.innerHTML = html;
  diff.dataset.v = v;
  paintHunkStage(diff, f, staging);
  if (x) $('.diff-scroll', diff).scrollLeft = x;
}

// --- staging ---------------------------------------------------------------------------------
// A file's stage toggle, before Viewed and in its style, in words: Stage, Part staged, Staged (a
// bare +/− beside the +3 −2 counts read as one of them). Its width is fixed, so nothing moves when
// it flips; a file with nothing to stage or unstage (committed) keeps its room.
function stageBtn(f) {
  if (!f.staged && !f.unstaged) return '<span class="cx-stage none" aria-hidden="true"></span>';
  const all = f.staged && !f.unstaged;
  const label = all ? 'Unstage file' : 'Stage file';
  const title = all ? 'Staged: click to unstage it' : f.staged ? 'Partly staged: click to stage the rest' : 'Stage file: it goes in the next commit';
  return `<button class="cx-stage${f.staged && f.unstaged ? ' part' : ''}" data-a="cx-stage" aria-pressed="${all}" title="${title}" aria-label="${label} ${esc(f.path)}"><span class="cx-box">${icon('check')}</span><span class="cx-vw">${all ? 'Staged' : f.staged ? 'Part' : 'Stage'}</span></button>`;
}
// A hunk's Stage / Unstage, beside its Revert, patched in place (the diff isn't redrawn, so focus and
// the sideways scroll stay). Stage while any of it is still to stage; Unstage once it's all staged;
// none for a hunk that's committed. Its width holds "Unstage" so Revert never moves.
function paintHunkStage(diff, f, staging) {
  for (const b of diff.querySelectorAll('.cx-hk-stage')) {
    const st = staging && f.hunkStage?.[Number(b.dataset.h)];
    const un = !!st && !st.unstaged && st.staged;
    b.hidden = !st || (!st.staged && !st.unstaged);
    if (b.hidden) continue;
    const text = un ? 'Unstage' : 'Stage';
    if (b.textContent !== text) b.textContent = text;
    b.dataset.un = un ? '1' : '';
    b.title = un ? 'Take this change out of the next commit' : 'Put this change in the next commit';
    b.setAttribute('aria-label', `${text} the change at line ${b.closest('.hk-bar')?.querySelector('.hk-at')?.textContent.replace('Line ', '') || ''} of ${f.path}`);
  }
}

// The commit row under the summary: a one-line message (the task's title when it's focused empty),
// how many files are staged, and Commit (Enter, ⌘Enter). Built once and patched, so what's typed and
// the focus survive every refresh. Shown in a worktree while anything is staged or still to stage.
function paintCommit(sec, id, d) {
  const row = $('.cx-commit', sec);
  const files = d?.files || [];
  const changed = files.filter((f) => f.staged || f.unstaged).length;
  const staged = files.filter((f) => f.staged).length;
  row.hidden = !d?.staging || !changed;
  if (!row.firstElementChild) {
    row.innerHTML = `<label class="field sm cx-cm-field"><input class="cx-cm-msg" type="text" placeholder="Commit message" aria-label="Commit message" maxlength="500" autocomplete="off" spellcheck="true" enterkeyhint="done"><span class="cx-cm-n"></span></label><button class="primary sm cx-cm-go" data-a="cx-commit" title="Commit (Enter)">Commit</button>`;
    const input = $('.cx-cm-msg', row);
    input.onfocus = () => {
      // Empty: the task's title, selected, to keep or type over.
      if (input.value) return;
      input.value = S.sessions.get(sec.dataset.task)?.title || '';
      input.select();
      drafts.set(sec.dataset.task, input.value);
    };
    input.oninput = () => {
      drafts.set(sec.dataset.task, input.value);
    };
    input.onkeydown = (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      $('.cx-cm-go', row).click();
    };
  }
  const input = $('.cx-cm-msg', row);
  if (row.dataset.task !== id) ((input.value = drafts.get(id) || ''), (row.dataset.task = id));
  // Empty, the box shows the message it would use (the task's title): Commit is never a mystery
  const title = S.sessions.get(id)?.title || '';
  if (input.placeholder !== (title || 'Commit message')) input.placeholder = title || 'Commit message';
  const n = $('.cx-cm-n', row);
  const text = staged ? `${staged} staged` : `Commits all ${changed}`;
  if (n.textContent !== text) n.textContent = text;
  n.title = staged ? `${staged} of ${changed} changed file${changed > 1 ? 's' : ''} staged: Commit takes those` : `Nothing staged: Commit stages all ${changed} changed file${changed > 1 ? 's' : ''} first`;
  if (wantCommit === id && d?.files) {
    wantCommit = null;
    if (!row.hidden) input.focus();
    else toast(d.staging ? 'Nothing to commit: every change here is committed' : 'Only a task with a worktree can commit here');
  }
}

// ⌘K's Commit staged changes…: Changes is open (or opening); the message box takes focus once it shows.
export function focusCommit(id) {
  wantCommit = id;
  const sec = $('#sidePanel .pn-changes');
  if (sec?.dataset.task === id && data.get(id)?.files) paintCommit(sec, id, data.get(id));
}

// The folder in a box cut from its start (rtl), its text isolated so the slashes stay put.
function pathOf(p) {
  const i = p.lastIndexOf('/');
  return `<span class="path">${i < 0 ? '' : `<span class="dir"><bdi>${esc(p.slice(0, i + 1))}</bdi></span>`}<span class="base">${esc(p.slice(i + 1))}</span></span>`;
}

// A git diff's hunks as hunks.js counts them: the runs between '…' gaps. from: the first row's
// index; gap: the gap row before it.
function hunkRuns(rows = []) {
  const out = [];
  let h = null;
  let gap = null;
  rows.forEach((o, i) => {
    if (o.op === '…') {
      h = null;
      gap = o;
      return;
    }
    if (!h) {
      out.push((h = { from: i, rows: [], gap }));
      gap = null;
    }
    h.rows.push(o);
  });
  return out;
}
// Where a hunk's change is: its first changed line's number (the old one for a line only removed).
const firstLine = (h) => {
  const o = h.rows.find((r) => r.op !== ' ') || h.rows[0];
  return (o.op === '-' ? o.a : o.b) ?? '';
};
// Hunks put back one by one: a file the task changed (not added or deleted whole), in a git diff.
const revertable = (f, git) => git && (f.status === 'M' || f.status === 'R') && !f.binary && f.rows?.length > 0;

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
    const can = openable(id, d?.files || []);
    if (can.every((f) => set.has(f.path))) set.clear();
    else for (const f of can) set.add(f.path);
    return (ctx.repaint(), true);
  }
  if (a === 'cx-env') {
    // Reveal / Hide a .env file's values here: the button flips at once, the diff follows.
    const f = d?.files?.find((x) => x.path === path);
    if (!f) return true;
    const on = !f.unmasked;
    b.textContent = on ? 'Hide' : 'Reveal';
    b.setAttribute('aria-pressed', on);
    const paths = setOf(unmaskedPaths, id);
    if (!on) {
      paths.delete(path);
      for (const q of f.envq || []) hide(id, q);
      return (ctx.reload(), true);
    }
    if (d.git) return (paths.add(path), ctx.reload(), true);
    Promise.all((f.envq || []).map((q) => reveal(id, q))).then(
      () => ctx.reload(),
      (err) => {
        b.textContent = 'Reveal';
        b.setAttribute('aria-pressed', false);
        toastError(`Couldn’t reveal it: ${err.message}`);
      },
    );
    return true;
  }
  if (a === 'cx-toggle') {
    const set = setOf(open, id);
    set.has(path) ? set.delete(path) : set.add(path);
    return (ctx.repaint(), true);
  }
  if (a === 'cx-viewed') {
    // Ticked: folded, its row dimmed; unticked: back as it was (still folded, as GitHub does).
    const f = d?.files?.find((x) => x.path === path);
    if (!f) return true;
    const on = !isSeen(id, f);
    setSeen(id, f, on);
    if (on) setOf(open, id).delete(path);
    return (ctx.repaint(), true);
  }
  if (a === 'cx-hunk') return (revertHunk(b, id, path, ctx), true);
  if (a === 'cx-stage') return (stageFile(b, id, path, ctx), true);
  if (a === 'cx-hunk-stage') return (stageHunk(b, id, path, ctx), true);
  if (a === 'cx-commit') return (commit(b, id, ctx), true);
  if (a === 'cx-whole') return (setOf(whole, id).add(path), ctx.repaint(), true);
  if (a === 'cx-more') return (fileMenu(b, id, path, ctx), true);
  if (a === 'cx-edit') return (editHere(b, id, path, ctx), true);
  if (a === 'cx-find') return (import('./editor.js').then((m) => m.openFileFinder(b.closest('.side-panel'), id, { onClose: ctx.reload, onSaved: ctx.reload })), true);
  return false;
}

// A file the panel's editor opens: text the task still has (not deleted, not binary).
const editable = (f) => f.status !== 'D' && !f.binary;
// Edit here: the editor over this panel; Changes repaints when it closes or saves.
function editHere(from, id, path, ctx) {
  import('./editor.js').then((m) => m.openEditor(from.closest('.side-panel'), id, path, { onClose: ctx.reload, onSaved: ctx.reload }));
}

function fileMenu(anchor, id, path, ctx) {
  const f = data.get(id)?.files?.find((x) => x.path === path);
  if (!f) return;
  const abs = ctx.root && !path.startsWith('/') ? `${ctx.root}/${path}` : path;
  const r = anchor.getBoundingClientRect();
  const menu = el(`
    <div class="menu" style="top:${r.bottom + 6}px;right:${innerWidth - r.right}px">
      ${editable(f) ? `<button data-a="edit">${icon('pen')}Edit here</button>` : ''}
      ${MOBILE || f.status === 'D' ? '' : `<button data-a="editor">${icon('external')}Open in editor</button>`}
      <button data-a="path">${icon('copy')}Copy path</button>
      ${data.get(id)?.git ? `<button data-a="revert" class="danger">${icon('replay')}Revert file…</button>` : ''}
    </div>`);
  menu.onclick = (e) => {
    const a = e.target.closest('button')?.dataset.a;
    close();
    if (a === 'path') (copy(path), toast('Path copied'));
    if (a === 'edit') editHere(anchor, id, path, ctx);
    if (a === 'editor') import('./actions.js').then((m) => m.openInEditor(ctx.s, abs));
    if (a === 'revert') revertFile(anchor, id, f, ctx);
  };
  const close = popover(menu);
}

// --- reverting -------------------------------------------------------------------------------
// Instant (design/ux.md): the hunk or the file goes from the list at once, the server puts it back
// as the merge-base had it (POST /changes/revert, server/hunks.js), then Changes reloads. Refused
// (the agent works, or it moved since): it comes back with a red toast. Undo saves the text the
// file had just before (read first, so it's exact), if the file is still as the revert left it.

const BUSY = 'The agent is working on this task: wait for it, or stop it.';
// The file's text now, for Undo: null when it isn't there (a deleted file), undefined when it
// can't be read as text (binary, too big): then there's no Undo.
const textNow = (id, path) => api(`/sessions/${id}/source?path=${encodeURIComponent(path)}`).then((r) => r.text, (err) => (err.status === 404 ? null : undefined));

async function revertHunk(b, id, path, ctx) {
  if (live(S.sessions.get(id))) return void toastError(new Error(BUSY));
  const part = b.closest('tbody.cx-hunk');
  part?.classList.add('cx-going'); // its rows go at once
  try {
    const before = await textNow(id, path);
    const r = await api(`/sessions/${id}/changes/revert`, { method: 'POST', body: { path, hunk: Number(b.dataset.h), key: b.dataset.key } });
    reverted(id, ctx, before === undefined ? null : [{ path, text: before, hash: r.hash }]);
  } catch (err) {
    part?.classList.remove('cx-going');
    toastError(err);
    if (err.status === 409) ctx.reload(); // what it is now, as the message says
  }
}

async function revertFile(anchor, id, f, ctx) {
  if (live(S.sessions.get(id))) return void toastError(new Error(BUSY));
  const name = f.path.split('/').pop();
  const what = f.status === 'A' ? `${name} is new in this task, so reverting deletes it. Undo brings it back.` : f.status === 'D' ? `${name} comes back as it was before the task.` : `Every change this task made to ${name} goes.`;
  const base = data.get(id)?.base || 'the base';
  if (!(await ask(`Revert ${f.path} to ${base}?

${what} Undo puts it back.`, { ok: 'Revert file', danger: true, anchor }))) return;
  const node = [...document.querySelectorAll('.pn-changes .cx-file')].find((n) => n.dataset.path === f.path);
  const k = `${id}\n${f.path}`;
  going.add(k);
  if (node) node.hidden = true;
  try {
    // What Undo puts back: this file's text (and, for a rename, the old name not being there).
    const before = f.status === 'D' ? null : await textNow(id, f.path);
    const r = await api(`/sessions/${id}/changes/revert`, { method: 'POST', body: { path: f.path } });
    await reverted(id, ctx, before === undefined ? null : [{ path: f.path, text: before, hash: r.hash }, ...(f.from ? [{ path: f.from, text: null }] : [])]);
    going.delete(k);
    ctx.repaint(); // still listed (a rename's other half): shown again
  } catch (err) {
    going.delete(k);
    if (node) node.hidden = false;
    toastError(err);
    if (err.status === 409) ctx.reload();
  }
}

// Reverted: Changes reloads, and the toast's Undo puts each file back as it was (undo null: none).
function reverted(id, ctx, undo) {
  toast('Reverted', {
    action: undo && {
      label: 'Undo',
      run: async () => {
        try {
          for (const u of undo)
            // A file the revert left in place gets its text back through the editor's save (the
            // hash: as the revert left it); one it removed or brought back is restored.
            if (u.text != null && u.hash) await api(`/sessions/${id}/source`, { method: 'PUT', body: { path: u.path, text: u.text, hash: u.hash } });
            else await api(`/sessions/${id}/changes/revert`, { method: 'POST', body: { path: u.path, restore: u.text, ...(u.hash !== undefined && { hash: u.hash }) } });
        } catch (err) {
          toastError(err);
        }
        ctx.reload();
      },
    },
  });
  return ctx.reload();
}

// --- staging and committing ------------------------------------------------------------------
// Instant (design/ux.md): the toggle, the hunk's button and the count flip at once, the server
// stages (POST /changes/stage, server/stage.js), then Changes reloads with git's word on it.
// Refused (the agent works, or it moved since): it flips back with a red toast.

const snap = (f) => ({ staged: f.staged, unstaged: f.unstaged, hunkStage: f.hunkStage?.map((h) => ({ ...h })) });
const unsnap = (f, x) => Object.assign(f, x);
// Focus back on the same control after a repaint rebuilt its row.
function refocus(path, sel) {
  const node = [...document.querySelectorAll('.pn-changes .cx-file')].find((n) => n.dataset.path === path);
  $(sel, node || document.createElement('i'))?.focus();
}

async function stageFile(b, id, path, ctx) {
  if (live(S.sessions.get(id))) return void toastError(new Error(BUSY));
  const f = data.get(id)?.files?.find((x) => x.path === path);
  if (!f) return;
  const unstage = f.staged && !f.unstaged;
  const was = snap(f);
  const focused = document.activeElement === b;
  f.staged = !unstage;
  f.unstaged = unstage;
  f.hunkStage = f.hunkStage?.map((h) => (h.staged || h.unstaged ? { staged: !unstage, unstaged: unstage } : h));
  ctx.repaint();
  if (focused) refocus(path, '.cx-stage');
  try {
    await api(`/sessions/${id}/changes/stage`, { method: 'POST', body: { path, unstage } });
  } catch (err) {
    unsnap(f, was);
    ctx.repaint();
    toastError(err);
  }
  ctx.reload();
}

async function stageHunk(b, id, path, ctx) {
  if (live(S.sessions.get(id))) return void toastError(new Error(BUSY));
  const f = data.get(id)?.files?.find((x) => x.path === path);
  const i = Number(b.dataset.h);
  if (!f?.hunkStage?.[i]) return;
  const unstage = b.dataset.un === '1';
  const was = snap(f);
  f.hunkStage[i] = { staged: !unstage, unstaged: unstage };
  f.staged = f.hunkStage.some((h) => h.staged);
  f.unstaged = f.hunkStage.some((h) => h.unstaged);
  ctx.repaint();
  try {
    await api(`/sessions/${id}/changes/stage`, { method: 'POST', body: { path, hunk: i, key: b.dataset.key, unstage } });
  } catch (err) {
    unsnap(f, was);
    ctx.repaint();
    toastError(err);
  }
  ctx.reload();
}

async function commit(b, id, ctx) {
  const row = b.closest('.cx-commit');
  const input = $('.cx-cm-msg', row);
  if (live(S.sessions.get(id))) return void toastError(new Error(BUSY));
  const message = input.value.trim();
  if (!message) return void input.focus(); // the title comes in, selected: Enter commits it
  const d = data.get(id);
  const files = d?.files || [];
  const all = !files.some((f) => f.staged);
  const was = files.map(snap);
  // What goes in the commit leaves the staged state at once; the box clears.
  input.value = '';
  drafts.delete(id);
  for (const f of files) {
    if (!f.staged && !(all && f.unstaged)) continue;
    f.staged = false;
    if (all) f.unstaged = false;
    f.hunkStage = all ? undefined : f.hunkStage?.map((h) => ({ ...h, staged: false }));
  }
  ctx.repaint();
  try {
    const r = await api(`/sessions/${id}/changes/commit`, { method: 'POST', body: { message, all } });
    toast(`Committed ${r.sha}`);
  } catch (err) {
    if (data.get(id) === d) (files.forEach((f, k) => unsnap(f, was[k])), ctx.repaint());
    if (!input.value) ((input.value = message), drafts.set(id, message));
    toastError(err);
  }
  ctx.reload();
}
