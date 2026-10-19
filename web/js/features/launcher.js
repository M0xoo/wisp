// The launcher: the box on top where tasks start. It picks where they run (this computer and/or
// machines, a project in each), on what, and shows a placeholder card until the server answers.

import { esc } from '../md.js';
import { plain } from '../mention-text.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, $$, el, icon } from '../core/dom.js';
import { launch, S, save, saveLaunch } from '../core/state.js';
import { combo } from '../ui/kbd.js';
import { popover } from '../ui/popover.js';
import { toast, toastError } from '../ui/toast.js';
import { acceptFiles, attachTray, autosize } from './attachments.js';
import { openAutomations, recipeParams, runRecipe } from './automations.js';
import { cloneById, clones } from './clones.js';
import { renderFeed } from './feed.js';
import { feedbackCommand, isFeedback } from './feedback.js';
import { connectMachine, offlineToast, openMachines } from './machines.js';
import { mentionBox } from './mentions.js';
import { askNotify } from './notify.js';
import { MACHINE_STATE, machineById, placeName, placeOf, projectById, projectsAt, projectTitle } from './places.js';
import { projectList } from './project-list.js';
import { openProjects } from './projects.js';
import { runnerPicker } from './runner-picker.js';
import { needsSetup, nudgeSetup, renderSetup } from './setup.js';
import { agentName, agentsAt, DEFAULT_MODE, effortLabel, effortsFor, harnessesAt, harnessLogo, MAX_RUNNERS, modeMenu, MODES, paintRunnerBtn, runnerTip, savedEffort, savedModel } from './runners.js';
import { feedAnchor, keepInPlace, stage, topInset } from './scroll.js';
import { canLead, paintTeamBtn, teamEditor } from './team.js';

// "No folder": a general ask with no project. The server gives it an empty scratch directory.
const NO_FOLDER = 'none';
const GENERAL = { id: null, name: 'General', path: '', color: 'slate', scratch: true };
const projectOf = (k) => (launch.picks[k] === NO_FOLDER ? GENERAL : projectById(launch.picks[k]));
// Project chips in the "in" row, at most, before the rest fold into "+N".
const CHIPS = 5;

// Only a change of feed filter moves the launcher, so a "No folder" pick survives re-renders.
let filterSeen = null;

function syncWhere() {
  launch.where = launch.where.filter((k, i) => (!k || machineById(k)) && launch.where.indexOf(k) === i);
  if (!launch.where.length) launch.where = [''];
  // Filtering the feed to a project points the launcher at it (its machine joins if it wasn't picked).
  const f = S.filter !== 'all' && S.filter !== filterSeen && projectById(S.filter);
  filterSeen = S.filter;
  if (f) {
    if (!launch.where.includes(placeOf(f))) launch.where = [placeOf(f)];
    launch.picks[placeOf(f)] = f.id;
  } else if (projectById(launch.project) && !Object.values(launch.picks).includes(launch.project)) launch.picks[placeOf(projectById(launch.project))] ??= launch.project;
  for (const k of launch.where) if (launch.picks[k] !== NO_FOLDER && !cloneById(launch.picks[k]) && !projectsAt(k).some((p) => p.id === launch.picks[k])) launch.picks[k] = projectsAt(k)[0]?.id || null;
  launch.project = launch.picks[launch.where[0]] || null;
}

