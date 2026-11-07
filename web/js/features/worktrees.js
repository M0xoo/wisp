// Settings → Worktrees: how much room tasks' worktrees take, when they go, and removing or keeping
// one by hand. The rules are on the server (services/worktrees.js); this only shows them.
import { esc } from '../md.js';
import { api } from '../core/api.js';
import { $, $$, icon } from '../core/dom.js';
import { agoLong, fmtSize, timeAttrs } from '../core/format.js';
import { S } from '../core/state.js';
import { ask } from '../ui/confirm.js';
import { tryApi } from '../ui/toast.js';
import { reveal } from './feed.js';

const CHOICES = [['off', 'Never'], ['3', 'After 3 days'], ['7', 'After 7 days'], ['14', 'After 14 days'], ['30', 'After 30 days']];
const CLEANUP_DEFAULT = '7'; // server/services/worktrees.js
const MAX_CHOICES = [['off', 'No limit'], ['20', '20 worktrees'], ['40', '40 worktrees'], ['80', '80 worktrees']];
const MAX_DEFAULT = '40'; // server/services/worktrees.js
const PAGE = 50; // rows before Show all
const POLL_MS = 1500;
const FILTERS = [['all', 'All'], ['dirty', 'Uncommitted'], ['kept', 'Kept'], ['left', 'Left over']];
const LABEL = { busy: 'In use', kept: 'Kept', parked: 'For later', pr: 'Open PR', unreadable: 'Can’t read', checking: '' };
let last = null; // the last answer: the next open paints it first
let lastCount = 0; // placeholders before there's one

const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

// Keep worktree, from a task's menus and ⌘K as from the list here.
export async function setKeepWorktree(id, keep) {
  const s = S.sessions.get(id);
  if (s) s.keepWorktree = keep;
  const saved = await tryApi(() => api(`/sessions/${id}`, { method: 'PATCH', body: { keepWorktree: keep } }));
  if (!saved && s) s.keepWorktree = !keep;
  return !!saved;
}

const statusText = (x) => {
  if (x.status === 'dirty') return `${x.only} uncommitted`;
  if (x.status !== 'idle') return LABEL[x.status] ?? '';
  if (!x.cleanAt) return 'Idle';
  const days = Math.ceil((x.cleanAt - Date.now()) / 86_400_000);
  return days > 1 ? `Goes in ${days} days` : 'Goes next cleanup';
};

