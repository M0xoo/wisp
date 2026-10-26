// Machines: other computers, over SSH. A machine runs its own wisp; this one signs in over SSH,
// tunnels to it and shows its sessions as <id>@<machine>. Projects can live on a machine; launching
// in one runs the agent there.

import { copy } from '../blocks.js';
import { esc } from '../md.js';
import { api, shared } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, el, icon } from '../core/dom.js';
import { COMPUTER, MOBILE, S, inGrid } from '../core/state.js';
import { present } from '../ui/overlay.js';
import { popover } from '../ui/popover.js';
import { toast, toastError, tryApi } from '../ui/toast.js';
import { keepSignIns } from './agent-login.js';
import { renderLaunchChips } from './launcher.js';
import { loadConfig, loadSessions } from './live.js';
import { MACHINE_STATE, machineById, machinesSummary } from './places.js';
import { openProjects, renderProjects } from './projects.js';
import { TAILSCALE_GUIDE } from './reachable.js';
import { harnessLogo } from './runners.js';
import { mountGridHere } from './cloud.js';
import { ask } from '../ui/confirm.js';

// Never throws; only a load that worked counts for since() (live.js), so a failed one is retried.
const fetchMachines = shared(() => api('/machines').then(setMachines));
export const loadMachines = () => fetchMachines().catch(() => {});
loadMachines.since = (t) => fetchMachines.since(t).catch(() => {});
export function setMachines(list, { quiet = false } = {}) {
  const was = new Map(S.machines.map((m) => [m.id, m.state === 'online']));
  for (const m of list) keepSignIns(m.id, m.remote?.agents);
  S.machines = list;
  paintMachinesBtn();
  renderLaunchChips();
  $('#launcher')?.placesChanged?.();
  renderProjects();
  bus.emit('machines');
  // Coming online lists its sessions; going offline greys their cards. (Not for the phone's cached
  // first paint: the real list is on its way.)
  if (!quiet && list.some((m) => (was.get(m.id) || false) !== (m.state === 'online'))) loadSessions();
}

// In the phone app, Machines (SSH from this computer to others) isn't shown: the button opens the
// app's own list of computers (mobile/www), where you switch or add one. As a page on top of this
// one, so Back (the button there, or the phone's) comes back here; ?from names this computer.
const COMPUTERS = 'https://localhost/';
export function openComputers() {
  location.href = `${COMPUTERS}?from=${encodeURIComponent(COMPUTER || '')}`;
}

