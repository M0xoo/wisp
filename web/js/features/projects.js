// Projects: the filter chips in the top bar and the dialog that adds, renames and removes them.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, $$, el, icon } from '../core/dom.js';
import { launch, S, save, saveLaunch } from '../core/state.js';
import { present } from '../ui/overlay.js';
import { popover } from '../ui/popover.js';
import { toast, toastError, tryApi } from '../ui/toast.js';
import { clones, isRepo, repoLabel, repoName, startClone } from './clones.js';
import { feedToTop, renderFeed } from './feed.js';
import { renderLaunchChips } from './launcher.js';
import { loadConfig } from './live.js';
import { connectMachine, openMachines } from './machines.js';
import { MACHINE_STATE, machineById, placeOf, projectById, projectTitle } from './places.js';

export function renderProjects() {
  const all = [...S.sessions.values()];
  const stats = (pid) => {
    const l = pid === 'all' ? all : all.filter((s) => s.projectId === pid);
    return { run: l.filter((s) => s.state === 'running').length, need: l.filter((s) => s.state === 'waiting' || (s.state === 'review' && s.unread)).length };
  };
  const chip = (id, name, color) => {
    const st = stats(id);
    return `<button class="p-chip ${S.filter === id ? 'on' : ''} c-${color}" data-id="${id}" title="${esc(id === 'all' ? 'All projects' : projectTitle(projectById(id)))}">
      ${id === 'all' ? '' : '<i class="p-dot"></i>'}<span>${esc(name)}</span>${projectById(id)?.machine ? icon('server', 'p-where') : ''}${st.run ? `<span class="p-run" title="${st.run} working"></span>` : ''}${st.need ? `<span class="p-need">${st.need}</span>` : ''}
    </button>`;
  };
  $('#projects').innerHTML = `${chip('all', 'All', 'slate')}${S.config.projects
    .slice()
    .sort((a, b) => (b.lastUsedAt || b.addedAt) - (a.lastUsedAt || a.addedAt))
    .map((p) => chip(p.id, p.name, p.color))
    .join('')}<button class="p-chip add" id="manageProjects" title="Manage projects">${icon('plus')}</button>`;
  $$('.p-chip[data-id]').forEach((b) =>
    b.addEventListener('click', () => {
      S.filter = S.filter === b.dataset.id ? 'all' : b.dataset.id;
      save('wisp.filter', S.filter);
      renderFeed();
      feedToTop();
      renderLaunchChips();
    }),
  );
  $$('.p-chip[data-id]:not([data-id="all"])').forEach((b) =>
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      projectMenu(b.dataset.id, e);
    }),
  );
  $('#manageProjects').onclick = () => openProjects();
}

function projectMenu(id, e) {
  const p = projectById(id);
  if (!p) return;
  $('.menu.project')?.close();
  const menu = el(`
    <div class="menu project" style="top:${e.clientY}px;left:${e.clientX}px">
      <button data-a="manage">${icon('pen')}Manage projects…</button>
      <button data-a="delete" class="danger">${icon('trash')}Remove project</button>
    </div>`);
  menu.onclick = async (ev) => {
    const a = ev.target.closest('button')?.dataset.a;
    close();
    if (a === 'manage') openProjects();
    if (a === 'delete' && confirm(`Remove “${p.name}” from wisp? Sessions and files are kept.`)) {
      try {
        await api(`/projects/${id}`, { method: 'DELETE' });
      } catch (err) {
        return toastError(err);
      }
      if (S.filter === id) {
        S.filter = 'all';
        save('wisp.filter', S.filter);
      }
      await loadConfig();
      renderFeed();
    }
  };
  const close = popover(menu);
  // Keep the menu on-screen when right-clicking near the window edge.
  const r = menu.getBoundingClientRect();
  if (r.right > innerWidth - 8) menu.style.left = `${innerWidth - r.width - 8}px`;
  if (r.bottom > innerHeight - 8) menu.style.top = `${innerHeight - r.height - 8}px`;
}

const COLORS = ['violet', 'teal', 'amber', 'rose', 'sky', 'lime', 'orange', 'indigo'];

