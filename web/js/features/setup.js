// No harness on this computer yet: the launcher offers to install opencode (its free models need
// no account), so a first run goes from `npx wisp-agents` to a working task in one click.
// Settings → Agents uses the same install.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, icon } from '../core/dom.js';
import { launch, S } from '../core/state.js';
import { toast, toastError } from '../ui/toast.js';
import { harnessLogo } from './runners.js';

// What wisp can install itself (server/services/install.js).
export const INSTALLABLE = new Set(['opencode']);

let installing = null; // the running install's id
let failed = ''; // the last install's error, shown in the strip until the next try

export const isInstalling = (id) => installing === id;

// Installs, then swaps in the new harness list. One at a time; the server waits for npm.
export async function installHarness(id) {
  if (installing) return;
  installing = id;
  failed = '';
  bus.emit('install');
  try {
    S.agents = await api('/agents/install', { method: 'POST', body: { id } });
    $('#launcher')?.placesChanged?.();
    toast(`<b>${esc(S.agents.find((a) => a.id === id)?.name || id)}</b> is ready: free models, no account needed. Type a task and press Enter.`, { timeout: 7000 });
    $('#prompt')?.focus();
  } catch (err) {
    failed = err.message;
    toastError(err);
  } finally {
    installing = null;
    bus.emit('agents');
    bus.emit('install');
  }
}

// The launch would have nowhere to run: this computer is picked and has no harness. Unknown
// until the first detection is back (an empty list), so a slow start doesn't flash the strip.
export const needsSetup = () => launch.where.includes('') && S.agents.length > 0 && !S.agents.some((a) => a.available);

export function renderSetup() {
  const box = $('#launcher .l-setup');
  if (!box) return;
  box.hidden = !needsSetup();
  if (box.hidden) return;
  const busy = isInstalling('opencode');
  box.classList.toggle('busy', busy);
  const line = busy
    ? 'Installing opencode into ~/.wisp/tools… usually under a minute'
    : failed
      ? `Couldn’t install it: ${failed}`
      : 'No coding agent here yet. opencode runs free models, no account needed.';
  box.innerHTML = `
    <span class="model-logo">${harnessLogo('opencode')}</span>
    <span class="ls-text ${failed && !busy ? 'bad' : ''}" title="${esc(line)}">${esc(line)}</span>
    <button class="icon-btn ls-recheck" title="Installed one yourself? Look again" ${busy ? 'disabled' : ''}>${icon('replay')}</button>
    <button class="primary sm ls-install" ${busy ? 'disabled' : ''}>${busy ? '<span class="ls-spin"></span>Installing…' : failed ? 'Try again' : 'Install opencode'}</button>`;
  $('.ls-install', box).onclick = () => {
    installHarness('opencode');
  };
  $('.ls-recheck', box).onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.classList.add('busy');
    try {
      S.agents = await api('/agents/recheck', { method: 'POST', body: {} });
      $('#launcher')?.placesChanged?.();
      bus.emit('agents');
      if (needsSetup()) toast('Still no harness found. Install opencode here, or Claude Code, Codex, Cursor… yourself.');
    } catch (err) {
      toastError(err);
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy');
    }
  };
}

// Enter with nowhere to run: point at the strip instead of sending a launch that can only fail.
export function nudgeSetup() {
  const box = $('#launcher .l-setup');
  if (!box) return;
  box.classList.remove('nudge');
  void box.offsetWidth; // restart the animation
  box.classList.add('nudge'); // focus stays in the box: a second Enter mustn't start an install
}

bus.on('agents', renderSetup);
bus.on('install', renderSetup);