export function renderLauncher() {
  const box = $('#launcher');
  const mode = S.config.defaults.mode || DEFAULT_MODE.id;
  const here = harnessesAt(launch.where, { auto: true });
  const chosen = here.find((a) => a.id === (S.config.defaults.agent || 'auto'));
  let agent = chosen?.available ? chosen : here.find((a) => a.available) || chosen || here[0];
  box.innerHTML = `
    <div class="l-projects"></div>
    <div class="l-setup" hidden></div>
    <textarea id="prompt" rows="2" spellcheck="false"></textarea>
    <div class="l-bar">
      <button class="icon-btn" id="attach" title="Attach files">${icon('clip')}</button>
      <button class="tog-btn where-btn" id="whereBtn" aria-haspopup="menu"></button>
      <button class="mode-btn" id="mode" aria-haspopup="menu"></button>
      <div class="runners">
        <button class="runner-btn" id="runner" title="Harness and model" aria-haspopup="dialog"></button>
        <button class="vs-btn vs-add" id="compareBtn"><span>vs</span>${icon('plus')}</button>
      </div>
      <button class="tog-btn team-btn" id="teamBtn" aria-haspopup="dialog"></button>
      <span class="grow"></span>
      <button class="tog-btn" id="wtBtn"></button>
      <button class="send" id="launch" title="Launch (Enter · Shift+Enter for newline)">${icon('enter')}</button>
    </div>
    <div class="l-recipes"></div>`;
  renderLaunchChips();
  renderSetup();

  const ta = mentionBox($('#prompt', box));
  const tray = attachTray();
  ta.parentNode.before(tray.node); // before the mention box's wrapper
  acceptFiles(box, ta, tray);
  autosize(ta);
  ta.value = S.drafts.get('home') || '';
  ta.addEventListener('input', () => (S.drafts.set('home', ta.value), paintSaveRecipe()));
  // While focus is elsewhere, the placeholder advertises the shortcut that brings you back.
  const hint = () => (ta.placeholder = document.activeElement === ta
    ? 'What should I go do? Paste screenshots, drop logs or videos…'
    : `What should I go do? Press ${combo('L')} to start typing`);
  ta.addEventListener('focus', hint);
  ta.addEventListener('blur', hint);
  hint();
  // Docked and folded to one line, a click anywhere on it opens it up for typing. A property, not
  // a listener: the launcher re-renders in place, and each render would add another.
  box.onmousedown = (e) => {
    if (!box.matches('.docked:not(:focus-within)')) return;
    e.preventDefault();
    ta.focus();
  };
  $('#attach', box).onclick = tray.pick;
  $('#whereBtn', box).onclick = (e) => whereMenu(e.currentTarget);
  paintWhereBtn();

  // Mode is set-and-forget, so it's one small button: just an icon on the default (Full auto),
  // spelled out when it's Plan or Edits so you can't miss it.
  let curMode = mode;
  const modeBtn = $('#mode', box);
  const paintMode = () => {
    const m = MODES.find((x) => x.id === curMode) || DEFAULT_MODE;
    modeBtn.className = `mode-btn m-${m.id}`;
    modeBtn.innerHTML = `${icon(m.icon)}${m === DEFAULT_MODE ? '' : `<span>${m.label}</span>`}`;
    modeBtn.title = `${m.label}: ${m.hint}\nShift+Tab to switch`;
  };
  const setMode = (id) => {
    curMode = id;
    S.config.defaults.mode = id;
    paintMode();
    api('/config', { method: 'PATCH', body: { defaults: { mode: id } } }).catch(() => {});
  };
  paintMode();
  modeBtn.onclick = () => modeMenu(modeBtn, curMode, setMode);
  box.mode = () => curMode;
  let curModel = savedModel(agent?.id);
  let curEffort = savedEffort(agent?.id, curModel);
  const runnerBtn = $('#runner', box);
  const paintRunner = () => {
    paintRunnerBtn(runnerBtn, agent?.id, curModel, curEffort);
    runnerBtn.title = compare.length ? runnerTip(agent?.id, curModel, curEffort) : `Harness, model and thinking level${curEffort ? `\nThinking: ${effortLabel(curEffort)}` : ''}`;
  };

  // Worktree: each launch gets a fresh branch from the remote's default branch (git repos only).
  const wtBtn = $('#wtBtn', box);
  const paintWt = () => {
    const on = S.config.defaults.worktree !== 'off';
    wtBtn.classList.toggle('on', on);
    wtBtn.innerHTML = `${icon('branch')}<span>${on ? 'Worktree' : 'In place'}</span>`;
    wtBtn.title = on
      ? 'Worktree: runs on its own branch from origin/main in a separate checkout, so parallel agents never collide (git repos; not in Plan mode). Click to work in the project folder instead.'
      : 'In place: edits the project folder directly. Click to give each task its own worktree and branch.';
  };
  paintWt();
  wtBtn.onclick = () => {
    const worktree = S.config.defaults.worktree === 'off' ? 'on' : 'off';
    S.config.defaults.worktree = worktree;
    paintWt();
    api('/config', { method: 'PATCH', body: { defaults: { worktree } } }).catch(() => {});
  };

  // Subagents: remembered like the other picks, so a team stays set until you clear it.
  let team = (S.config.defaults.subagents || []).filter((m) => S.agents.some((a) => a.id === m.agent));
  let teamPreset = S.config.defaults.teamPreset || '';
  const teamBtn = $('#teamBtn', box);
  const paintTeam = () => paintTeamBtn(teamBtn, team, teamPreset, agent?.id);
  paintTeam();
  teamBtn.onclick = () =>
    teamEditor(teamBtn, { lead: agent?.id, team, presetId: teamPreset, places: launch.where }, (members, preset) => {
      if (JSON.stringify([members, preset]) === JSON.stringify([team, teamPreset])) return;
      team = members;
      teamPreset = preset;
      Object.assign(S.config.defaults, { subagents: team, teamPreset });
      paintTeam();
      api('/config', { method: 'PATCH', body: { defaults: { subagents: team, teamPreset } } }).catch(() => {});
    });

  // Compare: more harnesses get the same task (up to MAX_RUNNERS in all); picks here don't touch
  // the launcher defaults. Each extra sits behind a "vs" that removes it; the button at the end
  // adds the next one. Past two, the pill folds the names away and keeps the logos.
  let compare = [];
  const vsBtn = $('#compareBtn', box);
  const runners = vsBtn.parentElement;
  const paintCompare = () => {
    const n = compare.length;
    runners.classList.toggle('cmp', n > 0);
    runners.classList.toggle('many', n > 1);
    for (const x of $$('.cmp-x', runners)) x.remove();
    compare.forEach((c, i) => {
      const name = agentName(c.agent);
      const del = el(`<button class="vs-btn vs-del cmp-x" data-i="${i}" title="Remove ${esc(name)} from the comparison" aria-label="Remove ${esc(name)}"><span>vs</span>${icon('x')}</button>`);
      const btn = el(`<button class="runner-btn cmp-x" data-i="${i}" aria-haspopup="dialog"></button>`);
      paintRunnerBtn(btn, c.agent, c.model, c.effort);
      btn.title = runnerTip(c.agent, c.model, c.effort);
      vsBtn.before(del, btn);
    });
    vsBtn.hidden = n >= MAX_RUNNERS - 1;
    vsBtn.title = n ? `Add another harness (up to ${MAX_RUNNERS} side by side)` : 'Compare: run the same task on another harness, side by side';
    paintRunner(); // its tooltip spells everything out once the names fold away
  };
  vsBtn.onclick = () => {
    // The next harness nobody in the pill uses yet; once they're all in, another copy of the lead.
    const used = new Set([agent?.id, ...compare.map((c) => c.agent)]);
    const here = harnessesAt(launch.where).filter((a) => a.available);
    const next = here.find((a) => !used.has(a.id)) || agent;
    const model = savedModel(next?.id);
    compare = [...compare, { agent: next?.id, model, effort: savedEffort(next?.id, model) }];
    paintCompare();
    // Its "vs" lands right under the pointer: it can't remove anything until the pointer has left.
    const fresh = $$('.vs-del', runners).at(-1);
    fresh?.classList.add('fresh');
    fresh?.addEventListener('pointerleave', () => fresh.classList.remove('fresh'), { once: true });
    // Straight into picking it when it's a repeat, since that's rarely the one you want.
    if (used.has(next?.id)) $$('.runner-btn.cmp-x', runners).at(-1)?.click();
  };
  runners.addEventListener('click', (e) => {
    const x = e.target.closest('.cmp-x');
    if (!x) return;
    const i = Number(x.dataset.i);
    if (x.classList.contains('vs-del')) {
      if (x.classList.contains('fresh')) return;
      compare = compare.filter((_, k) => k !== i);
      paintCompare();
      (compare.length ? $$('.vs-del', runners)[Math.min(i, compare.length - 1)] : vsBtn).focus();
      return;
    }
    runnerPicker(x, { ...compare[i], savedModel, savedEffort, places: launch.where }, (id, model, effort) => {
      compare = compare.map((c, k) => (k === i ? { agent: id, model, effort } : c));
      paintCompare();
    });
  });
  paintCompare();
  runnerBtn.onclick = () =>
    runnerPicker(runnerBtn, { agent: agent?.id, model: curModel, effort: curEffort, savedModel, savedEffort, places: launch.where, auto: true }, (id, model, effort) => {
      agent = harnessesAt(launch.where, { auto: true }).find((a) => a.id === id);
      curModel = model;
      curEffort = effort;
      paintRunner();
      paintTeam();
      const d = S.config.defaults;
      const models = { ...d.models, [id]: model };
      // A model without levels leaves the harness's saved level alone, so switching back restores it.
      const efforts = effort || effortsFor(id, model).length ? { ...d.efforts, [id]: effort } : d.efforts;
      Object.assign(d, { agent: id, model, models, effort, efforts });
      api('/config', { method: 'PATCH', body: { defaults: { agent: id, model, models, effort, efforts } } }).catch(() => {});
    });

  const go = async () => {
    const prompt = ta.value.trim();
    if (!prompt) return ta.focus();
    if (isFeedback(prompt)) {
      ta.value = '';
      ta.dispatchEvent(new Event('input'));
      return feedbackCommand(prompt, { restore: () => !ta.value && ((ta.value = prompt), ta.dispatchEvent(new Event('input'))) });
    }
    // One run per place picked under "Run on", each in the project picked for it.
    const targets = launch.where.map((k) => ({ k, m: k ? machineById(k) : null, project: projectOf(k), clone: cloneById(launch.picks[k]) }));
    const unset = targets.find((t) => !t.project && !t.clone);
    if (unset) return openProjects({ focusAdd: true, machine: unset.k || null });
    const off = targets.find((t) => t.m && t.m.state !== 'online');
    if (off) return offlineToast(off.k);
    if (needsSetup()) return nudgeSetup();
    const wanted = [agent?.id, ...compare.map((c) => c.agent)].filter((id) => id !== 'auto'); // Auto picks from what's there
    for (const t of targets) {
      const list = agentsAt(t.k);
      const missing = list && wanted.find((id) => !list.some((x) => x.id === id && x.available));
      if (missing) return toast(`${esc(agentName(missing))} isn’t installed on <b>${esc(placeName(t.k))}</b>`, { tone: 'bad' });
    }
    const btn = $('#launch', box);
    // Optimistic: wait only for uploads, then empty the box and show the task in Working at
    // once. Fetching and making worktrees can take a few seconds; the real card replaces the
    // placeholder when the server has it. On failure the prompt and files come back.
    const attachments = await tray.ids();
    const files = tray.take();
    const cmp = compare;
    const runner = { agent: agent?.id || 'claude', model: curModel, effort: curEffort };
    // A repo still cloning gets a stand-in project; its card says so until the clone lands.
    const pending = targets.map((t) => addPending(prompt, t.project ? t : { ...t, project: { id: t.clone.id, name: t.clone.name, path: '', color: 'slate' } }, runner, t.clone && `Cloning ${t.clone.label}`));
    if (cmp.length) (compare = []), paintCompare();
    ta.value = '';
    S.drafts.delete('home');
    ta.dispatchEvent(new Event('input'));
    if (S.filter !== 'all' && targets.some((t) => t.project?.scratch || t.project?.id !== S.filter)) {
      S.filter = 'all';
      save('wisp.filter', S.filter);
    }
    renderFeed();
    const ghost = S.nodes.get(pending[0])?.card;
    showLaunched(btn, ghost);
    ta.focus();
    try {
      for (const [i, t] of targets.entries()) {
        if (!t.clone) continue;
        const p = (t.project = await t.clone.promise);
        // Now a real project, so the live session can replace the card (dropPending).
        const card = S.sessions.get(pending[i]);
        if (card) Object.assign(card, { projectId: p.id, project: p.name, cwd: p.path, color: p.color, live: 'Starting up' }), renderFeed();
      }
      // Several places: one shared groupId, so the runs land as one task with a row each.
      const groupId = targets.length > 1 ? [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('') : undefined;
      const results = await Promise.allSettled(
        targets.map((t) =>
          api('/sessions', {
            method: 'POST',
            body: { prompt, cwd: t.project.scratch ? undefined : t.project.path, scratch: t.project.scratch || undefined, machine: t.k || undefined, groupId, agent: runner.agent, mode: curMode, model: runner.model, effort: runner.effort, attachments, worktree: S.config.defaults.worktree === 'off' && !cmp.length ? false : undefined, compare: cmp.length ? cmp : undefined, subagents: team.length && canLead(runner.agent) ? team : undefined },
          }),
        ),
      );
      results.forEach((r, i) => {
        if (r.status === 'rejected') toast(`${esc(placeName(targets[i].k))}: ${esc(r.reason.message)}`, { tone: 'bad' });
      });
      const started = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      for (const id of pending) S.sessions.delete(id);
      for (const x of started.flatMap((y) => y.group || [y])) S.sessions.set(x.id, x);
      keepInPlace(feedAnchor(), renderFeed);
      if (!started.length) {
        if (!ta.value) ((ta.value = prompt), ta.dispatchEvent(new Event('input')));
        tray.restore(files);
        if (cmp.length && !compare.length) (compare = cmp), paintCompare();
        return;
      }
      askNotify();
    } catch (err) {
      for (const id of pending) S.sessions.delete(id);
      renderFeed();
      if (!err.shown) return toastError(err);
      // The clone failed (its toast says why): the task goes back in the box.
      if (!ta.value) ((ta.value = prompt), ta.dispatchEvent(new Event('input')));
      tray.restore(files);
    }
  };
  $('#launch', box).onclick = go;
  // Picking other places (or a machine coming online) changes which harnesses exist: keep the
  // pick if one of them still has it, else move to one that's installed there.
  box.placesChanged = () => {
    renderSetup();
    const here = harnessesAt(launch.where, { auto: true }); // Auto works anywhere: it picks from what's there
    if (!agent || here.find((a) => a.id === agent.id)?.available) return paintRunner();
    const next = here.find((a) => a.id === S.config.defaults.agent && a.available) || here.find((a) => a.available);
    if (!next) return paintRunner();
    agent = next;
    curModel = savedModel(agent.id);
    curEffort = savedEffort(agent.id, curModel);
    paintRunner();
    paintTeam();
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      go();
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      setMode(MODES[(MODES.findIndex((m) => m.id === curMode) + 1) % MODES.length].id);
    }
  });
}

