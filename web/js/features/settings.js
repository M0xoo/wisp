// Settings: a sidebar of sections and one pane at a time, like every other app's settings. Big lists
// (memory, automations, usage history) keep their own views; a pane only summarises and links.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, $$, el, icon } from '../core/dom.js';
import { money, pct } from '../core/format.js';
import { S, setAgents } from '../core/state.js';
import { overlay } from '../ui/overlay.js';
import { toast, toastError, tryApi } from '../ui/toast.js';
import { openRouter } from './auto.js';
import { openAutomations } from './automations.js';
import { renderLauncher } from './launcher.js';
import { loadConfig } from './live.js';
import { openMachines } from './machines.js';
import { memorySummary, openMemory, setLearning } from './memory.js';
import { notifyOn } from './notify.js';
import { openPhone, phoneSummary } from './phone.js';
import { machinesSummary } from './places.js';
import { AUTO_GOALS, harnessLogo } from './runners.js';
import { copySetupCommand, INSTALLABLE, installHarness, isInstalling, setupCommand, setupDocs, setupTip } from './setup.js';
import { clearPicks } from './transcript.js';
import { repaintViews } from './turns.js';
import { openUsage } from './usage.js';
import { spellsPane } from './spell-ui.js';
import { setView, viewPref } from './split.js';

// A sidebar of sections and one pane at a time, like every other app's settings. Big lists
// (memory, automations, usage history) keep their own views; a pane only summarises and links.
const SETTINGS_PANES = [
  { id: 'general', label: 'General', icon: 'settings', lede: 'Where files open, where you take over, and how tasks start.' },
  { id: 'notifications', label: 'Notifications', icon: 'bolt', lede: 'Hear about questions and finished tasks, here or on your phone.' },
  { id: 'agents', label: 'Agents', icon: 'agent', lede: 'The harnesses wisp found on this machine. Pick one next to the model in the launcher.' },
  { id: 'auto', label: 'Auto', icon: 'spark', lede: 'wisp picks the harness and model for each task, and learns from how it went.' },
  { id: 'machines', label: 'Machines', icon: 'server', lede: 'Other computers that run agents for you, over SSH.' },
  { id: 'memory', label: 'Memory', icon: 'spark', lede: "Learned from your sessions and added to every agent's prompt. What you ask always wins." },
  { id: 'automations', label: 'Automations', icon: 'play', lede: 'Saved prompts, and the triggers that launch them for you.' },
  { id: 'spells', label: 'Spells', icon: 'wizard', lede: 'Changes to wisp itself: buttons, panels, blocks, looks and behaviour. Cast one, or add one a colleague sent.' },
  { id: 'usage', label: 'Usage', icon: 'stats', lede: 'Spend and outcomes over the last 7 days.' },
  { id: 'privacy', label: 'Privacy', icon: 'info', lede: 'What wisp sends about itself. Never prompts, paths or code.' },
];
let settingsPane = 'general';

// What a re-check turned up: harnesses found or gone, and model lists that grew or shrank.
function recheckSummary(before, after) {
  const count = (a) => (a?.models || []).filter((m) => m.id).length;
  const notes = [];
  for (const a of after) {
    const was = before.get(a.id);
    if (a.available && !was?.available) notes.push(`<b>${esc(a.name)}</b> found`);
    else if (!a.available && was?.available) notes.push(`<b>${esc(a.name)}</b> not found`);
    else if (a.available && count(a) !== count(was)) {
      const d = count(a) - count(was);
      notes.push(`<b>${esc(a.name)}</b> ${d > 0 ? '+' : '−'}${Math.abs(d)} model${Math.abs(d) === 1 ? '' : 's'}`);
    } else if (a.available && a.version !== was?.version) notes.push(`<b>${esc(a.name)}</b> updated`);
  }
  return notes.length ? notes.join(' · ') : 'Up to date: nothing new';
}

