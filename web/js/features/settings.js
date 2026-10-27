// Settings: a sidebar of sections and one pane at a time, like every other app's settings. Big lists
// (memory, automations, usage history) keep their own views; a pane only summarises and links.

import { esc } from '../md.js';
import { copy } from '../blocks.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, $$, el, icon } from '../core/dom.js';
import { money, pct } from '../core/format.js';
import { COMPUTER, MOBILE, S, inGrid, setAgents } from '../core/state.js';
import { overlay } from '../ui/overlay.js';
import { toast, toastError, tryApi } from '../ui/toast.js';
import { openRouter } from './auto.js';
import { openAutomations } from './automations.js';
import { renderLauncher } from './launcher.js';
import { loadConfig } from './live.js';
import { openComputers, openMachines } from './machines.js';
import { cloudPane, connectHtml, mountGridHere } from './cloud.js';
import { loginControl, loginPanel, typingLogin, wireLogins } from './agent-login.js';
import { accountCount, accountsHtml, gridAccountsNote, manyAccounts, wireAccounts } from './accounts.js';
import { memorySummary, openMemory, setLearning } from './memory.js';
import { notifyOn, notifyPermission, requestNotify } from './notify.js';
import { openPhone, phoneSummary } from './phone.js';
import { paintReachable, reachableBox, reachableHtml } from './reachable.js';
import { machinesSummary } from './places.js';
import { AUTO_GOALS, agentsAt, harnessLogo } from './runners.js';
import { copySetupCommand, INSTALLABLE, installHarness, isInstalling, loadTools, setupCommand, setupDocs, setupTip, tools } from './setup.js';
import { clearPicks } from './transcript.js';
import { repaintViews } from './turns.js';
import { openUsage } from './usage.js';
import { HOLD_DEFAULT, HOLD_LINES } from '../limit-hold.js';
import { crewRecord } from './crew-record.js';
import { crewList } from './crew.js';
import { connectorsPane } from './connectors.js';
import { budgetHtml, stopAt, STOP_AT } from './budget.js';
import { reveal } from './feed.js';
import { spellsPane } from './spell-ui.js';
import { setTheme, themePref } from './theme.js';
import { loadUpdate, updateState } from './update.js';

// A sidebar of sections and one pane at a time, like every other app's settings. Big lists
// (memory, automations, usage history) keep their own views; a pane only summarises and links.
// On a wisp Grid, Machines becomes Connect (the grid, not SSH) and Cloud goes: wisp is in the cloud.
// Which releases wisp updates to; the server reads them in server/update.js (CHANNELS).
const UPDATE_CHANNELS = [['stable', 'Stable'], ['beta', 'Beta'], ['nightly', 'Nightly']];
const CHANNEL_HINTS = { stable: 'Tested releases', beta: 'Previews of the next release (npm <code>next</code>), then the release itself', nightly: 'A build of main every night (npm <code>nightly</code>). Newest, and sometimes broken' };

