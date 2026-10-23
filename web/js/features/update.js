// Self-update: the server polls npm; when a newer wisp-agents is out, a pill appears next to Search.

import { copy } from '../blocks.js';
import { esc } from '../md.js';
import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { S } from '../core/state.js';
import { toast } from '../ui/toast.js';
import { ask } from '../ui/confirm.js';

// The server polls npm; when a newer wisp-agents is out, a pill appears next to Search.
let update = null;
export const loadUpdate = () => api('/update').then(renderUpdate).catch(() => {});
export const updateState = () => update;
export function renderUpdate(u) {
  update = u;
  const b = $('#updateBtn');
  const busy = u.status === 'installing' || u.status === 'restarting';
  b.hidden = !u.available && !busy;
  b.disabled = busy;
  b.classList.toggle('busy', busy);
  b.querySelector('span').textContent = u.status === 'installing' ? 'Updating…' : u.status === 'restarting' ? 'Restarting…' : `Update to ${u.latest}`;
  b.title = `wisp ${u.current} → ${u.latest}: install and restart`;
}

export async function installUpdate() {
  if (!update?.available) return;
  const post = (force) => api('/update', { method: 'POST', body: { force } });
  try {
    await post(false).catch(async (err) => {
      const running = [...S.sessions.values()].filter((s) => s.state === 'running' || s.state === 'waiting').length;
      if (err.message !== 'agents are running') throw err;
      if (!(await ask(`Update to wisp ${update.latest} and restart?\n\n${running || 'Some'} running agent${running === 1 ? '' : 's'} will be stopped.`, { ok: 'Update and restart', anchor: $('#updateBtn') }))) throw null;
      return post(true);
    });
  } catch (err) {
    // The desktop app's "command" is the downloads page: open it rather than copy it.
    const action = update.method === 'app' ? { label: 'Open downloads', run: () => window.open(update.command, '_blank', 'noopener') } : { label: 'Copy command', run: () => copy(update.command) };
    if (err) toast(esc(err.message), { tone: 'bad', timeout: 10_000, action });
    return;
  }
  renderUpdate({ ...update, status: 'restarting' });
  // The server exits and a new one takes the port: reload once it answers with the new version.
  const from = update.current;
  const t0 = Date.now();
  const poll = setInterval(async () => {
    const h = await api('/health').catch(() => null);
    if (h?.version && h.version !== from) return clearInterval(poll), location.reload();
    if (Date.now() - t0 > 120_000) clearInterval(poll), toast(update.method === 'app' ? 'wisp did not come back. Open it again.' : 'wisp did not come back. Start it again from your terminal.', { tone: 'bad', timeout: 15_000 });
  }, 1000);
}
