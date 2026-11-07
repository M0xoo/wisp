// Done asks about the worktree (design/worktrees-on-done.md). After Mark done in the page, the
// folders the task and what ran under it hold on disk: Remove takes the ticked ones (clean ones
// ticked, one with uncommitted work only when you tick it), Keep pins them all (keepWorktree).
// defaults.worktreeOnDone ('ask' | 'remove' | 'keep') skips the question; even 'remove' asks
// before a folder with work only it holds goes. The server decides what's safe (services/done-folders.js).
import { esc } from '../md.js';
import { api } from '../core/api.js';
import { $, $$, el, icon } from '../core/dom.js';
import { fmtSize } from '../core/format.js';
import { S } from '../core/state.js';
import { overlay } from '../ui/overlay.js';
import { toast, toastError } from '../ui/toast.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const onDoneSetting = () => S.config?.defaults?.worktreeOnDone || 'ask';
const lockedBy = () => S.config?.lockedBy?.worktreeOnDone || null; // set by a spell: no Always do this

// What only the folder holds: lost with it. null: git couldn't tell, so it's treated as dirty.
const dirty = (f) => f.only !== 0;

// The state column: what the user weighs before removing it.
export function stateText(f) {
  if (f.only === null) return { text: 'Can’t read it', warn: true };
  if (f.only > 0) return { text: f.uncommitted > 0 ? `${plural(f.uncommitted, 'uncommitted file')}` : 'Commits off its branch', warn: true };
  if (f.pr?.state === 'OPEN') return { text: `PR #${f.pr.number} open` };
  if (f.pr?.state === 'MERGED') return { text: `PR #${f.pr.number} merged` };
  if (f.unpushed > 0) return { text: `${plural(f.unpushed, 'commit')} not pushed` };
  return { text: 'Clean' };
}

// A task (or a compare's runs) just marked done from the page; saved: the Done on its way to the
// server (the list waits for it: compare runs count once they're done). Resolves once it's settled.
export async function askAboutFolders(ids, { saved = Promise.resolve(), setting = onDoneSetting() } = {}) {
  const id = ids[0];
  if (!id) return;
  // The dialog opens on the click when the task has a folder of its own, in its final shape;
  // a task without one asks only if something under it turns out to hold one.
  const own = ids.some((x) => {
    const s = S.sessions.get(x);
    return s && !s.foreign && (s.branch || s.also?.some((a) => a.branch));
  });
  const dlg = setting === 'ask' && own ? folderDialog(id) : null;
  let list;
  try {
    await saved;
    list = await api(`/sessions/${id}/folders?sizes=0`);
  } catch {
    dlg?.close(); // Done refused (its toast says so), or no list: the hourly cleanup still looks at it
    return;
  }
  const folders = list.folders || [];
  if (!folders.length) return void dlg?.close();
  if (setting === 'keep') return void answer(id, { keep: folders.map((f) => f.path) }, folders);
  if (setting === 'remove') {
    const clean = folders.filter((f) => !dirty(f));
    if (clean.length) answer(id, { remove: clean.map((f) => f.path) }, folders);
    const left = folders.filter(dirty);
    if (left.length) folderDialog(id, left);
    return;
  }
  (dlg || folderDialog(id)).fill(folders);
}

// The user's answer, sent in the background: the dialog is gone already. A folder that can't go is
// kept (the server pins it) and the toast says why.
async function answer(id, body, folders, { quiet = false } = {}) {
  const pinned = new Set(body.keep || []);
  for (const f of folders) if (pinned.has(f.path)) markKept(f.task, true);
  try {
    const out = await api(`/sessions/${id}/folders`, { method: 'POST', body });
    for (const x of out.failed || []) markKept(folders.find((f) => f.path === x.path)?.task, true);
    if (out.failed?.length) {
      const one = out.failed[0];
      toastError(new Error(out.failed.length === 1 ? `Kept ${nameOf(folders, one.path)}: ${one.error}` : `Kept ${out.failed.length} folders that couldn’t be removed. ${one.error}`));
    } else if (out.removed?.length && !quiet) {
      const bytes = folders.filter((f) => out.removed.includes(f.path)).reduce((n, f) => n + (f.size || 0), 0);
      toast(`Removed ${plural(out.removed.length, 'folder')}${bytes ? ` · ${fmtSize(bytes)}` : ''}`);
    }
  } catch (err) {
    for (const f of folders) if (pinned.has(f.path)) markKept(f.task, false);
    toastError(err);
  }
}

const nameOf = (folders, p) => {
  const f = folders.find((x) => x.path === p);
  return f ? `“${f.title || f.branch}”` : 'a folder';
};
function markKept(task, keep) {
  const s = task && S.sessions.get(task);
  if (s) s.keepWorktree = keep;
}