export function mountWorktrees(box) {
  let v = last;
  let filter = 'all';
  let all = false;
  let timer = null;
  const rows = new Map(); // key → { node, html }
  const gone = new Set(); // keys removed here, until the server's list agrees

  const setting = () => S.config.defaults.worktreeCleanup ?? CLEANUP_DEFAULT;
  const maxSetting = () => S.config.defaults.worktreeMax ?? MAX_DEFAULT;
  box.innerHTML = `
    <div class="sx-group wtr-sum">
      <div class="sx-row"><div class="sx-text"><b class="wtr-total"></b><small class="wtr-disk"></small></div><div class="sx-ctl"><button class="ghost sm" data-wt="all"></button></div></div>
      <div class="sx-row wtr-auto"><div class="sx-text"><b>Clean up automatically</b><small>Removes the folder of a task left idle this long. A task whose PR is merged or closed goes at the next cleanup, a Done task after a day, and any idle one sooner if the disk runs low. Its branch stays, and replying to the task brings the folder back. Uncommitted work, kept worktrees, For later and open PRs stay.</small></div>
        <div class="sx-ctl"><select id="wtrCleanup" aria-label="Clean up automatically">${CHOICES.map(([k, l]) => `<option value="${k}" ${setting() === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
      <div class="sx-row wtr-max"><div class="sx-text"><b>Keep at most</b><small>Past this many, the oldest idle worktrees go first, a few minutes after a new one. Ones in use, with uncommitted work, kept, For later or on an open PR stay, even over it.</small></div>
        <div class="sx-ctl"><select id="wtrMax" aria-label="Keep at most">${MAX_CHOICES.map(([k, l]) => `<option value="${k}" ${maxSetting() === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
    </div>
    <div class="sx-group wtr-list">
      <fieldset class="pk-seg wtr-filters" aria-label="Show"></fieldset>
      <div class="wtr-rows"></div>
      <button class="link wtr-more" data-wt="more" hidden></button>
    </div>`;
  const list = $('.wtr-rows', box);

  const entries = () => {
    if (!v) return [];
    const tasks = v.items.map((x) => ({ ...x, key: `t:${x.id}` }));
    const left = v.leftovers.map((x) => ({ ...x, key: `l:${x.name}`, left: true, title: x.name, status: x.only > 0 ? 'dirty' : 'left' }));
    return [...tasks, ...left].filter((x) => !gone.has(x.key));
  };
  const matches = (x) => (filter === 'all' ? true : filter === 'left' ? x.left : filter === 'kept' ? x.status === 'kept' : x.status === 'dirty');
  const rowHtml = (x) => {
    const meta = [esc(x.left ? 'No task' : x.project), esc(x.branch || ''), x.usedAt ? `<time ${timeAttrs(x.usedAt)}>${esc(agoLong(x.usedAt))}</time>` : ''].filter(Boolean);
    const name = x.left ? `<b class="mono" title="${esc(x.title)}">${esc(x.title)}</b>` : `<button class="link wtr-name" data-wt="open" title="${esc(x.title)}">${esc(x.title)}</button>`;
    const kept = x.status === 'kept';
    return `<span class="wtr-who">${name}<small>${meta.join(' · ')}</small></span>
      <small class="wtr-state${x.status === 'dirty' ? ' warn' : ''}">${esc(x.left ? (x.status === 'dirty' ? `${x.only} uncommitted` : '') : statusText(x))}</small>
      <small class="wtr-size">${x.size === null ? '' : fmtSize(x.size)}</small>
      <span class="wtr-acts">${x.left ? '' : `<button class="ghost xs icon-btn" data-wt="keep" aria-pressed="${kept}" title="${kept ? 'Stop keeping worktree' : 'Keep worktree'}" aria-label="${kept ? 'Stop keeping worktree' : 'Keep worktree'}" ${x.status === 'busy' ? 'disabled' : ''}>${icon('pin')}</button>`}<button class="ghost xs danger" data-wt="remove" ${x.status === 'busy' || x.status === 'checking' ? 'disabled' : ''}>Remove</button></span>`;
  };
  const fillRows = (shown) => {
    const keys = new Set(shown.map((x) => x.key));
    for (const [key, r] of rows) {
      if (!keys.has(key)) {
        r.node.remove();
        rows.delete(key);
      }
    }
    for (const n of $$('.wtr-wait', list)) n.remove();
    let at = null;
    for (const x of shown) {
      const html = rowHtml(x);
      let r = rows.get(x.key);
      if (!r) {
        const node = Object.assign(document.createElement('div'), { className: 'wtr-row' });
        node.dataset.key = x.key;
        r = { node, html: null };
        rows.set(x.key, r);
      }
      if (r.html !== html) {
        r.node.innerHTML = html;
        r.html = html;
      }
      // Only what's out of place moves: a row put back replays nothing and keeps focus.
      if ((at ? at.nextElementSibling : list.firstElementChild) !== r.node) (at ? at.after(r.node) : list.prepend(r.node));
      at = r.node;
    }
  };
  const placeholders = () => {
    const one = '<div class="wtr-row wtr-wait" aria-hidden="true"><span class="wtr-who"><span class="rec-sk wtr-sk1"></span><span class="rec-sk wtr-sk2"></span></span><span class="rec-sk wtr-sk3"></span><span class="rec-sk wtr-sk3"></span><span class="rec-sk wtr-sk4"></span></div>';
    return one.repeat(Math.min(8, Math.max(4, lastCount)));
  };

  const paint = () => {
    if (!box.isConnected) return;
    const list0 = entries();
    const total = $('.wtr-total', box);
    const disk = $('.wtr-disk', box);
    const btn = $('[data-wt="all"]', box);
    const size = list0.reduce((n, x) => n + (x.size || 0), 0);
    const ready = v ? v.items.filter((x) => !gone.has(`t:${x.id}`) && x.status === 'idle' && Date.now() - x.usedAt >= 86_400_000).length : 0;
    if (!v) {
      total.innerHTML = '<span class="rec-sk wtr-sk2"></span>';
      disk.innerHTML = '<span class="rec-sk wtr-sk1"></span>';
    } else {
      total.textContent = `${plural(list0.length, 'worktree')}${v.size === null ? '' : ` · ${fmtSize(size)}`}`;
      const free = v.disk ? `${fmtSize(v.disk.free)} free on this disk` : '';
      const lastRun = v.last ? `Last cleanup ${agoLong(v.last.at)}: ${plural(v.last.count, 'worktree')}${v.last.freed ? `, ${fmtSize(v.last.freed)}` : ''}` : '';
      disk.textContent = v.cleaning ? `Cleaning up: ${v.cleaning.done} of ${v.cleaning.total}` : [free, lastRun].filter(Boolean).join(' · ');
    }
    btn.textContent = ready ? `Clean up ${ready}` : 'Clean up';
    btn.disabled = !ready || !!v?.cleaning;
    btn.title = ready ? 'Removes every worktree that’s been idle for a day or more and holds nothing of its own' : 'Nothing idle to clean up';
    const seg = $('.wtr-filters', box);
    const segHtml = FILTERS.map(([k, l]) => `<button type="button" class="${filter === k ? 'on' : ''}" data-filter="${k}" aria-pressed="${filter === k}">${l}${v ? ` ${list0.filter((x) => (k === 'all' ? true : k === 'left' ? x.left : k === 'kept' ? x.status === 'kept' : x.status === 'dirty')).length}` : ''}</button>`).join('');
    if (seg.dataset.html !== segHtml) (seg.innerHTML = segHtml), (seg.dataset.html = segHtml);
    const more = $('.wtr-more', box);
    if (!v) {
      if (!$('.wtr-wait', list)) list.innerHTML = placeholders();
      more.hidden = true;
      return;
    }
    const match = list0.filter(matches).sort((a, b) => (b.size || 0) - (a.size || 0) || a.usedAt - b.usedAt);
    fillRows(all ? match : match.slice(0, PAGE));
    $('.wtr-empty', list)?.remove();
    if (!match.length) list.insertAdjacentHTML('beforeend', `<p class="wtr-empty">${v.looking ? 'Looking…' : filter === 'all' ? 'No worktrees on disk.' : 'None here.'}</p>`);
    more.hidden = all || match.length <= PAGE;
    more.textContent = `Show all ${match.length}`;
    lastCount = match.length;
  };

  async function refresh() {
    clearTimeout(timer);
    let next = null;
    try {
      next = await api('/worktrees');
    } catch {}
    if (!box.isConnected) return;
    if (next) {
      v = last = next;
      const live = new Set([...next.items.map((x) => `t:${x.id}`), ...next.leftovers.map((x) => `l:${x.name}`)]);
      for (const key of gone) if (!live.has(key)) gone.delete(key);
      paint();
    }
    // Sizes and what each folder holds come from a scan of them all; it answers in its own time.
    if (!next || next.looking || next.cleaning) timer = setTimeout(() => !box.closest('[hidden]') && refresh(), POLL_MS);
  }

  // Goes at once; back with a toast if the server refuses.
  const clean = async (keys, body) => {
    for (const k of keys) gone.add(k);
    paint();
    const ok = await tryApi(() => api('/worktrees/clean', { method: 'POST', body }));
    if (!ok) for (const k of keys) gone.delete(k);
    paint();
    refresh();
  };

  box.addEventListener('click', async (e) => {
    const f = e.target.closest('[data-filter]');
    if (f) {
      filter = f.dataset.filter;
      paint();
      return;
    }
    const b = e.target.closest('[data-wt]');
    if (!b) return;
    const a = b.dataset.wt;
    if (a === 'more') {
      all = true;
      paint();
      return;
    }
    if (a === 'all') {
      const ready = v.items.filter((x) => x.status === 'idle' && Date.now() - x.usedAt >= 86_400_000);
      if (!(await ask(`Remove ${plural(ready.length, 'worktree')}?\n\nBranches stay, and replying to a task brings its folder back. Folders git ignores, like node_modules, go with them and setup doesn’t run again.`, { ok: 'Clean up', anchor: b }))) return;
      clean(ready.map((x) => `t:${x.id}`), {});
      return;
    }
    const key = b.closest('.wtr-row')?.dataset.key;
    const x = entries().find((y) => y.key === key);
    if (!x) return;
    if (a === 'open') reveal(x.id);
    if (a === 'keep') {
      const keep = x.status !== 'kept';
      const was = x.status;
      const item = v.items.find((y) => y.id === x.id);
      item.status = keep ? 'kept' : 'checking';
      paint();
      if (!(await setKeepWorktree(x.id, keep))) item.status = was;
      paint();
      refresh();
    }
    if (a === 'remove') {
      if (x.left) {
        if (!(await ask(`Remove ${x.title}?\n\nNo task uses this folder, so nothing brings it back${x.only ? `, and its ${plural(x.only, 'uncommitted change')} go with it` : ''}.`, { ok: 'Remove', danger: true, anchor: b }))) return;
        clean([key], { leftovers: [x.title] });
        return;
      }
      if (x.status === 'dirty' || x.status === 'unreadable') {
        const what = x.status === 'dirty' ? `Its ${plural(x.only, 'uncommitted change')} can’t be brought back.` : 'wisp can’t read what it holds, and anything uncommitted can’t be brought back.';
        if (!(await ask(`Remove this worktree?\n\n${what}`, { ok: 'Remove', danger: true, anchor: b }))) return;
        clean([key], { ids: [x.id], force: true });
        return;
      }
      clean([key], { ids: [x.id] });
    }
  });
  const sel = $('#wtrCleanup', box); // no name: Settings' own change handler would send it too
  sel.onchange = async () => {
    const was = setting();
    S.config.defaults.worktreeCleanup = sel.value;
    const saved = await tryApi(() => api('/config', { method: 'PATCH', body: { defaults: { worktreeCleanup: sel.value } } }));
    if (!saved) {
      S.config.defaults.worktreeCleanup = was;
      sel.value = was;
    }
    refresh();
  };
  const maxSel = $('#wtrMax', box);
  maxSel.onchange = async () => {
    const was = maxSetting();
    S.config.defaults.worktreeMax = maxSel.value;
    const saved = await tryApi(() => api('/config', { method: 'PATCH', body: { defaults: { worktreeMax: maxSel.value } } }));
    if (!saved) {
      S.config.defaults.worktreeMax = was;
      maxSel.value = was;
    }
    refresh();
  };
  paint();
  return refresh;
}
