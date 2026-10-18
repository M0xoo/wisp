// Machines: other computers, over SSH. A machine runs its own wisp; this one signs in over SSH,
// tunnels to it and shows its sessions as <id>@<machine>. Projects can live on a machine; launching
// in one runs the agent there.

import { copy } from '../blocks.js';
import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { present } from '../ui/overlay.js';
import { popover } from '../ui/popover.js';
import { toast, toastError, tryApi } from '../ui/toast.js';
import { renderLaunchChips } from './launcher.js';
import { loadConfig, loadSessions } from './live.js';
import { MACHINE_STATE, machineById, machinesSummary } from './places.js';
import { openProjects, renderProjects } from './projects.js';
import { harnessLogo } from './runners.js';

export const loadMachines = () => api('/machines').then(setMachines).catch(() => {});
export function setMachines(list) {
  const was = new Map(S.machines.map((m) => [m.id, m.state === 'online']));
  S.machines = list;
  paintMachinesBtn();
  renderLaunchChips();
  $('#launcher')?.placesChanged?.();
  renderProjects();
  bus.emit('machines');
  // Coming online lists its sessions; going offline greys their cards.
  if (list.some((m) => (was.get(m.id) || false) !== (m.state === 'online'))) loadSessions();
}

function paintMachinesBtn() {
  const b = $('#machinesBtn');
  if (!b) return;
  const on = S.machines.filter((m) => m.state === 'online').length;
  const trouble = S.machines.some((m) => m.state === 'error' || m.state === 'reconnecting');
  b.classList.toggle('live', on > 0);
  b.classList.toggle('trouble', trouble);
  const n = $('.ab-n', b);
  n.hidden = !on;
  n.textContent = on;
  b.title = S.machines.length ? `Machines: ${machinesSummary()}` : 'Machines: run agents on another computer over SSH';
}

export function connectMachine(id) {
  return tryApi(() => api(`/machines/${id}/connect`, { method: 'POST', body: {} }));
}

export function offlineToast(id) {
  const m = machineById(id);
  if (m?.state === 'connecting' || m?.state === 'reconnecting') return toast(`Still connecting to <b>${esc(m.name)}</b>…`);
  toast(`<b>${esc(m?.name || 'That machine')}</b> isn’t connected`, { tone: 'bad', action: { label: 'Connect', run: () => connectMachine(id) } });
}

const STEP_ICON = { done: 'check', fail: 'x', warn: 'warn', run: '', pending: '' };