// No folder everywhere picked: no git repo, so no worktree either; the toggle would only mislead.
function paintScratch() {
  const wt = $('#launcher #wtBtn');
  if (wt) wt.hidden = launch.where.every((k) => launch.picks[k] === NO_FOLDER);
}

export function renderLaunchChips() {
  const box = $('#launcher .l-projects');
  if (!box) return;
  syncWhere();
  const multi = launch.where.length > 1;
  // One group per place: its name (unless it's only this computer), its projects, a way to add one.
  const group = (k) => {
    const m = k && machineById(k);
    const list = projectsAt(k);
    const off = m && m.state !== 'online';
    const label = k || multi ? `<span class="lp-gl ${off ? 'off' : ''}" title="${esc(k ? `${m?.target} · ${MACHINE_STATE[m?.state] || ''}` : 'This computer')}">${icon(k ? 'server' : 'laptop')}${esc(placeName(k))}${off ? `<button class="link xs" data-connect="${k}">${m.state === 'connecting' || m.state === 'reconnecting' ? 'connecting…' : 'Connect'}</button>` : ''}</span>` : '';
    // A repo still cloning: picked, with a spinner, until the real project replaces it.
    const cloning = clones
      .filter((c) => (c.where || '') === k)
      .map((c) => `<button class="lp-chip cloning ${c.id === launch.picks[k] ? 'on' : ''}" data-id="${c.id}" data-k="${k}" title="Cloning ${esc(c.label)}…"><span class="orb live"></span>${esc(c.name)}<span class="lp-note">cloning…</span></button>`)
      .join('');
    // Tens of projects: the most recent few as chips (the pick always among them), the rest one
    // search away behind "+N". fitChips() then folds more into it if the row would wrap.
    const max = multi ? 3 : CHIPS;
    let shown = list;
    if (list.length > max) {
      const top = list.slice(0, max);
      const picked = list.find((p) => p.id === launch.picks[k]);
      shown = !picked || top.includes(picked) ? top : [...top.slice(0, -1), picked].sort((a, b) => list.indexOf(a) - list.indexOf(b));
    }
    const chips = cloning + shown.map((p) => `<button class="lp-chip c-${p.color} ${p.id === launch.picks[k] ? 'on' : ''}" data-id="${p.id}" data-k="${k}" title="${esc(projectTitle(p))}"><i class="p-dot"></i>${esc(p.name)}</button>`).join('');
    const more = list.length > 1 ? `<button class="lp-chip more" data-more="${k}" data-total="${list.length}" title="All ${list.length} projects${k ? ` on ${esc(placeName(k))}` : ''}" aria-haspopup="dialog"><span class="lp-more-n"></span>${icon('search')}</button>` : '';
    const add = list.length || cloning
      ? `<button class="lp-chip add" data-add="${k}" title="Another folder${k ? ` on ${esc(placeName(k))}` : ''}">${icon('folder')}${multi || list.length > max ? '' : 'Other folder…'}</button>`
      : `<button class="lp-chip add" data-add="${k}">${icon('folder')}${k ? `Pick a project on ${esc(placeName(k))}…` : 'Choose a folder…'}</button>`;
    const none = `<button class="lp-chip none ${launch.picks[k] === NO_FOLDER ? 'on' : ''}" data-id="${NO_FOLDER}" data-k="${k}" title="No folder: a general ask, with no project and no worktree. The agent gets an empty scratch directory.">${icon('spark')}<span>No folder</span></button>`;
    return `<span class="lp-group">${label}${chips}${more}${none}${add}</span>`;
  };
  box.innerHTML = `<span class="l-in">in</span>${launch.where.map(group).join('')}`;
  fitChips(box);
  fitRow ??= new ResizeObserver(([e]) => {
    if (e.contentRect.width === fitRow.w) return; // its own folding only changes the height
    fitRow.w = e.contentRect.width;
    fitChips(e.target);
  });
  fitRow.observe(box);
  paintScratch();
  const pick = (k, id) => {
    launch.picks[k] = id;
    if (k === launch.where[0]) launch.project = id;
    saveLaunch();
    paintScratch();
    renderLaunchRecipes();
  };
  box.onclick = (e) => {
    const chip = e.target.closest('.lp-chip[data-id]');
    if (chip) {
      pick(chip.dataset.k, chip.dataset.id);
      $$(`.lp-chip[data-k="${chip.dataset.k}"]`, box).forEach((x) => x.classList.toggle('on', x === chip));
      return;
    }
    const more = e.target.closest('[data-more]');
    if (more) {
      const k = more.dataset.more;
      return projectList(more, {
        projects: projectsAt(k),
        current: launch.picks[k],
        label: `Projects on ${placeName(k)}`,
        extras: [
          { id: NO_FOLDER, label: 'No folder', icon: 'spark' },
          { id: '+add', label: k ? `Another folder on ${placeName(k)}…` : 'Other folder…', icon: 'folder' },
        ],
        onPick: (id) => {
          if (id === '+add') return openProjects({ focusAdd: true, machine: k || null });
          pick(k, id);
          renderLaunchChips(); // the pick joins the chips
          $('#prompt')?.focus();
        },
      });
    }
    const add = e.target.closest('[data-add]');
    if (add) openProjects({ focusAdd: true, machine: add.dataset.add || null });
    const conn = e.target.closest('[data-connect]');
    if (conn) connectMachine(conn.dataset.connect);
  };
  renderLaunchRecipes();
  paintWhereBtn();
}