export function paintMachinesBtn() {
  const b = $('#machinesBtn');
  if (!b) return;
  if (MOBILE) {
    // Which one you're on, after what the row does; tap to switch.
    $('span', b).innerHTML = `Computers${COMPUTER ? ` <small>${esc(COMPUTER)}</small>` : ''}`;
    $('.ab-n', b).hidden = true;
    b.title = 'Your computers: switch to another one, or add one';
    return;
  }
  $('span', b).textContent = inGrid() ? 'Connect' : 'Machines';
  $('use', b)?.setAttribute('href', inGrid() ? '#i-cloud' : '#i-server');
  if (inGrid()) {
    $('.ab-n', b).hidden = true;
    b.title = 'Open this cloud computer from your desktop or phone';
    return;
  }
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

export function openMachines({ host, focusAdd = false, focusGrid = false } = {}) {
  if (MOBILE) return openComputers();
  // A cloud computer doesn't SSH out: how to reach it through the grid instead.
  if (inGrid()) return import('./settings.js').then((m) => m.openSettings({ pane: 'machines' }));
  const node = el(`<div class="modal machines-modal">
      <header><h2>Machines</h2><button class="icon-btn close">${icon('x')}</button></header>
      <div class="mc-body">
        <p class="mem-lede">Run tasks on another computer you own: a desktop at home, a server, a cloud VM. Its tasks show up here next to this computer’s, and keep going when this one sleeps.</p>
        <section class="sx-group mc-grid"></section>
        <div class="mc-howto-slot"></div>
        <div class="mc-list"></div>
        <section class="mc-add"></section>
      </div>
    </div>`);
  const close = present(node, host);
  // This computer on your wisp Grid (or signing in to one): your phone and your other computers
  // reach it through there, and theirs show up here.
  mountGridHere($('.mc-grid', node));
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
    return `<div class="mc-found"><h4>Computers wisp found</h4><div class="mc-found-list">${list
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
  // How it works, for someone who has never done this: the same three steps as the phone app.
  const howto = () => `<section class="mc-howto">
      <ol>
        <li><span class="mc-n">1</span><div><b>Get the other computer ready</b><p>Turn on SSH there. On a Mac: System Settings → General → Sharing → <i>Remote Login</i>. On Linux: install <code>openssh-server</code>. That’s all: wisp installs Node.js and itself there. You pick a coding agent once it’s connected. If wisp runs there too, its Settings → Machines → <i>This computer</i> checks all of this for you.</p></div></li>
        <li><span class="mc-n">2</span><div><b>Add it here</b><p>Pick it below if wisp found it, or type its address: <code>you@its-name</code> or an IP address. That computer’s wisp shows the address under <i>This computer</i> → <i>Connect with</i>.</p></div></li>
        <li><span class="mc-n">3</span><div><b>Let this computer in</b><p>The first time, type your password for that computer. wisp sets up a key there, so it won’t ask again. Then wisp starts itself there and its tasks show up here.</p></div></li>
      </ol>
      <p class="mc-ts">${icon('info')}<span>Not on the same network? Install <a href="https://tailscale.com/download" target="_blank" rel="noopener">Tailscale</a> (free) on both computers and use the name it gives. <a href="${TAILSCALE_GUIDE}" target="_blank" rel="noopener">Step-by-step guide</a></span></p>
    </section>`;
  const hostOf = (m) => m.target.replace(/^.*@/, '');
  const gridHost = (m) => String(m.grid || '').replace(/^https?:\/\//, '');
  const trouble = (m) => {
    const h = m.hint || {};
    const lost = m.state === 'reconnecting';
    const title = lost ? `${m.error || 'Connection lost.'} Trying again${m.attempt > 1 ? ` (attempt ${m.attempt})` : ''}…` : h.title || m.error;
    return `<div class="mc-hint ${lost ? 'soft' : ''}">
      <p><b>${esc(title)}</b></p>
      ${h.text ? `<p>${esc(h.text)}</p>` : ''}
      ${
        h.letIn && !lost
          ? `<form class="mc-letin" data-id="${m.id}">
              <label class="mc-field"><span>Your password on ${esc(hostOf(m))}</span>
                <span class="mc-letin-row"><input class="input" type="password" name="password" autocomplete="current-password" placeholder="The one you sign in to ${esc(hostOf(m))} with" required><button class="primary sm" type="submit">${icon('lock')}Let me in</button></span></label>
              <small>Used once to add this computer’s key there. wisp never keeps it.</small>
              <p class="mc-letin-err" hidden></p>
              <details class="mc-byhand"><summary>Prefer a terminal?</summary><p>Run this here once, then connect again:</p><div class="mc-cmd"><code>${esc(h.command)}</code><button type="button" class="ghost xs" data-a="copy" data-cmd="${esc(h.command)}" title="Copy">${icon('copy')}</button></div></details>
            </form>`
          : h.command
            ? `<div class="mc-cmd"><code>${esc(h.command)}</code><button class="ghost xs" data-a="copy" data-cmd="${esc(h.command)}" title="Copy">${icon('copy')}</button></div>`
            : ''
      }
      ${h.url ? `<p><a href="${esc(h.url)}" target="_blank" rel="noopener">${icon('external')}Get Node.js</a></p>` : ''}
      ${h.tailscale ? `<p><a href="${TAILSCALE_GUIDE}" target="_blank" rel="noopener">${icon('external')}Connect from anywhere with Tailscale</a></p>` : ''}
      ${m.stale ? `<button class="ghost sm" data-a="restart">${icon('rerun')}Restart wisp there</button>` : ''}
      ${m.log.length || (h.title && m.error) ? `<details class="mc-log"><summary>Details</summary><pre>${esc([h.title ? m.error : '', ...m.log].filter(Boolean).join('\n'))}</pre></details>` : ''}
    </div>`;
  };
  const projects = (m) => {
    const list = S.config.projects.filter((p) => p.machine === m.id);
    return `<div class="mc-projects">${list.map((p) => `<span class="lp-chip c-${p.color}" title="${esc(p.path)}"><i class="p-dot"></i>${esc(p.name)}</span>`).join('')}
      <button class="lp-chip add" data-a="projects">${icon(list.length ? 'plus' : 'folder')}${list.length ? 'Add' : 'Pick projects on it…'}</button></div>`;
  };
  // Where a machine comes from, said on its card: a cloud computer the grid runs, one of your
  // computers reached through the grid, or one this computer reaches over SSH.
  const kind = (m) => (m.kind !== 'grid' ? ['ssh', 'Over SSH', 'server'] : m.computer ? ['grid', 'Your computer · via grid', 'laptop'] : ['cloud', 'Cloud · on grid', 'cloud']);
  const where = (m) => (m.kind === 'grid' ? `${m.computer ? 'through' : 'on'} ${gridHost(m)}` : `${m.target}${m.port !== 4477 ? ` · port ${m.port}` : ''}`);
  const stateText = (m) => (m.computer && m.state === 'asleep' ? 'Offline' : MACHINE_STATE[m.state] || m.state);
  const card = (m) => {
    const st = m.state;
    const busy = st === 'connecting' || st === 'reconnecting';
    const ready = (m.remote?.agents || []).filter((a) => a.available);
    const [k, label, ico] = kind(m);
    return `<div class="mc st-${st}" data-id="${m.id}">
      <div class="mc-head">
        <span class="mc-icon">${icon(ico)}<i class="mc-dot"></i></span>
        <div class="mc-title"><b>${esc(m.name)}<span class="mc-kind ${k}">${label}</span></b><span>${esc(where(m))}</span></div>
        <span class="mc-state">${stateText(m)}</span>
        ${st === 'online' || busy ? `<button class="ghost sm" data-a="disconnect">${busy ? 'Cancel' : 'Disconnect'}</button>` : `<button class="primary sm" data-a="connect">${st === 'error' ? 'Try again' : st === 'asleep' ? (m.computer ? 'Check again' : 'Wake') : 'Connect'}</button>`}
        <button class="icon-btn" data-a="menu" title="More">${icon('dots')}</button>
      </div>
      ${
        st === 'online'
          ? `<div class="mc-meta"><span>wisp ${esc(m.remote?.version || '')}</span>${m.outdated ? `<button class="ghost xs mc-update" data-a="update" title="Restart wisp on ${esc(m.name)} as ${esc(m.outdated)}">${icon('rerun')}Update to ${esc(m.outdated)}</button>` : ''}${ready.length ? `<span class="mc-agents">${ready.map((a) => `<span class="model-logo" title="${esc(a.name)} ${esc(a.version || '')}">${harnessLogo(a.id)}</span>`).join('')}</span>` : '<span class="bad">No coding agent there yet: install Claude Code, Codex or opencode on it</span>'}${m.working ? `<span>${m.working} working</span>` : ''}</div>`
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
        <label class="mc-field grow"><span>Its address</span><input class="input mono" name="target" list="sshHosts" placeholder="you@its-name, or you@192.168.1.20" spellcheck="false" autocomplete="off" autocapitalize="off" value="${esc(m?.target || '')}" required></label>
        <label class="mc-field"><span>Name <em>optional</em></span><input class="input" name="name" placeholder="${esc(m?.name || 'devbox')}" value="${esc(m?.name || '')}" spellcheck="false"></label>
      </div>
      <details class="mc-adv" ${m && (m.port !== 4477 || m.command) ? 'open' : ''}><summary>Advanced</summary>
        <div class="mc-row">
          <label class="mc-field"><span>wisp’s port there</span><input class="input mono" name="port" type="number" min="1" max="65535" value="${m?.port || 4477}"></label>
          <label class="mc-field grow"><span>Start command</span><input class="input mono" name="command" placeholder="${esc(S.machines[0]?.defaultCommand || 'npx -y wisp-agents@<this version>')}" value="${esc(m?.command || '')}" spellcheck="false"></label>
        </div>
        <label class="check mc-check"><input type="checkbox" name="autoConnect" ${m?.autoConnect === false ? '' : 'checked'}> Connect when wisp starts</label>
      </details>
      <div class="mc-foot">
        <p class="hint">${m ? 'Changing the address, port or command reconnects.' : 'Your user name on that computer, @, then its name or IP. wisp connects over SSH with this computer’s key; the first time, it asks for your password there once.'}</p>
        ${editing !== null && (m || S.machines.length) ? '<button type="button" class="ghost sm" data-a="cancel">Cancel</button>' : ''}
        <button class="primary sm" type="submit">${m ? 'Save' : `${icon('server')}Add and connect`}</button>
      </div>
    </form>`;

  const paint = () => {
    if (!node.isConnected && !host) return;
    $('.mc-list', node).innerHTML = S.machines.map(card).join('');
    // First time: the three steps up front. Later: behind a link, open if you asked for it.
    const slot = $('.mc-howto-slot', node);
    if (!S.machines.length) slot.innerHTML = howto();
    else if (!$('details.mc-howto-more', slot)) slot.innerHTML = `<details class="mc-howto-more"><summary>${icon('info')}How it works</summary>${howto()}</details>`;
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
        ${m.kind === 'grid' ? '' : `<button data-m="edit">${icon('pen')}Edit…</button>`}
        <button data-m="projects">${icon('folder')}Projects on it…</button>
        ${m.state === 'online' && !m.computer ? `<button data-m="restart">${icon('rerun')}Restart wisp there</button><button data-m="stop" class="danger">${icon('stop')}Stop wisp there</button>` : ''}
        <button data-m="remove" class="danger">${icon('trash')}${m.computer ? 'Remove from grid' : m.kind === 'grid' ? 'Sign out of the grid' : 'Remove machine'}</button>
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
        if (m.working && !(await ask(`${m.working} agent${m.working === 1 ? ' is' : 's are'} working on ${m.name}.\n\n${verb} stops ${m.working === 1 ? 'it' : 'them'}.`, { ok: a === 'update' ? 'Update and stop agents' : 'Restart and stop agents', danger: true }))) return;
        await api(`/machines/${m.id}/stop`, { method: 'POST', body: { restart: true } });
      }
      if (a === 'stop') {
        if (!(await ask(`Stop wisp on ${m.name}?\n\n${m.working ? `${m.working} working agent${m.working === 1 ? '' : 's'} stop too. ` : ''}Its tasks stay there for next time.`, { ok: 'Stop wisp', danger: !!m.working }))) return;
        await api(`/machines/${m.id}/stop`, { method: 'POST', body: {} });
        toast(`Stopped wisp on <b>${esc(m.name)}</b>`);
      }
      if (a === 'remove') {
        const q = m.computer
          ? [`Remove ${m.name} from your grid?\n\nYour phone and other computers stop reaching it. wisp on ${m.name} keeps running; add it again from its Machines.`, 'Remove from grid']
          : m.kind === 'grid'
            ? [`Sign out of ${gridHost(m)} here?\n\nThis computer leaves the grid too, and your other computers there leave this list. Your cloud computer’s tasks stay there.`, 'Sign out']
            : [`Remove ${m.name} from wisp?\n\nIts projects leave the launcher. Nothing on the machine is touched, and wisp keeps running there until you stop it.`, 'Remove machine'];
        if (!(await ask(q[0], { ok: q[1], danger: true }))) return;
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
    if (f.matches('.mc-letin')) return letMeIn(f);
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
  // The password goes to the server for one ssh call that adds this computer's key there, then
  // it connects. A wrong password stays on the form with what to do.
  const letMeIn = async (f) => {
    const btn = $('button[type="submit"]', f);
    const err = $('.mc-letin-err', f);
    btn.disabled = true;
    btn.innerHTML = `${icon('lock')}Letting you in…`;
    err.hidden = true;
    try {
      await api(`/machines/${f.dataset.id}/let-in`, { method: 'POST', body: { password: f.password.value } });
      f.password.value = '';
      toast('This computer is allowed in now. Connecting…');
      document.activeElement?.blur();
      await loadMachines();
      paint();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      if (ex.message.includes('by hand')) $('.mc-byhand', f).open = true;
      btn.disabled = false;
      btn.innerHTML = `${icon('lock')}Let me in`;
      f.password.select();
    }
  };
  bus.on(
    'machines',
    () => {
      // Don't clobber a half-typed form: repaint the cards only. A password being typed: nothing.
      if (document.activeElement?.closest?.('.mc-letin') && node.contains(document.activeElement)) return;
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
  // Signing in to a grid (the sidebar's account row): its address, once mountGridHere has drawn the form.
  if (focusGrid) {
    const until = Date.now() + 3000;
    const tryFocus = () => {
      const input = $('.mc-grid input[name="grid"]', node);
      if (input) return input.focus(), input.select();
      if (node.isConnected && Date.now() < until) setTimeout(tryFocus, 50);
    };
    return setTimeout(tryFocus, 60);
  }
  if (focusAdd || !S.machines.length) setTimeout(() => $('.mc-add input[name="target"]', node)?.focus(), 60);
}
