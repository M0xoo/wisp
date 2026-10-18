// wisp's page: the launcher on top, every session in a feed under it. This file wires the top bar,
// timers and links, and boots; the rest lives in core/ (state, api, events), ui/ (toasts, dialogs,
// popovers) and features/.

import { fmtDuration } from './blocks.js';
import { api } from './core/api.js';
import * as bus from './core/bus.js';
import { $, $$ } from './core/dom.js';
import { ago } from './core/format.js';
import { S, save } from './core/state.js';
import { combo } from './ui/kbd.js';
import { openAutomations } from './features/automations.js';
import { openPalette } from './features/commands.js';
import { renderFeed, reveal, scheduleRefetch } from './features/feed.js';
import { renderLauncher } from './features/launcher.js';
import { connect, loadConfig, loadSessions } from './features/live.js';
import { loadMachines, openMachines } from './features/machines.js';
import { onKey } from './features/keys.js';
import { backToTop, onScroll, stage } from './features/scroll.js';
import { openSettings, telemetryNotice } from './features/settings.js';
import { installUpdate, loadUpdate } from './features/update.js';

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
}, 30000);

if (/Electron/.test(navigator.userAgent)) document.body.classList.add('electron', /Mac/.test(navigator.platform) ? 'mac' : 'other');

// #/s/<id> still works (notifications, CLI): it reveals that item in the feed.
function route() {
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

(async () => {
  [S.agents] = await Promise.all([api('/agents').catch(() => []), loadConfig(), loadSessions(), loadMachines()]);
  renderLauncher();
  bus.emit('agents');
  connect();
  route();
  $('#prompt')?.focus();
  telemetryNotice();
})();