// One row, however many projects: on a single place, the least recent chips (never the pick, and
// at least one) fold into "+N" until the row stops wrapping. "+N" counts what isn't a chip.
let fitRow;
function fitChips(box) {
  for (const g of $$('.lp-group', box)) {
    const chips = $$('.lp-chip[data-id]:not(.none):not(.cloning)', g);
    const more = $('.lp-chip.more', g);
    chips.forEach((c) => (c.hidden = false));
    const paint = () => {
      const n = Number(more?.dataset.total) - chips.filter((c) => !c.hidden).length;
      if (!more) return;
      more.hidden = !n;
      $('.lp-more-n', more).textContent = `+${n}`;
    };
    paint();
    if (launch.where.length > 1) continue;
    const wraps = () => {
      const kids = [...g.children].filter((x) => !x.hidden && x.offsetParent);
      const lin = $('.l-in', box); // "in" left alone on a line counts too
      return kids.some((x) => x.offsetTop >= kids[0].offsetTop + kids[0].offsetHeight) || (lin && kids[0].offsetTop >= lin.offsetTop + lin.offsetHeight);
    };
    for (const c of chips.filter((x) => !x.classList.contains('on')).reverse()) {
      if (!wraps() || chips.filter((x) => !x.hidden).length <= 1) break;
      c.hidden = true;
      paint();
    }
    // "+1" is no shorter than the one chip it would stand for: keep the chip, let the row wrap.
    const folded = chips.filter((c) => c.hidden);
    if (folded.length && Number(more?.dataset.total) - chips.length + folded.length === 1) {
      folded.forEach((c) => (c.hidden = false));
      paint();
    }
  }
}