// where: a machine id to add folders on that computer (server/machines.js), else this one.
export async function openProjects({ focusAdd = false, machine = null, host } = {}) {
  const node = el(`
    <div class="modal projects-modal">
      <header><h2>Projects</h2><button class="icon-btn close">${icon('x')}</button></header>
      <div class="mem-tabs where"></div>
      <div class="add-row">
        <div class="field lg mono path-input">
          ${window.wispDesktop ? `<button class="browse" title="Browse…">${icon('folder')}</button>` : icon('folder')}
          <input id="ppath" placeholder="~/code/my-app or a GitHub URL" spellcheck="false" autocomplete="off">
          <div class="suggest" hidden></div>
        </div>
        ${window.wispDesktop ? `<button class="ghost" id="pbrowse">${icon('folder')}Browse…</button>` : ''}
        <button class="primary" id="padd">Add</button>
      </div>
      <p class="hint"></p>
      <div class="plist" id="plist"></div>
      <div class="discover" id="ghrepos"></div>
      <div class="discover" id="discover"><h4>Found on this machine</h4><p class="muted">Looking for git repos…</p></div>
    </div>`);
  const close = present(node, host);
  const input = $('#ppath', node);
  const sug = $('.suggest', node);
  let where = machine && machineById(machine) ? machine : null;
  const here = () => machineById(where);
  const home = () => (where ? here()?.remote?.home : S.config.home) || '';
  const tilde = (p) => (home() && p.startsWith(home()) ? `~${p.slice(home().length)}` : p);
  let editingCloneDir = false;

  const paintWhere = () => {
    const tabs = $('.where', node);
    tabs.innerHTML = `<button data-w="" class="${where ? '' : 'on'}">${icon('folder')}This computer</button>${S.machines
      .map((m) => `<button data-w="${m.id}" class="${where === m.id ? 'on' : ''}" title="${esc(m.target)} · ${esc(MACHINE_STATE[m.state] || m.state)}">${icon('server')}${esc(m.name)}<i class="dot ${m.state === 'online' ? 'ok' : m.state === 'error' ? 'bad' : ''}"></i></button>`)
      .join('')}<i></i>${host ? '' : `<button data-w="+" title="Run agents on another computer over SSH">${icon('plus')}Machine</button>`}`;
    const m = here();
    input.placeholder = m ? `~/code/my-app or a GitHub URL, on ${m.name}` : '~/code/my-app or a GitHub URL';
    $$('#pbrowse, .browse', node).forEach((b) => (b.hidden = !!m));
    paintHint();
  };
  // The hint under the input follows what's typed: a repo URL says where the clone goes.
  const paintHint = () => {
    const m = here();
    const hint = $('.hint', node);
    const v = input.value.trim();
    $('#padd', node).textContent = isRepo(v) ? 'Clone' : 'Add';
    if (editingCloneDir) return;
    if (isRepo(v))
      hint.innerHTML = m
        ? `Clones <b>${esc(repoLabel(v))}</b> on <b>${esc(m.name)}</b>. You can write the task while it clones.`
        : `Clones <b>${esc(repoLabel(v))}</b> into <button class="link" data-a="clonedir" title="Change where repos are cloned">${esc(tilde(S.config.cloneDir || '~/code'))}/${esc(repoName(v))}</button>. You can write the task while it clones.`;
    else
      hint.innerHTML = m
        ? `Folders on <b>${esc(m.name)}</b>, or a repo URL to clone there. Agents run there, in its own worktrees; you follow along here.`
        : 'Paste a GitHub URL and wisp clones it for you. Or run <code>wisp add</code> inside any folder: it is added automatically.';
  };
  // Change the clone folder in place: the hint turns into a small path field.
  $('.hint', node).addEventListener('click', (e) => {
    if (!e.target.closest('[data-a="clonedir"]')) return;
    editingCloneDir = true;
    const hint = $('.hint', node);
    hint.innerHTML = `Clone repos into <input class="clonedir mono" spellcheck="false" value="${esc(tilde(S.config.cloneDir || '~/code'))}"> <button class="link" data-a="savedir">Save</button>`;
    const f = $('.clonedir', hint);
    const done = async (keep) => {
      if (!editingCloneDir) return;
      editingCloneDir = false;
      if (keep && f.value.trim() !== tilde(S.config.cloneDir || '')) {
        S.config.cloneDir = f.value.trim(); // optimistic; the server answers with the resolved folder
        await tryApi(async () => {
          await api('/config', { method: 'PATCH', body: { defaults: { cloneDir: f.value.trim() } } });
          await loadConfig();
        });
      }
      paintHint();
      input.focus();
    };
    f.onkeydown = (ev) => {
      if (ev.key === 'Enter' || ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation(); // Escape cancels the edit, not the dialog
        done(ev.key === 'Enter');
      }
    };
    $('[data-a="savedir"]', hint).onclick = () => {
      done(true);
    };
    f.focus();
    f.select();
  });
  $('.where', node).addEventListener('click', (e) => {
    const b = e.target.closest('[data-w]');
    if (!b) return;
    if (b.dataset.w === '+') {
      openMachines({ focusAdd: true });
      return;
    }
    where = b.dataset.w || null;
    sug.hidden = true;
    paintWhere();
    list();
    github();
    discover();
    input.focus();
  });

  // A new project becomes the launcher's pick for its place.
  const picked = async (proj) => {
    await loadConfig();
    launch.picks[placeOf(proj)] = proj.id;
    if (!launch.where.includes(placeOf(proj))) launch.where = [placeOf(proj)];
    if (placeOf(proj) === launch.where[0]) launch.project = proj.id;
    saveLaunch();
    renderLaunchChips();
  };
  const add = async (p) => {
    if (isRepo(p)) return clone(p);
    try {
      const proj = await api('/projects', { method: 'POST', body: { path: p, ...(where && { machine: where }) } });
      await picked(proj);
      toast(`Added <b>${esc(proj.name)}</b>${where ? ` on ${esc(here()?.name || '')}` : ''}`);
      input.value = '';
      sug.hidden = true;
      paintHint();
      list();
      discover();
    } catch (err) {
      toastError(err);
    }
  };
  // Clone a repo: the launcher picks it right away (cloning in the background) and the dialog
  // closes, so the next thing is writing the task. A launch into it waits for the clone.
  const clone = (url) => {
    startClone(url, where);
    close();
    setTimeout(() => $('#prompt')?.focus(), 60);
  };
  $('#padd', node).onclick = () => {
    if (input.value.trim()) add(input.value.trim());
  };
  const browse = async () => {
    const dir = await window.wispDesktop.pickFolder();
    if (dir) add(dir);
  };
  $$('#pbrowse, .browse', node).forEach((b) => (b.onclick = browse));

  let sel = -1;
  let t;
  input.addEventListener('input', () => {
    paintHint();
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = input.value;
      if (!q || isRepo(q)) return (sug.hidden = true);
      const dirs = await api(`${where ? `/machines/${where}/fs` : '/fs'}?q=${encodeURIComponent(q)}`).catch(() => []);
      sel = -1;
      sug.hidden = !dirs.length;
      sug.innerHTML = dirs.map((d) => `<button data-p="${esc(d)}">${esc(tilde(d))}</button>`).join('');
    }, 120);
  });
  input.addEventListener('keydown', (e) => {
    const opts = $$('button', sug);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
      opts.forEach((o, i) => o.classList.toggle('on', i === sel));
    } else if (e.key === 'Tab' && opts.length) {
      e.preventDefault();
      input.value = tilde(opts[Math.max(0, sel)].dataset.p + '/');
      input.dispatchEvent(new Event('input'));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      add(sel >= 0 ? opts[sel].dataset.p : input.value.trim());
    }
  });
  sug.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) add(b.dataset.p);
  });

  const list = () => {
    const box = $('#plist', node);
    const projects = S.config.projects.filter((p) => (p.machine || null) === where);
    const pending = clones
      .filter((j) => j.where === where)
      .map(
        (j) => `<div class="prow cloning"><span class="swatch"><span class="orb live"></span></span>
          <div class="prow-main"><b class="pname">${esc(repoName(j.url))}</b><span class="ppath">Cloning ${esc(repoLabel(j.url))}…</span></div></div>`,
      )
      .join('');
    box.innerHTML = projects.length || pending
      ? pending +
        projects
          .map((p) => {
            const n = [...S.sessions.values()].filter((s) => s.projectId === p.id).length;
            return `<div class="prow c-${p.color}" data-id="${p.id}">
              <button class="swatch" title="Change colour"><i class="p-dot"></i></button>
              <div class="prow-main"><input class="pname" value="${esc(p.name)}"><span class="ppath">${esc(tilde(p.path))}</span></div>
              <span class="pcount">${n} session${n === 1 ? '' : 's'}</span>
              <button class="icon-btn premove" title="Remove from wisp (files untouched)">${icon('trash')}</button>
            </div>`;
          })
          .join('')
      : `<p class="muted">No projects ${where ? `on ${esc(here()?.name || '')} ` : ''}yet. Add a folder above, or pick one below.</p>`;
    $$('.prow[data-id]', box).forEach((row) => {
      const id = row.dataset.id;
      const p = projectById(id);
      $('.pname', row).onchange = (e) => {
        tryApi(async () => {
          await api(`/projects/${id}`, { method: 'PATCH', body: { name: e.target.value } });
          await loadConfig();
        });
      };
      $('.swatch', row).onclick = () => {
        const color = COLORS[(COLORS.indexOf(p.color) + 1) % COLORS.length];
        tryApi(async () => {
          await api(`/projects/${id}`, { method: 'PATCH', body: { color } });
          await loadConfig();
          list();
        });
      };
      $('.premove', row).onclick = async () => {
        if (!confirm(`Remove “${p.name}” from wisp? Sessions and files are kept.`)) return;
        await tryApi(async () => {
          await api(`/projects/${id}`, { method: 'DELETE' });
          await loadConfig();
          list();
        });
      };
    });
  };

  // The user's own GitHub repos (through gh), one click to clone. Only on this computer, and
  // hidden when gh isn't installed or signed in.
  let ghRepos = null;
  let ghAll = false;
  const github = async () => {
    const box = $('#ghrepos', node);
    if (where) return (box.innerHTML = '');
    box.onclick = (e) => {
      const b = e.target.closest('[data-repo]');
      if (b) clone(b.dataset.repo);
      if (e.target.closest('[data-a="ghall"]')) {
        ghAll = !ghAll;
        github();
      }
    };
    if (!ghRepos) {
      box.innerHTML = `<h4>${icon('github')}Your GitHub repos</h4><p class="muted">Asking gh…</p>`;
      ghRepos = await api('/projects/github').catch(() => []);
      if (where) return (box.innerHTML = '');
    }
    const busy = new Set(clones.map((j) => j.label.toLowerCase()));
    const repos = ghRepos.filter((r) => !busy.has(r.repo.toLowerCase()));
    const more = repos.length > 6 ? `<button class="link xs" data-a="ghall">${ghAll ? 'Show fewer' : `Show all ${repos.length}`}</button>` : '';
    box.innerHTML = repos.length
      ? `<h4>${icon('github')}Your GitHub repos <span class="muted">· click to clone</span>${more}</h4><div class="found">${repos
          .slice(0, ghAll ? undefined : 6)
          .map(
            (r) =>
              `<button class="found-item" data-repo="${esc(r.url)}" title="${esc(r.description || r.repo)}">${icon('plus')}<b>${esc(r.repo.split('/')[1])}</b><span>${esc(r.repo.split('/')[0])}${r.private ? ' · private' : ''}${r.fork ? ' · fork' : ''}</span></button>`,
          )
          .join('')}</div>`
      : '';
  };

  const discover = async () => {
    const box = $('#discover', node);
    const m = here();
    const at = where;
    box.onclick = (e) => {
      const b = e.target.closest('.found-item');
      if (b) add(b.dataset.p);
      if (e.target.closest('[data-a="connect"]')) connectMachine(at);
    };
    if (m && m.state !== 'online') {
      box.innerHTML = `<p class="muted">${esc(m.name)} is ${m.state === 'connecting' || m.state === 'reconnecting' ? 'connecting…' : `offline. <button class="link" data-a="connect">Connect</button>`}</p>`;
      return;
    }
    box.innerHTML = `<h4>Found on ${m ? esc(m.name) : 'this machine'}</h4><p class="muted">Looking for git repos…</p>`;
    const found = await api(m ? `/machines/${m.id}/discover` : '/projects/discover').catch(() => []);
    if (where !== at) return; // switched tabs meanwhile
    box.innerHTML = found.length
      ? `<h4>Found on ${m ? esc(m.name) : 'this machine'} <span class="muted">· git repos</span></h4><div class="found">${found
          .map((f) => `<button class="found-item" data-p="${esc(f.path)}">${icon('plus')}<b>${esc(f.name)}</b><span>${esc(tilde(f.path).replace(/\/[^/]+$/, ''))}</span></button>`)
          .join('')}</div>`
      : '';
  };
  bus.on(
    'clones',
    () => {
      list();
      github();
    },
    { node },
  );
  let wasOnline = here()?.state === 'online';
  bus.on(
    'machines',
    () => {
      paintWhere();
      const online = here()?.state === 'online';
      if (online !== wasOnline) discover();
      wasOnline = online;
    },
    { node },
  );

  paintWhere();
  list();
  github();
  discover();
  if (focusAdd) setTimeout(() => input.focus(), 60);
}
