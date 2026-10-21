// What you can do to a session: done, archive, delete, rename, rerun, revert, take over, open files,
// and the menus that offer it. Local changes apply at once and roll back if the server refuses.

import { copy } from '../blocks.js';
import { esc } from '../md.js';
import { api } from '../core/api.js';
import { $, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { keyHint } from '../ui/kbd.js';
import { overlay } from '../ui/overlay.js';
import { clampToViewport, popover } from '../ui/popover.js';
import { toast, toastError, tryApi } from '../ui/toast.js';
import { autosize } from './attachments.js';
import { saveAsRecipe } from './automations.js';
import { compareView } from './compare.js';
import { collapse, expand, handOff, renderFeed, setFocus } from './feed.js';
import { launchBehind } from './launcher.js';
import { copyTaskId, mentionBox } from './mentions.js';
import { runnerPicker } from './runner-picker.js';
import { connectMachine } from './machines.js';
import { placeMenu } from './place-menu.js';
import { machineById, pathAt, placeName, projectById } from './places.js';
import { agentById, agentName, DEFAULT_MODE, effortsFor, harnessesAt, modeMenu, MODES, paintRunnerBtn, savedEffort, savedModel } from './runners.js';
import { feedAnchor, keepInPlace } from './scroll.js';
import { mergePr, shipDialog, shipLabel, shippable } from './ship.js';
import { slotHtml } from './spells.js';

export async function toggleDone(id) {
  const s = S.sessions.get(id);
  if (!s) return;
  if (s.state === 'running' || s.state === 'waiting') return toast('Still working — stop it first or let it finish.');
  const next = s.state === 'done' ? 'review' : 'done';
  // Optimistic: the card moves now; a failed save puts it back.
  move(id, { ...s, state: next }, next === 'done');
  if (next === 'done') toast(`Marked done`, { action: { label: 'Undo', run: () => toggleDone(id) } });
  try {
    await api(`/sessions/${id}`, { method: 'PATCH', body: { state: next } });
  } catch (err) {
    revertSummary(id, s);
    toastError(err);
  }
}

// Apply a summary change locally before the server confirms it. Leaving the list (done, archived)
// hands focus to the next card; coming back just re-renders around the reader.
function move(id, next, leaving) {
  if (leaving) return handOff(id)(() => S.sessions.set(id, next));
  S.sessions.set(id, next);
  keepInPlace(feedAnchor(id), renderFeed);
}

// Put back a summary changed optimistically, unless a live update has replaced it since.
function revertSummary(id, prev) {
  const cur = S.sessions.get(id);
  if (cur && cur.updatedAt > prev.updatedAt) return;
  S.sessions.set(id, prev);
  keepInPlace(feedAnchor(id), renderFeed);
}

// Every finished run of a compare task at once, with one toast to undo them all.
export async function taskDone(ids) {
  if (!ids.length) return;
  const card = S.nodes.get(ids[0])?.card.closest('.task-item');
  const next = card?.nextElementSibling?.querySelector('.item')?.dataset.id || card?.nextElementSibling?.dataset.id;
  const set = (state) => {
    const prev = ids.map((id) => S.sessions.get(id));
    for (const id of ids) S.sessions.set(id, { ...S.sessions.get(id), state });
    renderFeed();
    Promise.all(ids.map((id) => api(`/sessions/${id}`, { method: 'PATCH', body: { state } }))).catch((err) => {
      prev.forEach((p, i) => p && revertSummary(ids[i], p));
      toastError(err);
    });
  };
  set('done');
  if (next && S.nodes.has(next)) setFocus(next);
  toast(`Marked ${ids.length} runs done`, { action: { label: 'Undo', run: () => set('review') } });
}

export function revertFile(id, turnId, file, restore = false) {
  return tryApi(async () => {
    await api(`/sessions/${id}/revert`, { method: 'POST', body: { turnId, file, restore } });
    toast(restore ? `Re-applied ${esc(file)}` : `Reverted ${esc(file)}`, {
      action: { label: 'Undo', run: () => revertFile(id, turnId, file, !restore) },
    });
  });
}

export async function rollbackTurn(id, turnId, restore = false) {
  const s = S.full.get(id) || (await api(`/sessions/${id}`).catch(() => null));
  const turn = s?.turns?.find((t) => t.id === turnId) || s?.turns?.at(-1);
  if (!turn) return;
  await tryApi(async () => {
    const r = await api(`/sessions/${id}/rollback`, { method: 'POST', body: { turnId: turn.id, restore } });
    toast(
      restore
        ? `Re-applied turn changes`
        : `Restored working tree to before this turn${r.head ? ` (${esc(r.head.slice(0, 7))})` : ''}`,
      { action: { label: 'Undo', run: () => rollbackTurn(id, turn.id, !restore) } },
    );
  });
}

// The server keeps the result on the turn under `key` (turn.actionRuns), where the block that
// ran it looks for it when the card renders again.
export async function execAction(id, turnId, command, key) {
  return (await tryApi(() => api(`/sessions/${id}/exec`, { method: 'POST', body: { command, turnId, key } }))) ?? null;
}

export async function takeOver(id) {
  const s = S.full.get(id) || (await api(`/sessions/${id}`).catch(() => null));
  if (!s?.agentSessionId) return;
  if (s.state === 'running' && !confirm(`${agentName(s.agent)} is still running. Stop it and take over in your terminal?`)) return;
  await tryApi(async () => {
    const { command } = await api(`/sessions/${id}/takeover`, { method: 'POST', body: {} });
    toast(`${icon('terminal')} Opened in your terminal`, { action: { label: 'Copy command', run: () => copy(command) } });
  });
}

export function rename(id) {
  const n = S.nodes.get(id);
  // Split view: the open task is renamed in its header, the others in their sidebar row.
  const title = $(`#splitHead:not([hidden])[data-id="${id}"] .sh-title`) || (n && $('.it-title', n.head));
  if (!title) return;
  title.contentEditable = 'true';
  title.focus();
  document.getSelection().selectAllChildren(title);
  const done = (commit) => {
    title.contentEditable = 'false';
    const s = S.sessions.get(id);
    const t = title.textContent.trim();
    if (commit && t && t !== s.title) api(`/sessions/${id}`, { method: 'PATCH', body: { title: t } }).catch((e) => toastError(e));
    else title.textContent = s.title;
  };
  title.onkeydown = (e) => {
    if (e.key === 'Enter') (e.preventDefault(), title.blur());
    if (e.key === 'Escape') ((title.textContent = S.sessions.get(id).title), title.blur());
  };
  title.onclick = (e) => e.stopPropagation();
  title.onblur = () => done(true);
}

export function moreMenu(id, anchor) {
  const s = S.full.get(id);
  if (!s) return;
  const lastTurn = s.turns?.at(-1);
  const canRollback = s.agent !== 'wisp' && s.state !== 'running' && (lastTurn?.changes?.length || lastTurn?.checkpoint?.commit);
  const rolledBack = !!lastTurn?.rolledBackAt;
  const r = anchor.getBoundingClientRect();
  const menu = el(`
    <div class="menu" style="top:${r.bottom + 6}px;right:${innerWidth - r.right}px">
      <button data-a="rename">${icon('pen')}Rename${keyHint('M')}</button>
      <button data-a="copy-id">${icon('copy')}Copy task ID</button>
      ${s.agentSessionId ? `<button data-a="copy">${icon('copy')}Copy resume command</button>` : ''}
      <button data-a="folder">${icon('folder')}Open project in editor</button>
      ${canRollback ? `<button data-a="rollback">${icon(rolledBack ? 'rerun' : 'replay')}${rolledBack ? 'Re-apply latest turn' : 'Restore to before latest turn'}</button>` : ''}
      ${s.archived ? `<button data-a="unarchive">${icon('archive')}Unarchive${keyHint('A')}</button>` : s.state !== 'running' && s.state !== 'waiting' ? `<button data-a="archive">${icon('archive')}Archive${keyHint('A')}</button>` : ''}
      <button data-a="delete" class="danger">${icon('trash')}Delete session${keyHint('⌫')}</button>
    </div>`);
  menu.onclick = async (e) => {
    const a = e.target.closest('button')?.dataset.a;
    close();
    if (a === 'rename') rename(id);
    if (a === 'copy-id') copyTaskId(id);
    if (a === 'copy') {
      await tryApi(async () => {
        const { command } = await api(`/sessions/${id}/takeover`);
        copy(command);
        toast('Copied resume command');
      });
    }
    if (a === 'folder') openInEditor(s, '.');
    if (a === 'rollback') rollbackTurn(id, lastTurn?.id, rolledBack);
    if (a === 'archive' || a === 'unarchive') setArchived(id, a === 'archive');
    if (a === 'delete') deleteSession(id);
  };
  const close = popover(menu);
}

// Right-click on a feed item.
export function taskMenu(id, e) {
  const s = S.sessions.get(id);
  if (!s) return;
  $('.menu.task')?.close();
  const busy = s.state === 'running' || s.state === 'waiting';
  const menu = el(`
    <div class="menu task" style="top:${e.clientY}px;left:${e.clientX}px">
      ${S.open.has(id) ? `<button data-a="collapse">${icon('chevron')}Collapse${keyHint('O')}</button>` : `<button data-a="open">${icon('chevron')}Open${keyHint('O')}</button>`}
      <button data-a="rename">${icon('pen')}Rename${keyHint('M')}</button>
      <button data-a="copy-id">${icon('copy')}Copy task ID</button>
      <button data-a="rerun">${icon('rerun')}Rerun…${keyHint('⇧R')}</button>
      ${shippable(s) ? `<button data-a="ship">${icon('send')}${shipLabel(s)}${keyHint('S')}</button>` : ''}
      ${s.pr?.state === 'OPEN' ? `<button data-a="merge">${icon('check')}Merge PR #${s.pr.number}…</button>` : ''}
      ${s.groupId ? `<button data-a="compare"><b class="vs-mark">vs</b>Compare runs</button>` : ''}
      <button data-a="recipe">${icon('spark')}Save as recipe…</button>
      ${busy || s.archived ? '' : `<button data-a="done">${icon('done')}${s.state === 'done' ? 'Reopen' : 'Mark done'}${keyHint('E')}</button>`}
      ${s.archived ? `<button data-a="unarchive">${icon('archive')}Unarchive${keyHint('A')}</button>` : busy ? '' : `<button data-a="archive">${icon('archive')}Archive${keyHint('A')}</button>`}
      ${slotHtml('card.menu', s).replace(/class="ghost sm sp-btn"/g, 'class="sp-menu"').replace(/<button /g, `<button data-task="${s.id}" `)}
      <button data-a="delete" class="danger">${icon('trash')}Delete session${keyHint('⌫')}</button>
    </div>`);
  menu.onclick = async (ev) => {
    if (ev.target.closest('[data-sp]')) return close();
    const a = ev.target.closest('button')?.dataset.a;
    close();
    if (a === 'open') expand(id);
    if (a === 'collapse') collapse(id);
    if (a === 'rename') rename(id);
    if (a === 'copy-id') copyTaskId(id);
    if (a === 'rerun') rerun(id);
    if (a === 'ship') shipDialog(id);
    if (a === 'merge') mergePr(id);
    if (a === 'compare') compareView(id);
    if (a === 'recipe') saveAsRecipe(id);
    if (a === 'done') toggleDone(id);
    if (a === 'archive' || a === 'unarchive') setArchived(id, a === 'archive');
    if (a === 'delete') deleteSession(id);
  };
  const close = popover(menu);
  clampToViewport(menu, e.clientX, e.clientY);
}

export async function deleteSession(id) {
  if (!confirm('Delete this session from wisp? (The agent’s own history is kept.)')) return;
  const prev = S.sessions.get(id);
  handOff(id)(() => S.sessions.delete(id));
  await api(`/sessions/${id}`, { method: 'DELETE' }).catch((err) => {
    if (prev && !S.sessions.has(id)) (S.sessions.set(id, prev), keepInPlace(feedAnchor(id), renderFeed));
    toastError(err);
  });
}

// Launch the task again as a new session in the same project: same prompt and attachments,
// optionally edited, on whichever computer, harness, model and thinking level you pick. The
// original stays. Another computer runs it in its own checkout (cloned there if need be).
export async function rerun(id) {
  const s = S.full.get(id) || (await api(`/sessions/${id}`).catch(toastError));
  const first = s?.turns?.[0];
  if (!first?.prompt) return toast('Nothing to rerun — this session has no prompt.', { tone: 'bad' });
  let place = s.machine?.id || '';
  const here = () => harnessesAt([place]).filter((x) => x.available);
  const has = (a) => here().some((x) => x.id === a);
  let agent = has(s.agent) ? s.agent : here()[0]?.id || s.agent;
  const models = agentById(agent)?.models || [];
  let model = agent === s.agent && models.some((m) => m.id === s.model) ? s.model : savedModel(agent);
  let effort = agent === s.agent && effortsFor(agent, model).includes(s.effort) ? s.effort : savedEffort(agent, model);
  let mode = MODES.some((m) => m.id === s.mode) ? s.mode : S.config.defaults.mode || DEFAULT_MODE.id;
  const files = first.attachments || [];

  const node = el(`
    <div class="modal rerun-modal">
      <header><h2>Rerun task</h2><button class="icon-btn close">${icon('x')}</button></header>
      <div class="rr-box">
        <textarea class="rr-prompt" rows="3" spellcheck="false"></textarea>
        ${files.length ? `<div class="rr-files">${files.map((f) => `<span class="rr-file">${icon('clip')}${esc(f.name)}</span>`).join('')}</div>` : ''}
        <div class="l-bar">
          <button class="tog-btn where-btn" data-a="place" aria-haspopup="menu" ${S.machines.length ? '' : 'hidden'}></button>
          <button class="mode-btn" data-a="mode" aria-haspopup="menu"></button>
          <button class="runner-btn" data-a="runner" title="Harness, model and thinking level" aria-haspopup="dialog"></button>
          <span class="grow"></span>
          <button class="primary sm" data-a="go">${icon('rerun')}Rerun</button>
        </div>
      </div>
      <p class="hint rr-hint"></p>
    </div>`);
  const close = overlay(node);
  $('.close', node).onclick = close;
  const ta = mentionBox($('.rr-prompt', node));
  ta.value = first.prompt;
  autosize(ta);
  const modeBtn = $('[data-a="mode"]', node);
  const paintMode = () => {
    const m = MODES.find((x) => x.id === mode) || DEFAULT_MODE;
    modeBtn.className = `mode-btn m-${m.id}`;
    modeBtn.innerHTML = `${icon(m.icon)}<span>${m.label}</span>`;
    modeBtn.title = m.hint;
  };
  const runnerBtn = $('[data-a="runner"]', node);
  const paintRunner = () => paintRunnerBtn(runnerBtn, agent, model, effort);
  // Where it runs: where it ran, unless you pick another computer.
  const placeBtn = $('[data-a="place"]', node);
  const project = projectById(S.sessions.get(id)?.projectId);
  const paintPlace = () => {
    placeBtn.classList.toggle('on', !!place);
    placeBtn.innerHTML = `${icon(place ? 'server' : 'laptop')}<span>${esc(placeName(place))}</span>${icon('chevron', 'chev')}`;
    placeBtn.title = 'Run it on another computer';
    const fresh = project && !pathAt(project, place);
    $('.rr-hint', node).innerHTML = `Starts a new session in <code>${esc(project && !fresh ? pathAt(project, place) : s.cwd)}</code>${S.machines.length ? ` on <b>${esc(placeName(place))}</b>` : ''}${fresh ? `, in a checkout wisp clones there first` : ''}. “${esc(s.title)}” is kept as it is.`;
  };
  paintMode();
  paintRunner();
  paintPlace();
  placeBtn.onclick = () =>
    placeMenu(placeBtn, { title: 'Rerun on', current: place, from: s.machine?.id || '' }, (k) => {
      place = k;
      if (k && machineById(k)?.state === 'off') connectMachine(k);
      // The harness has to be there too: keep it if it is, else the first one that is.
      if (!has(agent) && here().length) {
        agent = here()[0].id;
        model = savedModel(agent);
        effort = savedEffort(agent, model);
        paintRunner();
      }
      paintPlace();
      ta.focus();
    });
  modeBtn.onclick = () => modeMenu(modeBtn, mode, (m) => ((mode = m), paintMode(), ta.focus()));
  // Picks here only apply to this rerun; the launcher's remembered defaults are left alone.
  runnerBtn.onclick = () =>
    runnerPicker(runnerBtn, { agent, model, effort, savedModel, savedEffort, places: [place], auto: true }, (a, m, e) => {
      [agent, model, effort] = [a, m, e];
      paintRunner();
    });

  const go = async () => {
    const prompt = ta.value.trim();
    if (!prompt) return ta.focus();
    close();
    try {
      const body = { prompt, cwd: s.cwd, also: s.also?.map((a) => a.cwd), machine: place, agent, mode, model, effort, attachments: files.map((f) => f.id) };
      const next = await launchBehind({ prompt, cwd: s.cwd, runner: { agent, model, effort }, machine: place }, () => api('/sessions', { method: 'POST', body }));
      setFocus(next.id);
    } catch (err) {
      toast(`Rerun failed: ${esc(err.message)}`, { tone: 'bad', action: { label: 'Edit again', run: () => rerun(id) } });
    }
  };
  $('[data-a="go"]', node).onclick = go;
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) (e.preventDefault(), go());
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      mode = MODES[(MODES.findIndex((m) => m.id === mode) + 1) % MODES.length].id;
      paintMode();
    }
  });
  requestAnimationFrame(() => (ta.focus(), ta.setSelectionRange(ta.value.length, ta.value.length)));
}

export async function setArchived(id, archived) {
  const prev = S.sessions.get(id);
  if (!prev) return;
  // Optimistic: the card leaves (or comes back) now; a failed save puts it back.
  move(id, { ...prev, archived }, archived);
  if (archived) toast('Archived', { action: { label: 'Undo', run: () => setArchived(id, false) } });
  try {
    await api(`/sessions/${id}`, { method: 'PATCH', body: { archived } });
  } catch (err) {
    revertSummary(id, prev);
    toastError(err);
  }
}

const EDITORS = {
  vscode: (f, l) => `vscode://file${f}${l ? `:${l}` : ''}`,
  cursor: (f, l) => `cursor://file${f}${l ? `:${l}` : ''}`,
  windsurf: (f, l) => `windsurf://file${f}${l ? `:${l}` : ''}`,
  zed: (f, l) => `zed://file${f}${l ? `:${l}` : ''}`,
  idea: (f, l) => `idea://open?file=${encodeURIComponent(f)}${l ? `&line=${l}` : ''}`,
};

// VS Code and its forks open a file on a machine through their Remote - SSH extension.
const REMOTE_EDITORS = new Set(['vscode', 'cursor', 'windsurf']);

export function openInEditor(s, p, line) {
  const editor = S.config.defaults.editor || 'vscode';
  const abs = p.startsWith('/') ? p : `${s.cwd}/${p}`.replace(/\/\.$/, '');
  if (s.machine) {
    if (!REMOTE_EDITORS.has(editor)) {
      copy(abs);
      return toast(`Copied path ${esc(abs)} (on ${esc(s.machine.name)})`);
    }
    location.href = `${editor}://vscode-remote/ssh-remote+${encodeURIComponent(s.machine.target)}${abs}${line ? `:${line}` : ''}`;
    return;
  }
  if (editor === 'none' || !EDITORS[editor]) {
    copy(abs);
    return toast(`Copied path ${esc(abs)}`);
  }
  location.href = EDITORS[editor](abs, line);
}