// "Run on": this computer and/or machines. The button says where; its menu picks one or several.
function paintWhereBtn() {
  const b = $('#whereBtn');
  if (!b) return;
  const n = launch.where.length;
  const remote = n > 1 || !!launch.where[0];
  b.classList.toggle('on', remote);
  b.classList.toggle('bare', !S.machines.length && !remote);
  b.innerHTML = `${icon(remote ? 'server' : 'laptop')}<span>${esc(n > 1 ? `${n} places` : placeName(launch.where[0]))}</span>${icon('chevron', 'chev')}`;
  b.title = n > 1 ? `Runs in parallel on ${launch.where.map(placeName).join(', ')}` : S.machines.length ? `Runs on ${placeName(launch.where[0])}. Pick several to run in parallel.` : 'Runs on this computer. Add a machine to run on other computers too.';
}

function whereMenu(anchor) {
  if ($('.menu.where-menu')) return $('.menu.where-menu').close();
  const box = el(`<div class="menu where-menu" role="menu"></div>`);
  const paint = () => {
    const row = (k, m) => {
      const on = launch.where.includes(k);
      const st = m ? m.state : 'online';
      const ready = m ? (m.remote?.agents || []).filter((a) => a.available) : [];
      return `<button class="wm-row ${on ? 'on' : ''}" data-k="${k}" role="menuitemcheckbox" aria-checked="${on}">
        <span class="wm-check">${icon('check')}</span>
        <span class="wm-icon">${icon(k ? 'server' : 'laptop')}${m ? `<i class="dot ${st === 'online' ? 'ok' : st === 'error' ? 'bad' : ''}"></i>` : ''}</span>
        <span class="wm-name"><b>${esc(placeName(k))}</b><small>${m ? esc(st === 'online' ? m.target : `${m.target} · ${MACHINE_STATE[st]}`) : `${projectsAt('').length} project${projectsAt('').length === 1 ? '' : 's'}`}</small></span>
        ${m && st === 'online' && ready.length ? `<span class="wm-agents">${ready.map((a) => `<span class="model-logo">${harnessLogo(a.id)}</span>`).join('')}</span>` : ''}
        <span class="wm-only" data-only="${k}" title="Only here">only</span>
      </button>`;
    };
    box.innerHTML = `<div class="wm-h">Run on <small>pick several to run in parallel</small></div>
      ${row('', null)}${S.machines.map((m) => row(m.id, m)).join('')}
      <div class="wm-sep"></div>
      <button data-a="add">${icon('plus')}${S.machines.length ? 'Add a machine…' : 'Add a machine to run on another computer…'}</button>
      ${S.machines.length ? `<button data-a="manage">${icon('settings')}Manage machines</button>` : ''}`;
  };
  const set = (list) => {
    launch.where = list.length ? list : [''];
    // A machine picked while disconnected starts connecting; you asked to run there.
    for (const k of launch.where) if (k && machineById(k)?.state === 'off') connectMachine(k);
    renderLaunchChips();
    $('#launcher')?.placesChanged?.();
    paint();
    saveLaunch();
  };
  box.onclick = (e) => {
    const only = e.target.closest('[data-only]');
    if (only) return set([only.dataset.only]);
    const r = e.target.closest('.wm-row');
    if (r) {
      const k = r.dataset.k;
      return set(launch.where.includes(k) ? launch.where.filter((x) => x !== k) : [...launch.where, k]);
    }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    shut();
    openMachines({ focusAdd: a === 'add' });
  };
  paint();
  const shut = popover(box, { anchor, onClose: () => anchor.setAttribute('aria-expanded', 'false') });
  bus.on('machines', paint, { node: box });
  anchor.setAttribute('aria-expanded', 'true');
  const r = anchor.getBoundingClientRect();
  const h = box.offsetHeight;
  box.style.left = `${Math.min(r.left, innerWidth - box.offsetWidth - 8)}px`;
  box.style.top = `${r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
}

// Recipes for the picked project (and the ones tied to none), one click from the launcher.
// With text in the box, "Save as recipe" turns it into one.
function renderLaunchRecipes() {
  const row = $('#launcher .l-recipes');
  if (!row) return;
  const path = projectById(launch.project)?.path;
  const all = S.config.recipes || [];
  const list = all.filter((r) => !r.cwd || r.cwd === path).sort((a, b) => (b.lastRunAt || 0) - (a.lastRunAt || 0));
  const hidden = all.length - list.length;
  row.innerHTML = `
    <span class="l-in">${icon('spark')}Recipes</span>
    ${list.map((r) => `<button class="lp-chip rc" data-recipe="${esc(r.id)}" title="${esc(r.prompt.replace(/\s+/g, ' ').slice(0, 200))}">${esc(r.name)}${recipeParams(r.prompt).length ? '<i class="rc-f">…</i>' : ''}</button>`).join('')}
    ${list.length ? '' : `<span class="muted xs lr-empty">${hidden ? `None for this project · ${hidden} elsewhere` : 'Prompts you send again and again, one click away'}</span>`}
    <button class="lp-chip add" id="lrSave" hidden>${icon('plus')}Save as recipe</button>
    <button class="lp-chip add" id="lrNew">${icon('plus')}New</button>`;
  row.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.recipe) {
      const r = all.find((x) => x.id === b.dataset.recipe);
      return r && runRecipe({ ...r, params: recipeParams(r.prompt) });
    }
    const draft = { name: '', prompt: '', cwd: path || '', mode: $('#launcher').mode?.() };
    if (b.id === 'lrSave') openAutomations({ tab: 'recipes', edit: { type: 'recipe', draft: { ...draft, prompt: $('#prompt').value.trim() } } });
    if (b.id === 'lrNew') openAutomations({ tab: 'recipes', edit: { type: 'recipe', draft } });
  };
  paintSaveRecipe();
}
function paintSaveRecipe() {
  const has = !!$('#prompt')?.value.trim();
  const save = $('#lrSave');
  if (!save) return;
  save.hidden = !has;
  $('#lrNew').hidden = has;
}

// A little wisp flies from the launch button to the new item in the feed.
function launchedFx(from, to) {
  to?.classList.add('arrived');
  setTimeout(() => to?.classList.remove('arrived'), 1600);
  if (!to || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const w = el(`<div class="flying-wisp"></div>`);
  w.style.left = `${a.left + a.width / 2}px`;
  w.style.top = `${a.top + a.height / 2}px`;
  document.body.append(w);
  const dx = b.left + 24 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  w.animate(
    [
      { transform: 'translate(-50%,-50%) scale(.6)', opacity: 0 },
      { transform: `translate(calc(-50% + ${dx * 0.4}px), calc(-50% + ${dy * 0.4 - 60}px)) scale(1.3)`, opacity: 1, offset: 0.35 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.4)`, opacity: 0 },
    ],
    { duration: 800, easing: 'cubic-bezier(.5,0,.3,1)' },
  ).onfinish = () => w.remove();
}