// The dialog. Opened before the list is in: placeholder rows, then fill(folders).
// only: a subset to ask about (Settings says remove; these hold work).
function folderDialog(id, only = null) {
  const lock = lockedBy() || !!only; // only: the setting is Remove already
  const node = el(`
    <div class="modal wd-modal" role="dialog" aria-modal="true" aria-labelledby="wdTitle">
      <header><h2 id="wdTitle">Remove its worktrees?</h2><button class="icon-btn close" title="Close" aria-label="Close">${icon('x')}</button></header>
      <p class="hint wd-hint">Their branches stay, and a follow-up brings a folder back.</p>
      <div class="wd-rows">${'<div class="wd-row wd-wait" aria-hidden="true"><span class="rec-sk wd-sk1"></span><span class="wd-who"><span class="rec-sk wd-sk2"></span><span class="rec-sk wd-sk3"></span></span><span class="rec-sk wd-sk4"></span><span class="rec-sk wd-sk5"></span></div>'.repeat(only?.length || 1)}</div>
      <footer class="wd-foot">
        <label class="check wd-always" ${lock ? 'hidden' : ''}><input type="checkbox" name="always"> Always do this</label>
        <span class="grow"></span>
        <button type="button" class="ghost sm" data-a="keep">Keep</button>
        <button type="button" class="primary sm" data-a="remove" disabled>Remove</button>
      </footer>
    </div>`);
  const close = overlay(node);
  $('.close', node).onclick = () => {
    close();
  };
  let folders = [];
  const rows = $('.wd-rows', node);
  const removeBtn = $('[data-a="remove"]', node);
  const ticked = () => $$('input[data-path]', rows).filter((x) => x.checked).map((x) => x.dataset.path);
  const paintBtn = () => {
    const n = ticked().length;
    removeBtn.disabled = !n;
    const lost = folders.filter((f) => dirty(f) && ticked().includes(f.path)).length;
    removeBtn.classList.toggle('bad', !!lost);
    removeBtn.textContent = n > 1 ? `Remove ${n}` : 'Remove';
  };
  const rowHtml = (f) => {
    const st = stateText(f);
    const loses = !dirty(f) ? '' : f.only === null ? 'Git can’t read it: what’s in it may be lost' : f.uncommitted > 0 ? `${plural(f.uncommitted, 'uncommitted file')} will be lost` : 'Its commits off the branch will be lost';
    const who = f.own ? 'This task' : f.title || f.branch;
    return `<label class="wd-row${dirty(f) ? ' wd-dirty' : ''}">
      <input type="checkbox" data-path="${esc(f.path)}" ${dirty(f) ? '' : 'checked'} aria-label="Remove ${esc(who)}">
      <span class="wd-who"><b title="${esc(f.title)}">${esc(who)}</b><small><span class="wd-branch">${esc(f.branch || f.path)}</span>${loses ? `<span class="wd-loses">${esc(loses)}</span>` : ''}</small></span>
      <small class="wd-state${st.warn ? ' warn' : ''}">${esc(st.text)}</small>
      <small class="wd-size" data-size="${esc(f.path)}">${f.size === null || f.size === undefined ? '<span class="rec-sk wd-sk5"></span>' : fmtSize(f.size)}</small>
    </label>`;
  };
  const fill = (list) => {
    if (!node.isConnected) return;
    folders = only || list;
    const dirtyCount = folders.filter(dirty).length;
    $('#wdTitle', node).textContent = only ? (folders.length === 1 ? 'This worktree holds work' : 'These worktrees hold work') : folders.length === 1 ? 'Remove its worktree?' : `Remove its ${folders.length} worktrees?`;
    $('.wd-hint', node).textContent = only
      ? 'The clean ones are gone. Tick one to remove it anyway, and what it holds goes with it.'
      : `Their branches stay, and a follow-up brings a folder back.${dirtyCount ? ` ${dirtyCount === 1 ? 'The one' : 'Ones'} holding work ${dirtyCount === 1 ? 'goes' : 'go'} only if you tick ${dirtyCount === 1 ? 'it' : 'them'}.` : ''}`;
    rows.innerHTML = folders.map(rowHtml).join('');
    paintBtn();
    if (!matchMedia('(pointer: coarse)').matches) removeBtn.focus(); // a keyboard's Enter; no ring on a touch screen
    // Sizes come after: du over a big node_modules takes seconds.
    api(`/sessions/${id}/folders`).then((full) => {
      if (!node.isConnected) return;
      for (const f of full.folders || []) {
        const at = folders.find((x) => x.path === f.path);
        if (at) at.size = f.size;
        const cell = $$('[data-size]', rows).find((c) => c.dataset.size === f.path);
        if (cell) cell.textContent = f.size === null ? '' : fmtSize(f.size);
      }
    }, () => {
      for (const c of $$('[data-size]', rows)) if (c.querySelector('.rec-sk')) c.textContent = '';
    });
  };
  rows.onchange = () => {
    paintBtn();
  };
  const remember = (value) => {
    if (!$('[name="always"]', node).checked || lock) return;
    const was = S.config.defaults.worktreeOnDone;
    S.config.defaults.worktreeOnDone = value;
    api('/config', { method: 'PATCH', body: { defaults: { worktreeOnDone: value } } }).catch((err) => {
      S.config.defaults.worktreeOnDone = was;
      toastError(err);
    });
  };
  node.onclick = (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a || !folders.length) return;
    if (a === 'remove') {
      const remove = ticked();
      if (!remove.length) return;
      remember('remove');
      close();
      answer(id, { remove, force: remove.filter((p) => dirty(folders.find((f) => f.path === p))) }, folders);
    } else if (a === 'keep') {
      remember('keep');
      close();
      answer(id, { keep: folders.map((f) => f.path) }, folders, { quiet: true });
    }
  };
  if (only) fill(only);
  return { close, fill };
}