const settingsPanes = (grid = inGrid()) => [
  { id: 'general', label: 'General', icon: 'settings', lede: 'Where files open, where you take over, and how tasks start.' },
  { id: 'notifications', label: 'Notifications', icon: 'bell', lede: 'Hear about questions and finished tasks, here or on your phone.' },
  { id: 'agents', label: 'Agents', icon: 'agent', lede: 'The harnesses wisp found on this machine. Pick one next to the model in the launcher.' },
  { id: 'connectors', label: 'Connectors', icon: 'plug', lede: "MCP servers every task's agent can use, whatever the harness." },
  { id: 'auto', label: 'Auto', icon: 'spark', lede: 'wisp picks the harness and model for each task, and learns from how it went.' },
  MOBILE
    ? { id: 'machines', label: 'Computers', icon: 'server', lede: 'The computers this phone opens wisp on.' }
    : grid
      ? { id: 'machines', label: 'Connect', icon: 'cloud', lede: 'Open this cloud computer from your desktop, your phone or any browser. It goes through the grid: no SSH.' }
      : { id: 'machines', label: 'Machines', icon: 'server', lede: 'Other computers that run agents for you, over SSH.' },
  // The phone app adds cloud computers on its own list instead.
  ...(MOBILE || grid ? [] : [{ id: 'cloud', label: 'Cloud', icon: 'cloud', lede: 'Your wisp on a server: it keeps working while this computer sleeps.' }]),
  { id: 'memory', label: 'Memory', icon: 'text', lede: "Learned from your tasks and added to every agent's prompt. What you ask always wins." },
  { id: 'automations', label: 'Automations', icon: 'bolt', lede: 'Saved prompts, and the triggers that launch them for you.' },
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
  const SETTINGS_PANES = settingsPanes();
  const grid = S.config.grid;
  if (SETTINGS_PANES.some((p) => p.id === opts?.pane)) settingsPane = opts.pane;
  if (!SETTINGS_PANES.some((p) => p.id === settingsPane)) settingsPane = 'general';
  const d = S.config.defaults;
  // A row: name and a line of explanation on the left, the control on the right.
  const row = (name, desc, control, cls = '') => `<div class="sx-row ${cls}"><div class="sx-text"><b>${name}</b>${desc ? `<small>${desc}</small>` : ''}</div><div class="sx-ctl">${control}</div></div>`;
  const missing = S.agents.filter((a) => !a.available).length;
  const node = el(`
    <div class="modal settings-modal sx">
      <nav class="sx-nav" role="tablist" aria-orientation="vertical">
        <h2>Settings</h2>
        ${SETTINGS_PANES.map((p) => `<button role="tab" data-pane="${p.id}">${icon(p.icon)}<span>${p.label}</span>${p.id === 'agents' && missing ? `<i class="dot bad" title="${missing} not found"></i>` : ''}${icon('chevron')}</button>`).join('')}
      </nav>
      <header class="sx-top">
        <h2 class="sx-home">Settings</h2>
        <button class="icon-btn sx-up" title="All settings" aria-label="All settings">${icon('back')}</button>
        <h3 class="sx-title"></h3>
        <button class="icon-btn close" title="Close" aria-label="Close settings">${icon('x')}</button>
      </header>
      <div class="sx-main">
        <p class="sx-lede"></p>
        <section class="sx-pane" data-pane="general">
          <div class="sx-group">
            ${row('Open files in', 'File links in cards and diffs', `<select name="editor">${[['vscode', 'VS Code'], ['cursor', 'Cursor'], ['windsurf', 'Windsurf'], ['zed', 'Zed'], ['idea', 'JetBrains'], ['none', 'Copy path']]
              .map(([v, l]) => `<option value="${v}" ${d.editor === v || (!d.editor && v === 'vscode') ? 'selected' : ''}>${l}</option>`)
              .join('')}</select>`)}
            ${(S.config.terminals || []).length > 1 && !MOBILE ? row('Take over in', 'Where you carry on a task yourself: a terminal inside wisp, or a terminal app', `<select name="terminal">${S.config.terminals.map((t) => `<option value="${t.id}" ${(d.terminal || S.config.defaultTerminal || 'auto') === t.id ? 'selected' : ''}>${t.label}</option>`).join('')}</select>`) : ''}
            <div class="sx-row custom-term" ${d.terminal === 'custom' ? '' : 'hidden'}><div class="sx-text"><b>Terminal command</b><small><code>{cwd}</code> and <code>{cmd}</code> are filled in</small></div>
              <div class="sx-ctl"><input class="input mono" name="terminalCommand" value="${esc(d.terminalCommand || '')}" placeholder="alacritty --working-directory {cwd} -e {cmd}" spellcheck="false"></div></div>
          </div>
          <div class="sx-group">
            ${row('Worktree per task', 'Each task gets its own branch from origin/main, in git repos', '<button class="switch" id="wtDefault" role="switch"></button>')}
            ${row('Auto-fix PR conflicts', 'Without waiting for a click on Fix conflicts: when a shipped PR conflicts with its base, the task merges the base in, resolves it and pushes', '<button class="switch" id="fixConflicts" role="switch"></button>')}
            ${row('Read times in prompts', 'A prompt that starts with a time (“in 5 min …”, “tomorrow at 9 …”) or says “remind me … in 1 hour” is scheduled for then. A chip under the box shows the time before you send', '<button class="switch" id="readTimes" role="switch"></button>')}
            ${row('Interactive answers', 'Agents may answer with a small page you use in place, like a slider with a live preview or a list to pick from. It runs sandboxed, with no network, and sends nothing until you click Send', '<button class="switch" id="appsOn" role="switch"></button>')}
          </div>
          <div class="sx-group">
            ${row('Theme', 'System follows your computer’s light or dark setting', `<fieldset class="pk-seg theme-seg">${[['system', 'laptop', 'System'], ['light', 'sun', 'Light'], ['dark', 'moon', 'Dark']].map(([v, i, l]) => `<button type="button" data-v="${v}">${icon(i)}${l}</button>`).join('')}</fieldset>`)}
          </div>
          <div class="sx-group">
            ${row('Full transcript', 'Every message and step the agent took, with its presentation at the end. Any one card switches with its Transcript button<span class="key-hint"> or <kbd>V</kbd></span>', '<button class="switch" id="txDefault" role="switch"></button>')}
          </div>
          <div class="sx-group sx-updates">
            ${row('Updates', '<span class="upd-hint"></span>', `<select name="updateChannel">${UPDATE_CHANNELS.map(([v, l]) => `<option value="${v}" ${(d.updateChannel || 'stable') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
          </div>
        </section>
        <section class="sx-pane" data-pane="notifications">
          <div class="sx-group">
            ${row(MOBILE ? 'Notifications' : 'Desktop notifications', '<span class="notif-hint"></span>', '<button class="switch" id="notif" role="switch"></button>')}
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
        <section class="sx-pane" data-pane="connectors"><div class="cx-box"></div></section>
        <section class="sx-pane" data-pane="auto">
          <div class="sx-group">
            ${row('Goal', 'What Auto optimises for. Also in the launcher, next to Auto', `<span class="pk-seg ro-goal">${AUTO_GOALS.map((g) => `<button data-goal="${g.id}" title="${esc(g.hint)}">${g.label}</button>`).join('')}</span>`)}
            ${row('Try new models', 'A new model or harness gets a few tasks that aren’t marked important before Auto relies on it', '<button class="switch" id="roExplore" role="switch"></button>')}
            ${row('Harnesses it may use', 'Leave all off to let Auto use every one you have. A computer with none of these on uses what it has', '<span class="ro-allowed"></span>')}
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
          ${
            MOBILE
              ? `<div class="sx-group">${row('Computers', `You’re on ${esc(COMPUTER || 'this computer')}. Switch to another computer, or add one, from the app’s list.`, '<button class="ghost sm" id="openComputers">Your computers</button>')}</div>`
              : grid
                ? connectHtml(grid, row)
                : `          <div class="sx-group">
            ${row('Machines', '<span class="machines-hint"></span>', '<button class="ghost sm" id="openMachines">Manage</button>')}
          </div>
          <p class="hint">Also in the top bar. Every project runs on every machine: pick one under Run on and wisp clones the project there the first time. A follow-up or a rerun can move a task to another one.</p>
          <section class="sx-group mc-grid"></section>
          <div class="sx-head"><div><b>This computer over SSH</b><small>What another computer, or the wisp phone app, needs to connect here over SSH</small></div><button class="ghost sm" id="reachRecheck">${icon('replay')}Re-check</button></div>
          ${reachableHtml()}
`
          }
        </section>
        ${MOBILE ? '' : '<section class="sx-pane" data-pane="cloud"><div class="sx-cloud"></div></section>'}
        <section class="sx-pane" data-pane="memory">
          <div class="sx-group">
            ${row('Learn from tasks', 'A short retro after each task keeps preferences and lessons', '<button class="switch" id="learn" role="switch"></button>')}
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
          <div class="sx-group">${row('Charts and breakdowns', 'Per day, per project and per harness · model', '<button class="ghost sm" id="openUsage">Open usage</button>')}${crewList().length ? row('Crew track record', 'How each member did: jobs, finished, check-ins, spend', '<button class="ghost sm" id="openRecord">Open</button>') : ''}</div>
          <div class="sx-head"><div><b>Plan budget</b><small>Your plans’ usage windows, as Claude Code and Codex report them on each run</small></div></div>
          <div class="sx-group sx-budget">
            <div class="bg-list"></div>
            ${row('Automations stop at', 'Check-ins, triggers, goal rounds and agents’ own follow-ups wait once an account passes this much of a window, and go on after it resets. What you start always runs', `<fieldset class="pk-seg us-stop" aria-label="Automations stop at">${STOP_AT.map((v) => `<button type="button" data-v="${v}">${v === 'off' ? 'Off' : `${v}%`}</button>`).join('')}</fieldset>`)}
            ${row('Ask near the limit', 'Before a task would take a 5-hour or weekly window past this, wisp asks first. Scheduled runs and crew jobs wait in Needs you', `<span class="pk-seg hold-seg">${HOLD_LINES.map((v) => `<button type="button" data-v="${v}">${v === 'off' ? 'Off' : `${v}%`}</button>`).join('')}</span>`)}
            ${row('Wait for the reset', 'At a usage limit, the task waits under Scheduled and carries on in the same conversation when the window resets. Off: it stops and asks you', '<button class="switch" id="limitWait" role="switch"></button>')}
          </div>
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
  $('.sx-top .close', node).onclick = close;
  // On a phone the sections are a list first and a pane opens over it (CSS shows one or the
  // other under 640px); an explicit pane, like a toast's "Settings" link, opens straight to it.
  const toList = (on) => {
    node.classList.toggle('at-list', on);
    if (!on) $('.sx-main', node).scrollTop = 0; // it was hidden, so pick() couldn't reset it
  };
  toList(!opts?.pane);
  $('.sx-up', node).onclick = () => {
    leave();
    toList(true);
    $(`.sx-nav [data-pane="${settingsPane}"]`, node)?.focus({ preventScroll: true });
  };
  spellsPane($('[data-pane="spells"].sx-pane', node));
  // force: a repaint the person asked for (an account added, renamed); a background one waits while
  // a code is pasted or an account named, since it would wipe what's typed.
  const paintAgents = (force) => {
    const box = $('.sx-agents', node);
    if (force !== true && (typingLogin(box) || document.activeElement?.closest?.('[data-acc-rename]'))) return;
    box.innerHTML = gridAccountsNote() + (S.agents.length
      ? S.agents.map((a) => {
        const n = (a.models || []).filter((m) => m.id).length;
        // opencode: wisp can install it (free models, no account), so its row offers that.
        const canInstall = !a.available && INSTALLABLE.has(a.id);
        const busy = isInstalling(a.id);
        // Not found: this OS's setup tip, with the command to copy unless wisp installs it itself.
        const out = !a.available && a.signedIn === false; // installed, signed out: hidden from the picker
        const desc = a.available || out
          ? esc([a.version, out ? 'Sign in to use it' : n && `${n} model${n === 1 ? '' : 's'}`, a.hasKey === false && 'free models only', accountCount(a)].filter(Boolean).join(' · '))
          : busy ? 'Installing into ~/.wisp/tools…' : `${esc(setupTip(a))}${a.setup?.command && !canInstall ? setupCommand(a.setup.command) : ''}`;
        const install = canInstall ? `<button class="ghost sm" data-install="${esc(a.id)}" ${busy ? 'disabled' : ''}>${busy ? 'Installing…' : 'Install'}</button>` : '';
        const docs = a.available || out ? '' : setupDocs(a);
        const state = a.available ? ['ok', 'Ready'] : out ? ['warn', 'Signed out'] : ['bad', 'Not found'];
        // Several accounts: each signs in on its own row, so the harness row only says how it is.
        const many = manyAccounts(a);
        return row(`<span class="model-logo">${harnessLogo(a.id)}</span>${esc(a.name)}`, desc, `${install}${docs}${(a.available || out) && !many ? loginControl(a.id) : ''}<span class="sx-state ${state[0]}" ${a.error ? `title="${esc(a.error)}"` : ''}><i class="dot ${state[0]}"></i>${state[1]}</span>`) + ((a.available || out) && !many ? loginPanel(a.id) : '') + accountsHtml(a);
      }).join('')
      : '<div class="sx-row"><div class="it-loading"><span class="orb tiny"></span>Looking for harnesses…</div></div>');
    // git and GitHub: not harnesses, but what Ship it commits, pushes and opens pull requests with.
    // Missing: how to get them on this OS, as for a harness that isn't found. Home's pinned tip
    // scrolls to the first .sx-tool.
    const notFound = '<span class="sx-state bad"><i class="dot bad"></i>Not found</span>';
    const howTo = (name, setup) => [`${esc(setup.tip)}${setupCommand(setup.command)}`, `${setupDocs({ name, setup })}${notFound}`];
    if (tools && !tools.git.installed) $('.sx-agents', node).insertAdjacentHTML('beforeend', row(`<span class="model-logo">${icon('branch')}</span>git`, ...howTo('git', tools.git.setup), 'sx-tool'));
    $('.sx-agents', node).insertAdjacentHTML(
      'beforeend',
      tools && !tools.gh.installed
        ? row(`<span class="model-logo">${icon('github')}</span>GitHub`, ...howTo('GitHub CLI', tools.gh.setup), 'sx-tool')
        : row(`<span class="model-logo">${icon('github')}</span>GitHub`, 'For pushing branches and opening pull requests (the gh CLI)', loginControl('gh'), 'sx-tool') + loginPanel('gh'),
    );
    const missing = S.agents.filter((a) => !a.available).length;
    const dot = $('.sx-nav [data-pane="agents"] .dot', node);
    if (dot && !missing) dot.remove();
    if (!dot && missing) $('.sx-nav [data-pane="agents"]', node).insertAdjacentHTML('beforeend', `<i class="dot bad" title="${missing} not found"></i>`);
    const online = S.machines.filter((m) => m.state === 'online').length;
    $('.recheck-hint', node).textContent = `After installing a CLI, signing in or adding a provider, look for harnesses and models again${online ? `, here and on ${online} machine${online === 1 ? '' : 's'}` : ''}`;
  };
  paintAgents();
  // Each extra account signs in on its own (`claude@k3f9`).
  const signIns = wireLogins($('.sx-agents', node), () => [['', [...S.agents.filter((a) => a.available || a.signedIn === false).flatMap((a) => [a.id, ...(manyAccounts(a) ? a.accounts.filter((x) => x.id !== 'default').map((x) => `${a.id}@${x.id}`) : [])]), 'gh']]]);
  wireAccounts($('.sx-agents', node), () => paintAgents(true), signIns);
  bus.on('agents', () => paintAgents(), { node });
  bus.on('install', paintAgents, { node });
  // gh found since (installed in a terminal): its sign-in state, for the Sign in button.
  let ghFound = tools?.gh.installed;
  bus.on(
    'tools',
    () => {
      paintAgents();
      if (tools.gh.installed && !ghFound) signIns.reload();
      ghFound = tools.gh.installed;
    },
    { node },
  );
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
      const [agents] = await Promise.all([api('/agents/recheck', { method: 'POST', body: {} }), loadTools()]);
      setAgents(agents);
      bus.emit('agents'); // this pane, the launcher's setup strip and home's setup tip
      if (!node.isConnected) return;
      $('#launcher')?.placesChanged?.();
      toast(recheckSummary(before, S.agents));
    } catch (err) {
      toastError(err);
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy');
    }
  };
  let reachChecked = false;
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
    node.dataset.pane = id;
    $('.sx-lede', node).textContent = p.lede;
    $('.sx-main', node).scrollTop = 0;
    // Checked when the pane opens: it knocks on the SSH port and asks tailscale.
    if (id === 'machines' && !reachChecked && !MOBILE && !grid) {
      reachChecked = true;
      paintReachable(reachableBox(node));
    }
  };
  // Memory, Automations, Usage and Phone open in the main area, next to the sidebar, with a
  // way back to the section they came from. Leaving one goes back; only the X closes Settings.
  const main = $('.sx-main', node);
  const leave = () => {
    const v = $('.sx-main > .embedded', node);
    if (!v) return;
    v.remove();
    $('.sx-top', node).hidden = false;
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
    $('.sx-top', node).hidden = true;
    toList(false);
    $$('.sx-pane', node).forEach((s) => (s.hidden = true));
    main.append(view);
    main.scrollTop = 0;
    return close;
  };
  $('.sx-nav', node).onclick = (e) => {
    const b = e.target.closest('[data-pane]');
    if (!b) return;
    show(b.dataset.pane);
    toList(false);
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
    const perm = notifyPermission();
    const on = notifyOn();
    sw.setAttribute('aria-checked', on);
    sw.disabled = perm === 'denied' || perm === 'unsupported';
    const blocked = MOBILE ? 'Blocked: allow notifications for wisp in Android settings' : 'Blocked — allow notifications for this site in your browser';
    $('.notif-hint', node).textContent = perm === 'denied' ? blocked : perm === 'unsupported' ? 'Not supported here' : on ? 'On' : 'Off';
  };
  sw.onclick = async () => {
    let want = !notifyOn();
    if (want && notifyPermission() !== 'granted') want = (await requestNotify()) === 'granted';
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
  // Updates: what the channel means, and when this copy can't follow it.
  const paintUpd = () => {
    const u = updateState();
    const ch = $('select[name="updateChannel"]', node).value;
    const why = !u ? '' : u.method === 'git' ? 'A git clone doesn’t update itself' : u.method === 'brew' ? 'Homebrew only has stable releases' : u.enabled === false ? 'Update checks are off here (WISP_UPDATE_CHECK=0 or CI)' : '';
    $('.upd-hint', node).innerHTML = `${CHANNEL_HINTS[ch]}${why ? `. ${why}` : ''}${u?.current ? `. You’re on ${esc(u.current)}` : ''}`;
  };
  paintUpd();
  loadUpdate().then(paintUpd);
  $('select[name="updateChannel"]', node).addEventListener('change', paintUpd);
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
  // Plan budget: the windows repaint with the harness list; the switch is instant, rolled back on a refusal.
  // Only what changed is written: a repaint on every 'agents' would restart the bars' fill.
  const paintBudget = () => {
    const list = $('.bg-list', node);
    const html = budgetHtml(S.agents);
    if (list.dataset.h !== html) (list.innerHTML = html), (list.dataset.h = html);
    list.hidden = !html;
    const stop = stopAt();
    list.classList.toggle('stops', !!stop);
    list.style.setProperty('--stop', stop ? `${stop * 100}%` : '');
  };
  paintBudget();
  bus.on('agents', paintBudget, { node });
  // A task in Where it went opens it.
  $('.bg-list', node).addEventListener('click', (e) => {
    const t = e.target.closest('[data-session]');
    if (!t) return;
    close();
    reveal(t.dataset.session);
  });
  // Automations stop at: instant, the bars' marks with it; rolled back on a refusal.
  const paintStop = () => {
    const v = STOP_AT.includes(S.config.defaults.autoStop) ? S.config.defaults.autoStop : 'off';
    $$('.us-stop button', node).forEach((b) => {
      b.classList.toggle('on', b.dataset.v === v);
      b.setAttribute('aria-pressed', b.dataset.v === v);
    });
    paintBudget();
  };
  $('.us-stop', node).onclick = async (e) => {
    const b = e.target.closest('[data-v]');
    const was = S.config.defaults.autoStop || 'off';
    if (!b || b.dataset.v === was) return;
    S.config.defaults.autoStop = b.dataset.v;
    paintStop();
    const saved = await tryApi(() => api('/config', { method: 'PATCH', body: { defaults: { autoStop: b.dataset.v } } }));
    if (!saved) {
      S.config.defaults.autoStop = was;
      paintStop();
    }
  };
  paintStop();
  bus.on('config', paintStop, { node });
  // Ask near the limit (features/hold.js): instant, rolled back on a refusal. The bars repaint with
  // the line (budget.js tone), and the harness list brings the new lines on its next broadcast.
  const holdSetting = () => (HOLD_LINES.includes(S.config.defaults.limitHold) ? S.config.defaults.limitHold : HOLD_DEFAULT);
  const paintHold = () => $$('.hold-seg button', node).forEach((b) => b.classList.toggle('on', b.dataset.v === holdSetting()));
  $$('.hold-seg button', node).forEach((b) => {
    b.onclick = async () => {
      const was = S.config.defaults.limitHold;
      if (b.dataset.v === holdSetting()) return;
      S.config.defaults.limitHold = b.dataset.v;
      paintHold();
      paintBudget();
      const saved = await tryApi(() => api('/config', { method: 'PATCH', body: { defaults: { limitHold: b.dataset.v } } }));
      if (!saved) {
        S.config.defaults.limitHold = was;
        paintHold();
        paintBudget();
        return;
      }
      api('/agents').then((list) => (setAgents(list), bus.emit('agents')), () => {});
    };
  });
  paintHold();
  const lw = $('#limitWait', node);
  const paintLw = () => lw.setAttribute('aria-checked', S.config.defaults.limitWait === 'on');
  lw.onclick = async () => {
    const was = S.config.defaults.limitWait;
    S.config.defaults.limitWait = was === 'on' ? 'off' : 'on';
    paintLw();
    const saved = await tryApi(() => api('/config', { method: 'PATCH', body: { defaults: { limitWait: S.config.defaults.limitWait } } }));
    if (!saved) {
      S.config.defaults.limitWait = was;
      paintLw();
    }
  };
  paintLw();
  const rt = $('#readTimes', node);
  const paintRt = () => rt.setAttribute('aria-checked', S.config.defaults.readTimes !== 'off');
  rt.onclick = async () => {
    const was = S.config.defaults.readTimes;
    S.config.defaults.readTimes = was === 'off' ? 'on' : 'off';
    paintRt();
    const saved = await tryApi(() => api('/config', { method: 'PATCH', body: { defaults: { readTimes: S.config.defaults.readTimes } } }));
    if (!saved) {
      S.config.defaults.readTimes = was;
      paintRt();
    }
  };
  paintRt();
  const ap = $('#appsOn', node);
  const paintAp = () => ap.setAttribute('aria-checked', S.config.defaults.apps !== 'off');
  ap.onclick = async () => {
    const was = S.config.defaults.apps;
    S.config.defaults.apps = was === 'off' ? 'on' : 'off';
    paintAp();
    const saved = await tryApi(() => api('/config', { method: 'PATCH', body: { defaults: { apps: S.config.defaults.apps } } }));
    if (!saved) {
      S.config.defaults.apps = was;
      paintAp();
    }
  };
  paintAp();
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
  // Theme: switches at once, and back if the save is refused.
  const paintTheme = () => $$('.theme-seg button', node).forEach((b) => b.classList.toggle('on', b.dataset.v === themePref()));
  $$('.theme-seg button', node).forEach((b) => {
    b.onclick = () => {
      setTheme(b.dataset.v);
      paintTheme();
    };
  });
  paintTheme();
  bus.on('theme', paintTheme, { node });
  bus.on('config', paintTheme, { node });
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
    // Installed here or on a machine that's online: Auto runs on machines too.
    const anywhere = [...S.agents, ...S.machines.flatMap((m) => agentsAt(m.id) || [])].filter((a) => a.available || allowed.includes(a.id));
    $('.ro-allowed', node).innerHTML = [...new Map(anywhere.map((a) => [a.id, a])).values()]
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
    if (!MOBILE && !grid) $('.machines-hint', node).textContent = machinesSummary();
    api('/remote').then((x) => ($('.phone-hint', node).textContent = phoneSummary(x) === 'Off' ? 'ntfy or Telegram: answer questions from your phone' : phoneSummary(x))).catch(() => {});
    paintLearn();
    paintAuto();
  };
  paintHints();
  if (!MOBILE && !grid) bus.on('machines', () => ($('.machines-hint', node).textContent = machinesSummary()), { node });
  connectorsPane($('.cx-box', node), host('connectors'));
  $('#openRouter', node).onclick = () => openRouter({ host: host('auto') });
  $('#openMemory', node).onclick = () => openMemory({ host: host('memory') });
  $$('[data-auto]', node).forEach((b) => (b.onclick = () => openAutomations({ tab: b.dataset.auto, host: host('automations') })));
  // Settings a spell sets are locked while it's on: the row says which spell, and links to Spells.
  const LOCKABLE = { theme: '.theme-seg', transcript: '#txDefault', worktree: '#wtDefault', fixConflicts: '#fixConflicts', apps: '#appsOn', readTimes: '#readTimes', learn: '#learn', editor: 'select[name="editor"]', terminal: 'select[name="terminal"]', notify: '#notif', limitWait: '#limitWait', autoStop: '.us-stop', limitHold: '.hold-seg' };
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
    if (e.target.closest('[data-pane-go]')) show(e.target.closest('[data-pane-go]').dataset.paneGo), toList(false);
  });
  $('#openUsage', node).onclick = () => openUsage({ days: 7, host: host('usage') });
  if ($('#openRecord', node)) $('#openRecord', node).onclick = () => crewRecord({ host: host('usage') });
  $('#openPhone', node).onclick = () => openPhone({ host: host('notifications') });
  if (MOBILE) {
    $('#openComputers', node).onclick = () => {
      openComputers();
    };
  } else {
    if (grid) {
      $('#copyAddress', node).onclick = (e) => {
        copy(grid.address, e.currentTarget);
      };
    } else {
      $('#openMachines', node).onclick = () => openMachines({ host: host('machines') });
      cloudPane($('.sx-cloud', node));
      // This computer on your wisp Grid, as in Machines: phones and other computers reach it there.
      mountGridHere($('.mc-grid', node));
      $('#reachRecheck', node).onclick = () => {
        paintReachable(reachableBox(node));
      };
    }
  }
}

// Say once that anonymous stats are on, with a way out.
export function telemetryNotice() {
  if (!S.config.telemetry?.enabled || S.config.defaults.telemetryNotice === 'seen') return;
  S.config.defaults.telemetryNotice = 'seen';
  api('/config', { method: 'PATCH', body: { defaults: { telemetryNotice: 'seen' } } }).catch(() => {});
  toast('wisp sends anonymous usage stats and error reports. No prompts, paths or code.', { timeout: 10_000, action: { label: 'Settings', run: () => openSettings({ pane: 'privacy' }) } });
}