// A launch the server hasn't answered yet: a placeholder summary that shows in Working as a
// "Starting up" card. It can't be opened; the real card takes its place.
let pendingSeq = 0;
function addPending(prompt, { project: p, m }, { agent, model, effort }, live = 'Starting up') {
  const id = `pending-${++pendingSeq}`;
  const line = plain(prompt).split('\n')[0].replace(/\s+/g, ' ');
  const now = Date.now();
  S.sessions.set(id, {
    id,
    pending: true,
    title: line.length > 64 ? `${line.slice(0, 63)}…` : line,
    agent,
    model,
    effort,
    cwd: p.path,
    scratch: p.scratch,
    project: p.name,
    projectId: p.id,
    color: p.color || 'slate',
    state: 'running',
    live,
    createdAt: now,
    updatedAt: now,
    machine: m ? { id: m.id, name: m.name, target: m.target } : null,
  });
  return id;
}

// A launch from a dialog (rerun, recipes): the dialog closes and a placeholder shows in Working
// at once; the real session replaces it, or it disappears and the error is thrown on.
export async function launchBehind({ prompt, cwd, runner }, request) {
  const sum = S.config.projects.find((p) => p.path === cwd);
  const project = sum || { path: cwd, name: cwd.split('/').filter(Boolean).pop() || cwd, id: null, color: 'slate' };
  const ghost = addPending(prompt, { project, m: project.machine ? machineById(project.machine) : null }, runner);
  if (S.filter !== 'all' && S.filter !== project.id) {
    S.filter = 'all';
    save('wisp.filter', S.filter);
  }
  renderFeed();
  const card = S.nodes.get(ghost)?.card;
  if (card) (card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), card.classList.add('arrived'), setTimeout(() => card.classList.remove('arrived'), 1600));
  try {
    const s = await request();
    S.sessions.delete(ghost);
    for (const x of s.group || [s]) S.sessions.set(x.id, x);
    keepInPlace(feedAnchor(), renderFeed);
    return s;
  } catch (err) {
    S.sessions.delete(ghost);
    renderFeed();
    throw err;
  }
}

// The real session showed up (live events can beat the launch response): drop its placeholder.
export function dropPending(s) {
  if (s.pending || s.parentId) return;
  for (const x of S.sessions.values()) if (x.pending && x.projectId === s.projectId) return S.sessions.delete(x.id);
}

// A new card lands in Working, below everything in "Needs you", so it's often off-screen. Scroll
// it into view (just enough) and flash it; the flying wisp only plays when the card is already
// on screen, since the launcher it starts from may scroll away or fold into the dock.
function showLaunched(btn, card) {
  if (!card) return;
  const r = card.getBoundingClientRect();
  if (r.top >= topInset() && r.bottom <= innerHeight) return launchedFx(btn, card);
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  card.classList.add('arrived');
  setTimeout(() => card.classList.remove('arrived'), 1600);
}

export function focusLauncher() {
  // Docked under the top bar it opens where it is, so you keep your place in the feed.
  if (!$('#launcher').classList.contains('docked')) stage.scrollTo({ top: 0, behavior: 'smooth' });
  $('#prompt')?.focus({ preventScroll: true });
}
