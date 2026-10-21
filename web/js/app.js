// wisp's page: the launcher on top, every session in a feed under it. This file wires the top bar,
// timers and links, and boots; the rest lives in core/ (state, api, events), ui/ (toasts, dialogs,
// popovers) and features/.

import { fmtDuration } from './blocks.js';
import { api } from './core/api.js';
import * as bus from './core/bus.js';
import { $, $$ } from './core/dom.js';
import { ago } from './core/format.js';
import { MOBILE, S, save, setAgents } from './core/state.js';
import { combo } from './ui/kbd.js';
import { openAutomations } from './features/automations.js';
import { openPalette } from './features/commands.js';
import { renderFeed, reveal, scheduleRefetch } from './features/feed.js';
import { renderLauncher } from './features/launcher.js';
import { recall, startShell, syncing } from './features/cache.js';
import { connect, loadConfig, loadSessions, setConfig } from './features/live.js';
import { loadMachines, openMachines, setMachines } from './features/machines.js';
import { askNotify } from './features/notify.js';
import { onKey } from './features/keys.js';
import { backToTop, onScroll, stage } from './features/scroll.js';
import { openSettings, telemetryNotice } from './features/settings.js';
import { installUpdate, loadUpdate } from './features/update.js';
import { routeSpell } from './features/spell-ui.js';
import './features/spells.js';

document.addEventListener('keydown', onKey);
stage.addEventListener('scroll', onScroll, { passive: true });
$('#toTop').onclick = backToTop;

// Top bar and the feed's Done / Archived toggles.
$('#settingsBtn').onclick = openSettings;
$('#searchBtn').onclick = openPalette;
$('#machinesBtn').onclick = () => openMachines();
$('#autoBtn').onclick = () => openAutomations({ tab: (S.config.triggers || []).length && !(S.config.recipes || []).length ? 'triggers' : 'recipes' });
$('#updateBtn').onclick = installUpdate;
$('#searchBtn').title = `Search (${combo('K')})`;
$('#searchBtn .mod-k').textContent = combo('K');
$('#secDone .toggle-done').onclick = () => {
  S.showDone = !S.showDone;
  save('wisp.showDone', S.showDone);
  renderFeed();
};
$('#secArchived .toggle-done').onclick = () => {
  S.showArchived = !S.showArchived;
  renderFeed();
};

// elapsed timers + "ago" stamps
setInterval(() => {
  $$('.elapsed[data-start]').forEach((n) => (n.textContent = fmtDuration(Date.now() - Number(n.dataset.start))));
}, 1000);
setInterval(() => {
  for (const [id, n] of S.nodes) {
    const s = S.sessions.get(id);
    const t = s && $('.q-time', n.head);
    if (t) t.textContent = ago(s.updatedAt);
  }
  const head = $('#splitHead:not([hidden])');
  const open = head && S.sessions.get(head.dataset.id);
  if (open) $('.sh-meta .q-time', head).textContent = ago(open.updatedAt);
}, 30000);

if (/Electron/.test(navigator.userAgent)) document.body.classList.add('electron', /Mac/.test(navigator.platform) ? 'mac' : 'other');
if (MOBILE) document.body.classList.add('wisp-mobile');

// #/s/<id> still works (notifications, CLI): it reveals that item in the feed.
function route() {
  if (routeSpell()) return; // #/spell?src=…: a shared spell to review
  const m = location.hash.match(/^#\/s\/(\w+)/);
  if (!m) return;
  history.replaceState(null, '', '#/');
  reveal(m[1]);
}

window.addEventListener('hashchange', route);
window.addEventListener('focus', () => {
  loadUpdate();
  for (const id of S.open) if (S.sessions.get(id)?.unread) scheduleRefetch(id);
});

// The phone first paints what it saw last time (features/cache.js): tasks, open tasks and settings
// show at once while the tunnel brings the real ones, which replace them in place.
function paintSnapshot(snap) {
  setConfig(snap.config);
  setMachines(snap.machines || [], { quiet: true });
  S.sessions = new Map(snap.sessions.map((s) => [s.id, s]));
  for (const [id, s] of snap.full || []) if (S.open.has(id)) S.full.set(id, s);
  renderFeed();
  renderLauncher();
  bus.emit('agents');
}

// The launcher paints as soon as config and machines are in (local, fast), from the last harness
// list seen. Detecting harnesses can take seconds on a cold start: it repaints the launcher when
// it lands, only if the list changed.
(async () => {
  const snap = recall();
  if (snap?.config && snap.sessions) {
    paintSnapshot(snap);
    syncing(true);
  }
  const agents = api('/agents').catch(() => null);
  const sessions = loadSessions();
  sessions.catch(() => {}); // awaited below, unless the loads before it fail
  const painted = snap && JSON.stringify([S.config, S.machines]);
  try {
    await Promise.all([loadConfig(), loadMachines()]);
    if (JSON.stringify([S.config, S.machines]) !== painted) {
      renderLauncher();
      bus.emit('agents');
    }
    if (!snap) $('#prompt')?.focus();
    await sessions;
    syncing(false);
  } catch {
    // The phone's tunnel isn't back yet (the page came from its cache): the live stream retries,
    // and its `hello` loads everything.
  }
  connect();
  route();
  telemetryNotice();
  if (MOBILE) {
    askNotify(); // alerts are what the phone is for: ask once, on the first visit
    startShell();
  }
  const list = await agents;
  if (!list || JSON.stringify(list) === JSON.stringify(S.agents)) return;
  setAgents(list);
  renderLauncher();
  bus.emit('agents');
})();