export function openMachines({ host, focusAdd = false } = {}) {
  const node = el(`<div class="modal machines-modal">
      <header><h2>Machines</h2><button class="icon-btn close">${icon('x')}</button></header>
      <div class="mc-body">
        <p class="mem-lede">Run agents on your other computers: a dev box, a GPU server, a cloud VM. wisp signs in over SSH, starts itself there and tunnels back, so worktrees, diffs and Ship it work as usual, and agents keep going when this computer sleeps.</p>
        <div class="mc-list"></div>
        <section class="mc-add"></section>
      </div>
    </div>`);
  const close = present(node, host);
  const body = $('.mc-body', node);
  let editing = null; // machine id whose form is open, '' = a new one, null = closed
  let hosts = []; // found on this computer: ~/.ssh/config, Tailscale peers, ~/.ssh/known_hosts
  api('/machines/discover')
    .then((h) => {
      hosts = h;
      const slot = $('.mc-found-slot', node);
      if (slot) slot.innerHTML = found();
      const dl = $('#sshHosts', node);
      if (dl) dl.innerHTML = datalist();
    })
    .catch(() => {});
  const datalist = () => hosts.map((x) => `<option value="${esc(x.target)}">${esc(x.detail || '')}</option>`).join('');
  const SOURCE = { 'ssh-config': '~/.ssh/config', tailscale: 'Tailscale', 'known-hosts': 'You’ve SSHed here before' };
  // Hosts not added yet, one click from a filled-in form.
  const found = () => {
    const added = new Set(S.machines.map((m) => m.target));
    const list = hosts.filter((x) => !added.has(x.target));
    if (!list.length) return '';
    return `<div class="mc-found"><h4>Found on this computer</h4><div class="mc-found-list">${list
      .slice(0, 12)
      .map(
        (x) =>
          `<button type="button" class="lp-chip${x.online === false ? ' off' : ''}" data-a="pick" data-target="${esc(x.target)}" data-name="${esc(x.name)}" title="${esc([SOURCE[x.source], x.target, x.detail].filter(Boolean).join(' · '))}">${icon('server')}${esc(x.name)}${x.online !== undefined ? `<i class="mc-fdot"></i>` : ''}</button>`,
      )
      .join('')}</div></div>`;
  };

  // Projects on a machine open here, with a way back.
  const sub = (view) => {
    const head = $(':scope > header', node);
    body.hidden = true;
    head.hidden = true;
    view.classList.add('embedded');
    const back = el(`<button class="ghost sm sx-back">${icon('back')}Back</button>`);
    back.onclick = () => {
      view.remove();
      body.hidden = false;
      head.hidden = false;
      paint();
    };
    $('header', view).prepend(back);
    $('.close', view).onclick = close;
    node.append(view);
    return close;
  };

  const steps = (m) => `<ol class="mc-steps">${m.steps
    .map((st) => `<li class="s-${st.status}"><span class="mc-si">${STEP_ICON[st.status] ? icon(STEP_ICON[st.status]) : ''}</span><b>${esc(st.label)}</b>${st.detail ? `<small>${esc(st.detail)}</small>` : ''}</li>`)
    .join('')}</ol>`;
  const trouble = (m) => `<div class="mc-hint ${m.state === 'reconnecting' ? 'soft' : ''}">
      <p><b>${esc(m.state === 'reconnecting' ? `${m.error || 'Connection lost.'} Trying again${m.attempt > 1 ? ` (attempt ${m.attempt})` : ''}…` : m.error)}</b></p>
      ${m.hint?.text ? `<p>${esc(m.hint.text)}</p>` : ''}
      ${m.hint?.command ? `<div class="mc-cmd"><code>${esc(m.hint.command)}</code><button class="ghost xs" data-a="copy" data-cmd="${esc(m.hint.command)}" title="Copy">${icon('copy')}</button></div>` : ''}
      ${m.stale ? `<button class="ghost sm" data-a="restart">${icon('rerun')}Restart wisp there</button>` : ''}
      ${m.log.length ? `<details class="mc-log"><summary>Log</summary><pre>${esc(m.log.join('\n'))}</pre></details>` : ''}
    </div>`;
  const projects = (m) => {
    const list = S.config.projects.filter((p) => p.machine === m.id);
    return `<div class="mc-projects">${list.map((p) => `<span class="lp-chip c-${p.color}" title="${esc(p.path)}"><i class="p-dot"></i>${esc(p.name)}</span>`).join('')}
      <button class="lp-chip add" data-a="projects">${icon(list.length ? 'plus' : 'folder')}${list.length ? 'Add' : 'Pick projects on it…'}</button></div>`;
  };
  const card = (m) => {
    const st = m.state;
    const busy = st === 'connecting' || st === 'reconnecting';
    const ready = (m.remote?.agents || []).filter((a) => a.available);
    return `<div class="mc st-${st}" data-id="${m.id}">
      <div class="mc-head">
        <span class="mc-icon">${icon('server')}<i class="mc-dot"></i></span>
        <div class="mc-title"><b>${esc(m.name)}</b><span>${esc(m.target)}${m.port !== 4477 ? ` · port ${m.port}` : ''}</span></div>
        <span class="mc-state">${MACHINE_STATE[st] || st}</span>
        ${st === 'online' || busy ? `<button class="ghost sm" data-a="disconnect">${busy ? 'Cancel' : 'Disconnect'}</button>` : `<button class="primary sm" data-a="connect">${st === 'error' ? 'Try again' : 'Connect'}</button>`}
        <button class="icon-btn" data-a="menu" title="More">${icon('dots')}</button>
      </div>
      ${
        st === 'online'
          ? `<div class="mc-meta"><span>wisp ${esc(m.remote?.version || '')}</span>${m.outdated ? `<button class="ghost xs mc-update" data-a="update" title="Restart wisp on ${esc(m.name)} as ${esc(m.outdated)}">${icon('rerun')}Update to ${esc(m.outdated)}</button>` : ''}${ready.length ? `<span class="mc-agents">${ready.map((a) => `<span class="model-logo" title="${esc(a.name)} ${esc(a.version || '')}">${harnessLogo(a.id)}</span>`).join('')}</span>` : '<span class="bad">no harnesses found</span>'}${m.working ? `<span>${m.working} working</span>` : ''}</div>`
          : ''
      }
      ${busy || st === 'error' ? steps(m) : ''}
      ${(st === 'error' || st === 'reconnecting') && m.error ? trouble(m) : ''}
      ${st === 'online' || m.projects ? projects(m) : ''}
      ${editing === m.id ? `<div class="mc-edit">${form(m)}</div>` : ''}
    </div>`;
  };
  const form = (m) => `<form class="mc-form" data-id="${m?.id || ''}">
      <div class="mc-row">
        <label class="mc-field grow"><span>SSH host</span><input class="input mono" name="target" list="sshHosts" placeholder="me@devbox, 10.0.0.5, or a Host from ~/.ssh/config" spellcheck="false" autocomplete="off" autocapitalize="off" value="${esc(m?.target || '')}" required></label>
        <label class="mc-field"><span>Name</span><input class="input" name="name" placeholder="${esc(m?.name || 'devbox')}" value="${esc(m?.name || '')}" spellcheck="false"></label>
      </div>
      <details class="mc-adv" ${m && (m.port !== 4477 || m.command) ? 'open' : ''}><summary>Advanced</summary>
        <div class="mc-row">
          <label class="mc-field"><span>wisp’s port there</span><input class="input mono" name="port" type="number" min="1" max="65535" value="${m?.port || 4477}"></label>
          <label class="mc-field grow"><span>Start command</span><input class="input mono" name="command" placeholder="${esc(S.machines[0]?.defaultCommand || 'npx -y wisp-agents@<this version>')}" value="${esc(m?.command || '')}" spellcheck="false"></label>
        </div>
        <label class="check mc-check"><input type="checkbox" name="autoConnect" ${m?.autoConnect === false ? '' : 'checked'}> Connect when wisp starts</label>
      </details>
      <div class="mc-foot">
        <p class="hint">${m ? 'Changing the host, port or command reconnects.' : 'Uses your SSH keys, agent and ~/.ssh/config; wisp never asks for a password. The machine needs Node.js 20+ and the harness CLIs, signed in.'}</p>
        ${editing !== null && (m || S.machines.length) ? '<button type="button" class="ghost sm" data-a="cancel">Cancel</button>' : ''}
        <button class="primary sm" type="submit">${m ? 'Save' : `${icon('server')}Connect`}</button>
      </div>
    </form>`;

  const paint = () => {
    if (!node.isConnected && !host) return;
    $('.mc-list', node).innerHTML = S.machines.map(card).join('');
    const add = $('.mc-add', node);
    // The form for a new machine: open when there are none yet, else behind a button.
    if (!S.machines.length || editing === '') {
      // Keep a half-filled form; only the suggestions above it change.
      if ($('form[data-id=""]', add)) $('.mc-found-slot', add).innerHTML = found();
      else add.innerHTML = `<div class="mc-found-slot">${found()}</div><h4>${S.machines.length ? 'Add another machine' : 'Add your first machine'}</h4>${form(null)}<datalist id="sshHosts">${datalist()}</datalist>`;
    } else add.innerHTML = `<div class="mc-found-slot">${found()}</div><button class="lp-chip add mc-new" data-a="new">${icon('plus')}Add a machine</button><datalist id="sshHosts">${datalist()}</datalist>`;
  };

  const menu = (m, anchor) => {
    $('.menu.machine')?.close();
    const r = anchor.getBoundingClientRect();
    const box = el(`<div class="menu machine" style="top:${r.bottom + 4}px;left:${Math.max(8, r.right - 230)}px">
        <button data-m="edit">${icon('pen')}Edit…</button>
        <button data-m="projects">${icon('folder')}Projects on it…</button>
        ${m.state === 'online' ? `<button data-m="restart">${icon('rerun')}Restart wisp there</button><button data-m="stop" class="danger">${icon('stop')}Stop wisp there</button>` : ''}
        <button data-m="remove" class="danger">${icon('trash')}Remove machine</button>
      </div>`);
    box.onclick = (ev) => {
      const a = ev.target.closest('button')?.dataset.m;
      shut();
      if (a) act(a, m);
    };
    const shut = popover(box);
  };

  const act = async (a, m) => {
    try {
      if (a === 'connect') await api(`/machines/${m.id}/connect`, { method: 'POST', body: {} });
      if (a === 'disconnect') await api(`/machines/${m.id}/disconnect`, { method: 'POST', body: {} });
      if (a === 'projects') openProjects({ machine: m.id, host: sub, focusAdd: true });
      if (a === 'edit') {
        editing = m.id;
        paint();
        $(`.mc[data-id="${m.id}"] input[name="target"]`, node)?.focus();
      }
      if (a === 'restart' || a === 'update') {
        const verb = a === 'update' ? `Updating wisp there to ${m.outdated}` : 'Restarting wisp there';
        if (m.working && !confirm(`${m.working} agent${m.working === 1 ? ' is' : 's are'} working on ${m.name}. ${verb} stops ${m.working === 1 ? 'it' : 'them'}. ${a === 'update' ? 'Update' : 'Restart'}?`)) return;
        await api(`/machines/${m.id}/stop`, { method: 'POST', body: { restart: true } });
      }
      if (a === 'stop') {
        if (!confirm(`Stop wisp on ${m.name}? ${m.working ? `${m.working} working agent${m.working === 1 ? '' : 's'} stop too. ` : ''}Its sessions stay there for next time.`)) return;
        await api(`/machines/${m.id}/stop`, { method: 'POST', body: {} });
        toast(`Stopped wisp on <b>${esc(m.name)}</b>`);
      }
      if (a === 'remove') {
        if (!confirm(`Remove ${m.name} from wisp? Its projects leave the launcher. Nothing on the machine is touched, and wisp keeps running there until you stop it.`)) return;
        await api(`/machines/${m.id}`, { method: 'DELETE' });
        await loadConfig();
        await loadMachines();
      }
    } catch (err) {
      toastError(err);
    }
  };

  node.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b || !body.contains(b)) return;
    const a = b.dataset.a;
    const m = machineById(b.closest('.mc')?.dataset.id);
    if (a === 'copy') {
      copy(b.dataset.cmd);
      toast('Copied. Run it in a terminal, then connect again.');
      return;
    }
    if (a === 'new') {
      editing = '';
      paint();
      $('.mc-add input[name="target"]', node)?.focus();
      return;
    }
    if (a === 'pick') {
      // Fill in the form; connecting still waits for the button.
      editing = '';
      paint();
      const f = $('.mc-add form[data-id=""]', node);
      f.target.value = b.dataset.target;
      f.name.value = b.dataset.name;
      $('button[type="submit"]', f).focus();
      return;
    }
    if (a === 'cancel') {
      editing = null;
      paint();
      return;
    }
    if (a === 'menu' && m) {
      menu(m, b);
      return;
    }
    if (m) act(a, m);
  });
  // The name follows the host until you type one.
  node.addEventListener('input', (e) => {
    if (e.target.name !== 'target') return;
    const name = $('input[name="name"]', e.target.form);
    const h = hosts.find((x) => x.target === e.target.value.trim());
    name.placeholder = (h?.name || e.target.value.trim().replace(/^.*@/, '')).slice(0, 40) || 'devbox';
  });
  node.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const id = f.dataset.id;
    const v = Object.fromEntries(new FormData(f));
    const payload = { target: v.target.trim(), name: v.name.trim(), port: Number(v.port) || 4477, command: v.command.trim(), autoConnect: !!v.autoConnect };
    const btn = $('button[type="submit"]', f);
    btn.disabled = true;
    try {
      if (id) await api(`/machines/${id}`, { method: 'PATCH', body: payload });
      else await api('/machines', { method: 'POST', body: payload });
      editing = null;
      await loadMachines();
      paint();
    } catch (err) {
      toastError(err);
    } finally {
      btn.disabled = false;
    }
  });
  bus.on(
    'machines',
    () => {
      // Don't clobber a half-typed form: repaint the cards only.
      const typing = node.contains(document.activeElement) && document.activeElement.matches('input, select');
      if (typing && editing !== null && editing !== '') return;
      if (typing) $('.mc-list', node).innerHTML = S.machines.map(card).join('');
      else paint();
    },
    { node },
  );
  paint();
  if (focusAdd && S.machines.length) {
    editing = '';
    paint();
  }
  if (focusAdd || !S.machines.length) setTimeout(() => $('.mc-add input[name="target"]', node)?.focus(), 60);
}