export function openSettings(opts) {
  if (SETTINGS_PANES.some((p) => p.id === opts?.pane)) settingsPane = opts.pane;
  const d = S.config.defaults;
  // A row: name and a line of explanation on the left, the control on the right.
  const row = (name, desc, control, cls = '') => `<div class="sx-row ${cls}"><div class="sx-text"><b>${name}</b>${desc ? `<small>${desc}</small>` : ''}</div><div class="sx-ctl">${control}</div></div>`;
  const missing = S.agents.filter((a) => !a.available).length;
  const node = el(`
    <div class="modal settings-modal sx">
      <nav class="sx-nav" role="tablist" aria-orientation="vertical">
        <h2>Settings</h2>
        ${SETTINGS_PANES.map((p) => `<button role="tab" data-pane="${p.id}">${icon(p.icon)}<span>${p.label}</span>${p.id === 'agents' && missing ? `<i class="dot bad" title="${missing} not found"></i>` : ''}</button>`).join('')}
      </nav>
      <div class="sx-main">
        <header><div><h3 class="sx-title"></h3><p class="sx-lede"></p></div><button class="icon-btn close">${icon('x')}</button></header>
        <section class="sx-pane" data-pane="general">
          <div class="sx-group">
            ${row('Open files in', 'File links in cards and diffs', `<select name="editor">${[['vscode', 'VS Code'], ['cursor', 'Cursor'], ['windsurf', 'Windsurf'], ['zed', 'Zed'], ['idea', 'JetBrains'], ['none', 'Copy path']]
              .map(([v, l]) => `<option value="${v}" ${d.editor === v || (!d.editor && v === 'vscode') ? 'selected' : ''}>${l}</option>`)
              .join('')}</select>`)}
            ${row('Take over in', 'The terminal a session opens in when you take it over', `<select name="terminal">${(S.config.terminals || []).map((t) => `<option value="${t.id}" ${(d.terminal || 'auto') === t.id ? 'selected' : ''}>${t.label}</option>`).join('')}</select>`)}
            <div class="sx-row custom-term" ${d.terminal === 'custom' ? '' : 'hidden'}><div class="sx-text"><b>Terminal command</b><small><code>{cwd}</code> and <code>{cmd}</code> are filled in</small></div>
              <div class="sx-ctl"><input class="input mono" name="terminalCommand" value="${esc(d.terminalCommand || '')}" placeholder="alacritty --working-directory {cwd} -e {cmd}" spellcheck="false"></div></div>
          </div>
          <div class="sx-group">
            ${row('Worktree per task', 'Each task gets its own branch from origin/main, in git repos', '<button class="switch" id="wtDefault" role="switch"></button>')}
            ${row('Auto-fix PR conflicts', 'Without waiting for a click on Fix conflicts: when a shipped PR conflicts with its base, the task merges the base in, resolves it and pushes', '<button class="switch" id="fixConflicts" role="switch"></button>')}
          </div>
          <div class="sx-group">
            ${row('Layout', 'Feed: one column, cards open in place. Split: tasks in a sidebar, the open one beside it (in windows 900px and wider). <kbd>\\</kbd> switches', `<fieldset class="pk-seg view-seg">${[['feed', 'Feed'], ['split', 'Split']].map(([v, l]) => `<button type="button" data-view="${v}">${icon(v)}${l}</button>`).join('')}</fieldset>`)}
          </div>
          <div class="sx-group">
            ${row('Full transcript', 'Every message and step the agent took, with its presentation at the end. Any one card switches with its Transcript button or <kbd>V</kbd>', '<button class="switch" id="txDefault" role="switch"></button>')}
          </div>
        </section>
        <section class="sx-pane" data-pane="notifications">
          <div class="sx-group">
            ${row('Desktop notifications', '<span class="notif-hint"></span>', '<button class="switch" id="notif" role="switch"></button>')}
          </div>
          <div class="sx-group">
            ${row('Phone', '<span class="phone-hint">ntfy or Telegram: answer questions from your phone</span>', '<button class="ghost sm" id="openPhone">Set up</button>')}
          </div>
        </section>
        <section class="sx-pane" data-pane="agents">
          <div class="sx-group sx-agents"></div>
          <div class="sx-group">
            ${row('Installed something new?', '<span class="recheck-hint"></span>', `<button class="ghost sm" id="recheck">${icon('replay')}Re-check</button>`)}
          </div>
        </section>
        <section class="sx-pane" data-pane="auto">
          <div class="sx-group">
            ${row('Goal', 'What Auto optimises for. Also in the launcher, next to Auto', `<span class="pk-seg ro-goal">${AUTO_GOALS.map((g) => `<button data-goal="${g.id}" title="${esc(g.hint)}">${g.label}</button>`).join('')}</span>`)}
            ${row('Try new models', 'A new model or harness gets a few tasks that aren’t marked important before Auto relies on it', '<button class="switch" id="roExplore" role="switch"></button>')}
            ${row('Harnesses it may use', 'Leave all off to let Auto use every one you have', '<span class="ro-allowed"></span>')}
          </div>
          <div class="sx-group">
            ${row('Check with the tests', 'When the agent says it’s done, wisp runs the project’s tests itself. Only failures that are new count', '<button class="switch" id="roCheck" role="switch"></button>')}
            ${row('Repair rounds', 'Failing tests go back to the same agent this many times', `<span class="pk-seg ro-repairs">${[0, 1, 2].map((n) => `<button data-n="${n}">${n}</button>`).join('')}</span>`)}
            ${row('Hand over when it still fails', 'The task runs again on a stronger pick, next to the first run', '<button class="switch" id="roEscalate" role="switch"></button>')}
            ${row('Best of two', 'Off by default. With the Best goal, two picks work side by side and wisp marks the better one', '<button class="switch" id="roBest2" role="switch"></button>')}
            ${row('Scout first', 'A cheap model looks around the repo and tells the agent where to start', `<span class="pk-seg ro-scout">${[['off', 'Off'], ['big', 'Bigger tasks'], ['all', 'Every task']].map(([v, l]) => `<button data-v="${v}">${l}</button>`).join('')}</span>`)}
          </div>
          <div class="sx-group">
            ${row('What it learned', '<span class="ro-hint"></span>', '<button class="ghost sm" id="openRouter">Open</button>')}
          </div>
        </section>
        <section class="sx-pane" data-pane="machines">
          <div class="sx-group">
            ${row('Machines', '<span class="machines-hint"></span>', '<button class="ghost sm" id="openMachines">Manage</button>')}
          </div>
          <p class="hint">Also in the top bar. Every project runs on every machine: pick one under Run on and wisp clones the project there the first time. A follow-up or a rerun can move a task to another one.</p>
        </section>
        <section class="sx-pane" data-pane="memory">
          <div class="sx-group">
            ${row('Learn from sessions', 'A short retro after each session keeps preferences and lessons', '<button class="switch" id="learn" role="switch"></button>')}
            ${row('Remembered', '<span class="learn-hint"></span>', '<button class="ghost sm" id="openMemory">Open memory</button>')}
          </div>
        </section>
        <section class="sx-pane" data-pane="automations">
          <div class="sx-group">
            ${row('Recipes', '<span class="recipe-hint"></span>', '<button class="ghost sm" data-auto="recipes">Manage</button>')}
            ${row('Triggers', '<span class="trigger-hint"></span>', '<button class="ghost sm" data-auto="triggers">Manage</button>')}
          </div>
        </section>
        <section class="sx-pane sp-pane" data-pane="spells"></section>
        <section class="sx-pane" data-pane="usage">
          <div class="us-tiles sx-usage"><div class="it-loading"><span class="orb tiny"></span>Adding it up…</div></div>
          <div class="sx-group">${row('Charts and breakdowns', 'Per day, per project and per harness · model', '<button class="ghost sm" id="openUsage">Open usage</button>')}</div>
        </section>
        <section class="sx-pane" data-pane="privacy">
          <div class="sx-group">
            ${row('Anonymous usage stats', '<span class="tele-hint"></span>', '<button class="switch" id="tele" role="switch"></button>')}
          </div>
          <p class="hint">Agent, model, status, timings and scrubbed errors only.</p>
        </section>
      </div>
    </div>`);
  const close = overlay(node);
  $('.close', node).onclick = close;
  spellsPane($('[data-pane="spells"].sx-pane', node));
  const paintAgents = () => {
    $('.sx-agents', node).innerHTML = S.agents.length
      ? S.agents.map((a) => {
        const n = (a.models || []).filter((m) => m.id).length;
        // opencode: wisp can install it (free models, no account), so its row offers that.
        const canInstall = !a.available && INSTALLABLE.has(a.id);
        const busy = isInstalling(a.id);
        // Not found: this OS's setup tip, with the command to copy unless wisp installs it itself.
        const desc = a.available
          ? esc([a.version, n && `${n} model${n === 1 ? '' : 's'}`].filter(Boolean).join(' · '))
          : busy ? 'Installing into ~/.wisp/tools…' : `${esc(setupTip(a))}${a.setup?.command && !canInstall ? setupCommand(a.setup.command) : ''}`;
        const install = canInstall ? `<button class="ghost sm" data-install="${esc(a.id)}" ${busy ? 'disabled' : ''}>${busy ? 'Installing…' : 'Install'}</button>` : '';
        const docs = a.available ? '' : setupDocs(a);
        return row(`<span class="model-logo">${harnessLogo(a.id)}</span>${esc(a.name)}`, desc, `${install}${docs}<span class="sx-state ${a.available ? 'ok' : 'bad'}" ${a.error ? `title="${esc(a.error)}"` : ''}><i class="dot ${a.available ? 'ok' : 'bad'}"></i>${a.available ? 'Ready' : 'Not found'}</span>`);
      }).join('')
      : '<div class="sx-row"><div class="it-loading"><span class="orb tiny"></span>Looking for harnesses…</div></div>';
    const missing = S.agents.filter((a) => !a.available).length;
    const dot = $('.sx-nav [data-pane="agents"] .dot', node);
    if (dot && !missing) dot.remove();
    if (!dot && missing) $('.sx-nav [data-pane="agents"]', node).insertAdjacentHTML('beforeend', `<i class="dot bad" title="${missing} not found"></i>`);
    const online = S.machines.filter((m) => m.state === 'online').length;
    $('.recheck-hint', node).textContent = `After installing a CLI, signing in or adding a provider, look for harnesses and models again${online ? `, here and on ${online} machine${online === 1 ? '' : 's'}` : ''}`;
  };
  paintAgents();
  bus.on('agents', paintAgents, { node });
  bus.on('install', paintAgents, { node });
  $('.sx-agents', node).onclick = (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) return copySetupCommand(c);
    const b = e.target.closest('[data-install]');
    if (b) installHarness(b.dataset.install);
  };
  $('#recheck', node).onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.classList.add('busy');
    const before = new Map(S.agents.map((a) => [a.id, a]));
    try {
      setAgents(await api('/agents/recheck', { method: 'POST', body: {} }));
      if (!node.isConnected) return;
      paintAgents();
      $('#launcher')?.placesChanged?.();
      toast(recheckSummary(before, S.agents));
    } catch (err) {
      toastError(err);
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy');
    }
  };
  const pick = (id, focus = false) => {
    settingsPane = id;
    const p = SETTINGS_PANES.find((x) => x.id === id);
    $$('.sx-nav [data-pane]', node).forEach((b) => {
      const on = b.dataset.pane === id;
      b.setAttribute('aria-selected', on);
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    $$('.sx-pane', node).forEach((s) => (s.hidden = s.dataset.pane !== id));
    $('.sx-title', node).textContent = p.label;
    $('.sx-lede', node).textContent = p.lede;
    $('.sx-main', node).scrollTop = 0;
  };
  // Memory, Automations, Usage and Phone open in the main area, next to the sidebar, with a
  // way back to the section they came from. Leaving one goes back; only the X closes Settings.
  const main = $('.sx-main', node);
  const leave = () => {
    const v = $('.sx-main > .embedded', node);
    if (!v) return;
    v.remove();
    $('.sx-main > header', node).hidden = false;
    paintHints();
  };
  const show = (id, focus) => (leave(), pick(id, focus));
  const host = (pane) => (view) => {
    show(pane);
    view.classList.add('embedded');
    const back = el(`<button class="ghost sm sx-back">${icon('back')}Back</button>`);
    back.onclick = () => show(pane);
    $('header', view).prepend(back);
    $('.close', view).onclick = close;
    $('.sx-main > header', node).hidden = true;
    $$('.sx-pane', node).forEach((s) => (s.hidden = true));
    main.append(view);
    main.scrollTop = 0;
    return close;
  };
  $('.sx-nav', node).onclick = (e) => {
    const b = e.target.closest('[data-pane]');
    if (b) show(b.dataset.pane);
  };
  $('.sx-nav', node).onkeydown = (e) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = SETTINGS_PANES.findIndex((p) => p.id === settingsPane);
    show(SETTINGS_PANES[(i + step + SETTINGS_PANES.length) % SETTINGS_PANES.length].id, true);
  };
  show(settingsPane);
  node.addEventListener('change', async (e) => {
    const { name, value } = e.target;
    if (!name || e.target.closest('.embedded')) return; // a nested view's own form
    if (name === 'terminal') $('.custom-term', node).hidden = value !== 'custom';
    await tryApi(async () => {
      await api('/config', { method: 'PATCH', body: { defaults: { [name]: value } } });
      await loadConfig();
    });
  });
  // The switch shows wisp's own on/off preference; the browser permission can only be
  // granted from here, never revoked, so it surfaces as a hint when it blocks the switch.
  const sw = $('#notif', node);
  const paint = () => {
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    const on = notifyOn();
    sw.setAttribute('aria-checked', on);
    sw.disabled = perm === 'denied' || perm === 'unsupported';
    $('.notif-hint', node).textContent =
      perm === 'denied' ? 'Blocked — allow notifications for this site in your browser' : perm === 'unsupported' ? 'Not supported here' : on ? 'On' : 'Off';
  };
  sw.onclick = async () => {
    let want = !notifyOn();
    if (want && Notification.permission !== 'granted') want = (await Notification.requestPermission()) === 'granted';
    await tryApi(async () => {
      await api('/config', { method: 'PATCH', body: { defaults: { notify: want ? 'on' : 'off' } } });
      await loadConfig();
    });
    paint();
  };
  paint();
  // Agent, model, status, timings and scrubbed errors only; never prompts, paths or code.
  const tele = $('#tele', node);
  const paintTele = () => {
    const t = S.config.telemetry || {};
    tele.setAttribute('aria-checked', !!t.enabled);
    tele.disabled = !t.available;
    $('.tele-hint', node).textContent = !t.available ? 'Off (DO_NOT_TRACK, WISP_TELEMETRY=0 or CI)' : 'No prompts, paths or code';
  };
  tele.onclick = async () => {
    await tryApi(async () => {
      await api('/config', { method: 'PATCH', body: { defaults: { telemetry: S.config.telemetry?.enabled ? 'off' : 'on' } } });
      await loadConfig();
    });
    paintTele();
  };
  paintTele();
  // Memory: one line here (on/off and a summary); the lists and retros live in their own view.
  const learn = $('#learn', node);
  const paintLearn = async () => {
    learn.setAttribute('aria-checked', S.config.defaults.learn !== 'off');
    $('.learn-hint', node).textContent = memorySummary(await api('/preferences').catch(() => null));
  };
  learn.onclick = async () => {
    await tryApi(() => setLearning(S.config.defaults.learn === 'off'));
    paintLearn();
  };
  bus.on('preferences', paintLearn, { node });
  // One line each; their lists and charts live in their own views.
  const wt = $('#wtDefault', node);
  const paintWt = () => wt.setAttribute('aria-checked', S.config.defaults.worktree !== 'off');
  wt.onclick = async () => {
    const saved = await tryApi(async () => {
      await api('/config', { method: 'PATCH', body: { defaults: { worktree: S.config.defaults.worktree === 'off' ? 'on' : 'off' } } });
      await loadConfig();
      return true;
    });
    if (!saved) return;
    paintWt();
    renderLauncher();
  };
  paintWt();
  const fc = $('#fixConflicts', node);
  const paintFc = () => fc.setAttribute('aria-checked', S.config.defaults.fixConflicts === 'on');
  fc.onclick = async () => {
    const was = S.config.defaults.fixConflicts;
    S.config.defaults.fixConflicts = was === 'on' ? 'off' : 'on';
    paintFc();
    const saved = await tryApi(() => api('/config', { method: 'PATCH', body: { defaults: { fixConflicts: S.config.defaults.fixConflicts } } }));
    if (!saved) {
      S.config.defaults.fixConflicts = was;
      paintFc();
    }
  };
  paintFc();
  // The transcript switch flips every open card at once; a refused save flips them back.
  const tx = $('#txDefault', node);
  const paintTx = () => tx.setAttribute('aria-checked', S.config.defaults.transcript === 'on');
  const setTx = (v) => {
    S.config.defaults.transcript = v;
    clearPicks();
    paintTx();
    repaintViews();
  };
  tx.onclick = async () => {
    const was = S.config.defaults.transcript || 'off';
    setTx(was === 'on' ? 'off' : 'on');
    const saved = await tryApi(() => api('/config', { method: 'PATCH', body: { defaults: { transcript: S.config.defaults.transcript } } }));
    if (!saved) setTx(was);
  };
  paintTx();
  // Layout: switches at once, and back if the save is refused (setView does both).
  const paintView = () => $$('.view-seg button', node).forEach((b) => b.classList.toggle('on', b.dataset.view === viewPref()));
  $$('.view-seg button', node).forEach((b) => {
    b.onclick = () => {
      const saved = setView(b.dataset.view);
      paintView();
      saved.then(paintView);
    };
  });
  paintView();
  bus.on('view', paintView, { node });
  bus.on('config', paintView, { node });
  // Auto: goal, exploring and allowed harnesses here; the full record in its own view.
  const paintAuto = async () => {
    const r = await api('/router').catch(() => null);
    if (!r || !node.isConnected) return;
    $$('.ro-goal button', node).forEach((b) => b.classList.toggle('on', b.dataset.goal === r.goal));
    $('#roExplore', node).setAttribute('aria-checked', r.settings.explore);
    $('#roCheck', node).setAttribute('aria-checked', r.settings.check);
    $('#roEscalate', node).setAttribute('aria-checked', r.settings.escalate);
    $('#roBest2', node).setAttribute('aria-checked', r.settings.best2);
    $$('.ro-repairs button', node).forEach((b) => b.classList.toggle('on', Number(b.dataset.n) === r.settings.repairs));
    $$('.ro-scout button', node).forEach((b) => b.classList.toggle('on', b.dataset.v === r.settings.scout));
    const allowed = r.settings.allowed || [];
    $('.ro-allowed', node).innerHTML = S.agents
      .filter((a) => a.available)
      .map((a) => `<button class="chip-tog${allowed.includes(a.id) ? ' on' : ''}" data-id="${esc(a.id)}" aria-pressed="${allowed.includes(a.id)}" title="${esc(a.name)}"><span class="model-logo">${harnessLogo(a.id)}</span>${esc(a.name)}</button>`)
      .join('');
    $('.ro-hint', node).textContent = r.learned
      ? `${r.learned} task${r.learned === 1 ? '' : 's'} learned from · ${r.arms.filter((a) => a.state !== 'gone').length} harness · model · level options`
      : `Nothing of yours yet · starting from wisp-bench (${r.priors.version})`;
  };
  const patchAuto = async (body) => {
    try {
      await api('/router', { method: 'PATCH', body });
      await loadConfig();
      renderLauncher();
    } catch (err) {
      toastError(err);
    }
    paintAuto();
  };
  $('.ro-goal', node).onclick = (e) => {
    const b = e.target.closest('[data-goal]');
    if (b) {
      $$('.ro-goal button', node).forEach((x) => x.classList.toggle('on', x === b));
      patchAuto({ goal: b.dataset.goal });
    }
  };
  for (const [id, key] of [['#roExplore', 'explore'], ['#roCheck', 'check'], ['#roEscalate', 'escalate'], ['#roBest2', 'best2']]) {
    $(id, node).onclick = (e) => {
      const on = e.currentTarget.getAttribute('aria-checked') !== 'true';
      e.currentTarget.setAttribute('aria-checked', on);
      patchAuto({ [key]: on });
    };
  }
  $('.ro-repairs', node).onclick = (e) => {
    const b = e.target.closest('[data-n]');
    if (!b) return;
    $$('.ro-repairs button', node).forEach((x) => x.classList.toggle('on', x === b));
    patchAuto({ repairs: Number(b.dataset.n) });
  };
  $('.ro-scout', node).onclick = (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    $$('.ro-scout button', node).forEach((x) => x.classList.toggle('on', x === b));
    patchAuto({ scout: b.dataset.v });
  };
  $('.ro-allowed', node).onclick = (e) => {
    const b = e.target.closest('[data-id]');
    if (!b) return;
    b.classList.toggle('on');
    b.setAttribute('aria-pressed', b.classList.contains('on'));
    patchAuto({ allowed: $$('.ro-allowed .on', node).map((x) => x.dataset.id) });
  };
  bus.on('router', paintAuto, { node });

  // The one-line summaries; painted again on the way back from a view that may have changed them.
  const paintHints = () => {
    const r = S.config.recipes?.length || 0;
    const all = S.config.triggers || [];
    const t = all.filter((x) => x.enabled).length;
    $('.recipe-hint', node).textContent = r ? `${r} saved prompt${r === 1 ? '' : 's'}` : 'None yet · save a prompt you run often';
    $('.trigger-hint', node).textContent = all.length ? `${t} of ${all.length} on` : 'None yet · run a recipe on a schedule, CI failure or new issue';
    api('/usage?days=7')
      .then((u) => {
        const x = u.total;
        $('.sx-usage', node).innerHTML = `
          <div><span>Spend</span><b>${x.priced ? money(x.cost) : '—'}</b></div>
          <div><span>Turns</span><b>${x.turns}</b></div>
          <div><span>Worked</span><b>${pct(x.successRate)}</b></div>
          <div><span>Questions</span><b>${x.questions}</b></div>`;
      })
      .catch(() => ($('.sx-usage', node).innerHTML = ''));
    $('.machines-hint', node).textContent = machinesSummary();
    api('/remote').then((x) => ($('.phone-hint', node).textContent = phoneSummary(x) === 'Off' ? 'ntfy or Telegram: answer questions from your phone' : phoneSummary(x))).catch(() => {});
    paintLearn();
    paintAuto();
  };
  paintHints();
  bus.on('machines', () => ($('.machines-hint', node).textContent = machinesSummary()), { node });
  $('#openRouter', node).onclick = () => openRouter({ host: host('auto') });
  $('#openMemory', node).onclick = () => openMemory({ host: host('memory') });
  $$('[data-auto]', node).forEach((b) => (b.onclick = () => openAutomations({ tab: b.dataset.auto, host: host('automations') })));
  // Settings a spell sets are locked while it's on: the row says which spell, and links to Spells.
  const LOCKABLE = { view: '.view-seg', transcript: '#txDefault', worktree: '#wtDefault', fixConflicts: '#fixConflicts', learn: '#learn', editor: 'select[name="editor"]', notify: '#notif' };
  const paintLocks = () => {
    for (const n of $$('.sp-lock', node)) n.remove();
    for (const [key, sel] of Object.entries(LOCKABLE)) {
      const ctl = $(sel, node);
      if (!ctl) continue;
      const by = S.config.lockedBy?.[key];
      ctl.disabled = !!by;
      if (by) $('.sx-text', ctl.closest('.sx-row'))?.insertAdjacentHTML('beforeend', `<small class="sp-lock">${icon('wizard')}Set by the spell <b>${esc(by.name)}</b> · <button class="link xs" data-pane-go="spells">Spells</button></small>`);
    }
  };
  paintLocks();
  bus.on('config', paintLocks, { node });
  node.addEventListener('click', (e) => {
    if (e.target.closest('[data-pane-go]')) show(e.target.closest('[data-pane-go]').dataset.paneGo);
  });
  $('#openUsage', node).onclick = () => openUsage({ days: 7, host: host('usage') });
  $('#openPhone', node).onclick = () => openPhone({ host: host('notifications') });
  $('#openMachines', node).onclick = () => openMachines({ host: host('machines') });
}

// Say once that anonymous stats are on, with a way out.
export function telemetryNotice() {
  if (!S.config.telemetry?.enabled || S.config.defaults.telemetryNotice === 'seen') return;
  S.config.defaults.telemetryNotice = 'seen';
  api('/config', { method: 'PATCH', body: { defaults: { telemetryNotice: 'seen' } } }).catch(() => {});
  toast('wisp sends anonymous usage stats and error reports. No prompts, paths or code.', { timeout: 10_000, action: { label: 'Settings', run: () => openSettings({ pane: 'privacy' }) } });
}
