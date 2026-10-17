import { renderPresentation, icon, el, fmtDuration, copy, countChanges } from './blocks.js';
import { esc, md } from './md.js';
import { palette } from './palette.js';

// One page: the launcher on top, every session in a feed under it. Sessions
// expand in place; nothing navigates away.

// --- state -------------------------------------------------------------------

const S = {
  sessions: new Map(), // id -> summary
  full: new Map(), // id -> full session, for expanded items
  open: new Set(load('wisp.open', [])), // expanded item ids
  nodes: new Map(), // id -> { card, head, body, turnNodes, tray, showAll, unfolded, latestTurn }
  focus: null, // id of the keyboard-focused item
  config: { defaults: {}, projects: [] },
  agents: [],
  filter: load('wisp.filter', 'all'),
  showDone: load('wisp.showDone', false),
  showArchived: false,
  drafts: new Map(),
};

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const stage = $('#stage');

function load(k, d) {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? d;
  } catch {
    return d;
  }
}
function save(k, v) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
}
const saveOpen = () => save('wisp.open', [...S.open]);

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(`/api${path}`, {
    method,
    // The server only accepts JSON on non-GET requests (CSRF guard), even body-less DELETEs.
    headers: method !== 'GET' ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

const MODES = [
  { id: 'plan', label: 'Plan', icon: 'plan', hint: 'Read-only. The agent investigates and proposes.' },
  { id: 'edits', label: 'Edits', icon: 'pen', hint: 'May edit files. Shell commands that need approval are denied.' },
  { id: 'auto', label: 'Full auto', icon: 'spark', hint: 'No permission prompts at all. Trusted repos only.' },
];
const KIND_ICON = { read: 'read', edit: 'pen', run: 'terminal', search: 'search', web: 'web', agent: 'agent', plan: 'plan', tool: 'tool', text: 'text', error: 'warn', ask: 'ask', answer: 'check', wait: 'ask' };
const STATUS_LABEL = { done: 'Done', partial: 'Partial', blocked: 'Blocked', info: 'Report' };
const agentName = (id) => S.agents.find((a) => a.id === id)?.name || (id === 'wisp' ? 'wisp' : id);

// Harness logos for the request bubble, vendored from @lobehub/icons into web/logos/.
// `mono` marks are drawn in the text colour so they work in both themes.
const HARNESS_LOGO = {
  claude: { file: 'claudecode-color' },
  codex: { file: 'codex-color' },
  opencode: { file: 'opencode', mono: true },
  cursor: { file: 'cursor', mono: true },
};
function harnessLogo(agent) {
  const l = HARNESS_LOGO[agent];
  const src = l && `/logos/${l.file}.svg`;
  return !l ? icon('spark') : l.mono ? `<i class="mono" style="--logo:url(${src})"></i>` : `<img src="${src}" alt="">`;
}
// Reasoning levels the harness accepts for a model: the model's own list (opencode variants),
// else the harness-wide one. Empty means the harness has no knob for it.
function effortsFor(agent, model) {
  const a = S.agents.find((x) => x.id === agent);
  return a?.models?.find((m) => m.id === model)?.efforts ?? a?.efforts ?? [];
}
const effortLabel = (e) => ({ xhigh: 'X-High' })[e] || e.charAt(0).toUpperCase() + e.slice(1);

function modelBadge(agent, model, effort) {
  if (agent === 'wisp') return '';
  const label = (model && S.agents.find((a) => a.id === agent)?.models?.find((x) => x.id === model)?.label) || model || 'Default model';
  const tip = `${agentName(agent)} · ${label}${effort ? ` · ${effortLabel(effort)} thinking` : ''}`;
  const logo = harnessLogo(agent);
  return `<span class="model-logo" data-tip="${esc(tip)}" aria-label="${esc(tip)}" tabindex="0">${logo}</span>`;
}
const projectById = (id) => S.config.projects.find((p) => p.id === id);

function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// --- toasts & overlays -------------------------------------------------------

function toast(html, { tone = '', action, timeout = 4200 } = {}) {
  const t = el(`<div class="toast ${tone}"><span>${html}</span>${action ? `<button class="link">${esc(action.label)}</button>` : ''}</div>`);
  if (action) t.querySelector('button').onclick = () => (action.run(), t.remove());
  $('#toasts').append(t);
  setTimeout(() => t.classList.add('out'), timeout);
  setTimeout(() => t.remove(), timeout + 400);
}

function overlay(node, { onClose } = {}) {
  const o = $('#overlay');
  o.innerHTML = '';
  o.append(node);
  o.hidden = false;
  requestAnimationFrame(() => o.classList.add('on'));
  const close = () => {
    o.classList.remove('on');
    // Another overlay may have replaced this one while it faded (palette → settings): leave that alone.
    setTimeout(() => o.firstChild === node && ((o.hidden = true), (o.innerHTML = '')), 200);
    onClose?.();
  };
  o.onclick = (e) => e.target === o && close();
  o.close = close;
  return close;
}
const closeOverlay = () => !$('#overlay').hidden && $('#overlay').close?.();

// --- feed ----------------------------------------------------------------------

function visible(list) {
  return S.filter === 'all' ? list : list.filter((s) => s.projectId === S.filter);
}

function groups() {
  const every = visible([...S.sessions.values()]);
  const all = every.filter((s) => !s.archived);
  const needs = all
    .filter((s) => s.state === 'review' || s.state === 'waiting')
    .sort((a, b) => (b.state === 'waiting') - (a.state === 'waiting') || b.updatedAt - a.updatedAt);
  // Working items keep launch order so the feed doesn't reshuffle on every tool call.
  const working = all.filter((s) => s.state === 'running').sort((a, b) => b.createdAt - a.createdAt);
  const done = all.filter((s) => s.state === 'done').sort((a, b) => b.updatedAt - a.updatedAt);
  const archived = every.filter((s) => s.archived).sort((a, b) => b.updatedAt - a.updatedAt);
  return { needs, working, done, archived };
}

function renderFeed() {
  const { needs, working, done, archived } = groups();
  const place = (sec, list, show = true) => {
    const box = $('.f-list', sec);
    sec.hidden = !list.length;
    $('h4 .n', sec).textContent = list.length || '';
    const want = show ? list : [];
    want.forEach((s, i) => {
      const { card } = item(s);
      // Only touch the DOM when the order actually changed: moving a node
      // would blur a composer the user is typing in.
      if (box.children[i] !== card) box.insertBefore(card, box.children[i] || null);
    });
    while (box.children.length > want.length) box.lastElementChild.remove();
  };
  place($('#secNeeds'), needs);
  place($('#secWorking'), working);
  place($('#secDone'), done.slice(0, 60), S.showDone);
  $('#secDone').classList.toggle('collapsed', !S.showDone);
  place($('#secArchived'), archived.slice(0, 60), S.showArchived);
  $('#secArchived').classList.toggle('collapsed', !S.showArchived);

  // Drop nodes for sessions that are gone or filtered out of the feed entirely.
  const shown = new Set([...needs, ...working, ...done, ...archived].map((s) => s.id));
  for (const [id, n] of S.nodes) if (!shown.has(id)) (n.card.remove(), S.nodes.delete(id), S.full.delete(id));

  const empty = !needs.length && !working.length && !done.length && !archived.length;
  $('#feedEmpty').hidden = !empty;
  if (empty)
    $('#feedEmpty').innerHTML = `<div class="orb big"><i></i><i></i><i></i></div><p>${S.filter === 'all' ? 'Nothing yet. Describe a task above and send it off.' : 'Nothing in this project yet.'}</p>`;
  renderFeedHead(needs, working);

  const n = [...S.sessions.values()].filter((s) => (s.state === 'review' && s.unread) || s.state === 'waiting').length;
  document.title = n ? `(${n}) wisp` : 'wisp';
  renderProjects();
}

function renderFeedHead(needs, working) {
  const parts = [];
  if (working.length) parts.push(`<span class="hs working"><i></i>${working.length} working</span>`);
  if (needs.length) parts.push(`<span class="hs needs"><i></i>${needs.length} need${needs.length === 1 ? 's' : ''} you</span>`);
  // Group headings already carry the counts; only say something when the feed is calm.
  $('#feedHead').innerHTML = parts.length ? '' : '<span class="fh-status"><span class="muted">Nothing needs you.</span></span>';
  $('#feedHead').hidden = !!parts.length;
  placeCollapseAll();
}

// "Collapse all" floats over the page instead of living in the flow: showing it
// never shifts the feed, and it stays reachable deep inside a long open card.
const collapseAllBtn = el(`<button class="collapse-all" title="Collapse all (C) · Esc collapses the focused one"><span></span><kbd>C</kbd></button>`);
document.body.append(collapseAllBtn);
const collapseAll = () => [...S.open].forEach((id) => collapse(id));
collapseAllBtn.addEventListener('click', collapseAll);
function placeCollapseAll() {
  const open = [...S.open].filter((id) => S.nodes.get(id)?.card.isConnected).length;
  collapseAllBtn.classList.toggle('on', open > 0);
  if (open) collapseAllBtn.firstChild.textContent = open > 1 ? `Collapse all · ${open}` : 'Collapse';
}

// Get (or create) the card for a summary and refresh its header.
function item(s) {
  let n = S.nodes.get(s.id);
  if (!n) {
    const card = el(`<article class="item" data-id="${s.id}"><div class="it-head" role="button" tabindex="-1"></div></article>`);
    n = { card, head: $('.it-head', card), body: null, turnNodes: new Map(), tray: null, showAll: false, unfolded: new Set(), latestTurn: null };
    S.nodes.set(s.id, n);
    n.head.addEventListener('click', (e) => {
      if (n.head.querySelector('[contenteditable="true"]')) return;
      if (e.target.closest('[data-a="quick-done"]')) return toggleDone(s.id);
      setFocus(s.id);
      toggle(s.id);
    });
    card.addEventListener('mousedown', () => setFocus(s.id, { scroll: false }));
    n.head.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      setFocus(s.id, { scroll: false });
      taskMenu(s.id, e);
    });
    if (S.open.has(s.id)) expand(s.id, { scroll: false });
  }
  renderHead(n, s);
  return n;
}

function renderHead(n, s) {
  if (n.head.querySelector('[contenteditable="true"]')) return;
  const open = S.open.has(s.id);
  const live = s.state === 'running' || s.state === 'waiting';
  const pill =
    s.state === 'waiting'
      ? `<span class="pill st-waiting"><i></i>Asking</span>`
      : s.state === 'review'
        ? `<span class="pill st-${s.status}"><i></i>${STATUS_LABEL[s.status] || 'Done'}</span>`
        : '';
  n.card.className = `item c-${s.color} st-${s.state} ${s.unread ? 'unread' : ''} ${open ? 'open' : ''} ${S.focus === s.id ? 'focused' : ''}`;
  n.head.innerHTML = `
    <span class="q-dot ${s.state === 'running' ? 'live' : ''} ${s.state === 'waiting' ? 'waiting' : ''}"></span>
    <span class="it-main">
      <span class="it-title">${esc(s.title)}</span>
      ${live ? `<span class="q-live ${s.state}">${esc(s.live)}</span>` : open ? '' : `<span class="it-sub">${esc(s.preview || '')}</span>`}
    </span>
    <span class="it-side">
      ${pill}
      ${s.queued ? `<span class="q-queued" title="Follow-ups queued">+${s.queued}</span>` : ''}
      ${modelBadge(s.agent, s.model, s.effort)}
      <span class="q-proj">${esc(s.project)}</span>
      <span class="q-time">${ago(s.updatedAt)}</span>
      ${s.state === 'review' && !open && !s.archived ? `<button class="it-quick" data-a="quick-done" title="Mark done (E)">${icon('done')}</button>` : ''}
      ${icon('chevron', 'chev')}
    </span>`;
}

function setFocus(id, { scroll = true } = {}) {
  if (S.focus === id) return;
  S.nodes.get(S.focus)?.card.classList.remove('focused');
  S.focus = id;
  const n = S.nodes.get(id);
  n?.card.classList.add('focused');
  if (scroll) n?.card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function toggle(id) {
  S.open.has(id) ? collapse(id) : expand(id);
}

async function expand(id, { scroll = true } = {}) {
  const n = S.nodes.get(id);
  if (!n) return;
  S.open.add(id);
  saveOpen();
  n.card.classList.add('open');
  renderHead(n, S.sessions.get(id));
  if (!n.body) {
    n.body = el(`<div class="it-body"><div class="it-loading"><span class="orb tiny"></span>Loading…</div></div>`);
    n.card.append(n.body);
  }
  renderFeedHead(groups().needs, groups().working);
  if (scroll) requestAnimationFrame(() => n.card.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  if (!S.full.has(id)) await fetchFull(id);
  else renderBody(id, { fresh: true });
}

function collapse(id) {
  const n = S.nodes.get(id);
  S.open.delete(id);
  saveOpen();
  S.full.delete(id);
  if (n) {
    n.body?.remove();
    n.body = null;
    n.turnNodes.clear();
    n.tray = null;
    n.showAll = false;
    n.card.classList.remove('open');
    const s = S.sessions.get(id);
    if (s) renderHead(n, s);
  }
  renderFeedHead(groups().needs, groups().working);
}

async function fetchFull(id) {
  const s = await api(`/sessions/${id}`).catch(() => null);
  if (!s) {
    S.open.delete(id);
    saveOpen();
    return;
  }
  if (!S.open.has(id)) return; // collapsed while loading
  const fresh = !S.full.has(id);
  S.full.set(id, s);
  renderBody(id, { fresh });
  if (s.unread && s.state !== 'running' && document.hasFocus()) api(`/sessions/${id}`, { method: 'PATCH', body: { unread: false } }).catch(() => {});
}

const refetchTimers = new Map();
function scheduleRefetch(id) {
  if (!S.open.has(id)) return;
  clearTimeout(refetchTimers.get(id));
  refetchTimers.set(id, setTimeout(() => (refetchTimers.delete(id), fetchFull(id)), 120));
}

// --- attachments ---------------------------------------------------------------

function attachTray() {
  const items = [];
  const node = el(`<div class="tray" hidden></div>`);
  const fileInput = el(`<input type="file" multiple hidden>`);
  document.body.append(fileInput);
  const render = () => {
    node.hidden = !items.length;
    node.innerHTML = items
      .map(
        (it, i) => `<div class="att ${it.status}" data-i="${i}" title="${esc(it.name)}">
          ${it.thumb ? `<img src="${it.thumb}" alt="">` : `<span class="att-ic">${icon(it.mime.startsWith('video') ? 'web' : 'file')}</span>`}
          <span class="att-name">${esc(it.name)}</span><span class="att-size">${fmtSize(it.size)}</span>
          <button class="att-x" title="Remove">${icon('x')}</button>
        </div>`,
      )
      .join('');
  };
  node.addEventListener('click', (e) => {
    const x = e.target.closest('.att-x');
    if (x) {
      items.splice(Number(x.closest('.att').dataset.i), 1);
      render();
    }
  });
  const add = (files) => {
    for (const f of files) {
      const it = { name: f.name || 'pasted', size: f.size, mime: f.type || '', status: 'uploading', thumb: f.type.startsWith('image/') ? URL.createObjectURL(f) : null };
      items.push(it);
      it.promise = fetch(`/api/uploads?name=${encodeURIComponent(it.name)}&type=${encodeURIComponent(it.mime)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: f,
      })
        .then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error)))))
        .then((j) => ((it.id = j.id), (it.status = 'ready'), render()))
        .catch((err) => ((it.status = 'failed'), render(), toast(`Upload failed: ${esc(err.message)}`, { tone: 'bad' })));
    }
    render();
  };
  fileInput.onchange = () => (add(fileInput.files), (fileInput.value = ''));
  return {
    node,
    add,
    pick: () => fileInput.click(),
    async ids() {
      await Promise.allSettled(items.map((i) => i.promise));
      return items.filter((i) => i.id).map((i) => i.id);
    },
    clear() {
      items.length = 0;
      render();
    },
    get busy() {
      return items.some((i) => i.status === 'uploading');
    },
  };
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Wire paste + drag/drop of files onto a container.
function acceptFiles(container, textarea, tray) {
  textarea.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      tray.add(files);
    }
  });
  container.addEventListener('dragover', (e) => {
    if ([...e.dataTransfer.types].includes('Files')) {
      e.preventDefault();
      e.stopPropagation();
      container.classList.add('drop');
    }
  });
  container.addEventListener('dragleave', (e) => !container.contains(e.relatedTarget) && container.classList.remove('drop'));
  container.addEventListener('drop', (e) => {
    container.classList.remove('drop');
    if (e.dataTransfer.files.length) {
      e.preventDefault();
      e.stopPropagation();
      tray.add(e.dataTransfer.files);
    }
  });
}

function autosize(ta, max = 340) {
  const fit = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(max, ta.scrollHeight)}px`;
  };
  ta.addEventListener('input', fit);
  requestAnimationFrame(fit);
  return fit;
}

// --- launcher ----------------------------------------------------------------------

let launchProject = load('wisp.launchProject', null);

function renderLauncher() {
  const box = $('#launcher');
  const mode = S.config.defaults.mode || 'edits';
  const ready = S.agents.filter((a) => a.available);
  const chosen = S.agents.find((a) => a.id === (S.config.defaults.agent || 'claude'));
  let agent = chosen?.available ? chosen : ready[0] || chosen || S.agents[0];
  box.innerHTML = `
    <div class="l-projects"></div>
    <textarea id="prompt" rows="2" spellcheck="false"></textarea>
    <div class="l-bar">
      <button class="icon-btn" id="attach" title="Attach files">${icon('clip')}</button>
      <button class="mode-btn" id="mode" aria-haspopup="menu"></button>
      <button class="runner-btn" id="runner" title="Harness and model" aria-haspopup="dialog"></button>
      <span class="grow"></span>
      <button class="send" id="launch" title="Launch (Enter · Shift+Enter for newline)">${icon('enter')}</button>
    </div>`;
  renderLaunchChips();

  const ta = $('#prompt', box);
  const tray = attachTray();
  ta.before(tray.node);
  acceptFiles(box, ta, tray);
  autosize(ta);
  ta.value = S.drafts.get('home') || '';
  ta.addEventListener('input', () => S.drafts.set('home', ta.value));
  // While focus is elsewhere, the placeholder advertises the shortcut that brings you back.
  const hint = () => (ta.placeholder = document.activeElement === ta
    ? 'What should I go do? Paste screenshots, drop logs or videos…'
    : `What should I go do? Press ${combo('L')} to start typing`);
  ta.addEventListener('focus', hint);
  ta.addEventListener('blur', hint);
  hint();
  $('#attach', box).onclick = tray.pick;

  // Mode is set-and-forget, so it's one small button: just an icon on the default (Edits),
  // spelled out when it's Plan or Full auto so you can't miss it.
  let curMode = mode;
  const modeBtn = $('#mode', box);
  const paintMode = () => {
    const m = MODES.find((x) => x.id === curMode) || MODES[1];
    modeBtn.className = `mode-btn m-${m.id}`;
    modeBtn.innerHTML = `${icon(m.icon)}${m.id === 'edits' ? '' : `<span>${m.label}</span>`}`;
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
  // The model is remembered per harness (ids aren't portable between them).
  const savedModel = (id) => {
    const d = S.config.defaults;
    const want = d.models?.[id] ?? (id === d.agent ? d.model : '');
    const models = S.agents.find((a) => a.id === id)?.models || [];
    return models.some((m) => m.id === want) ? want : '';
  };
  // Thinking level too, and only if the chosen model still accepts it.
  const savedEffort = (id, model) => {
    const d = S.config.defaults;
    const want = d.efforts?.[id] ?? (id === d.agent ? d.effort : '');
    return effortsFor(id, model).includes(want) ? want : '';
  };
  let curModel = savedModel(agent?.id);
  let curEffort = savedEffort(agent?.id, curModel);
  const runnerBtn = $('#runner', box);
  const paintRunner = () => {
    const m = (agent?.models || []).find((x) => x.id === curModel);
    runnerBtn.innerHTML = `<span class="rb-logo">${harnessLogo(agent?.id)}</span><span class="rb-h">${esc(agent?.name || 'No agent')}</span><span class="rb-m">${esc(m && m.id ? m.label : 'Default')}</span>${curEffort ? `<span class="rb-e">${esc(effortLabel(curEffort))}</span>` : ''}${icon('chevron', 'chev')}`;
    runnerBtn.title = `Harness, model and thinking level${curEffort ? `\nThinking: ${effortLabel(curEffort)}` : ''}`;
  };
  paintRunner();
  runnerBtn.onclick = () =>
    runnerPicker(runnerBtn, { agent: agent?.id, model: curModel, effort: curEffort, savedModel, savedEffort }, (id, model, effort) => {
      agent = S.agents.find((a) => a.id === id);
      curModel = model;
      curEffort = effort;
      paintRunner();
      const d = S.config.defaults;
      const models = { ...d.models, [id]: model };
      // A model without levels leaves the harness's saved level alone, so switching back restores it.
      const efforts = effort || effortsFor(id, model).length ? { ...d.efforts, [id]: effort } : d.efforts;
      Object.assign(d, { agent: id, model, models, effort, efforts });
      api('/config', { method: 'PATCH', body: { defaults: { agent: id, model, models, effort, efforts } } }).catch(() => {});
    });

  const launch = async () => {
    const prompt = ta.value.trim();
    if (!prompt) return ta.focus();
    const project = projectById(launchProject);
    if (!project) return openProjects({ focusAdd: true });
    const btn = $('#launch', box);
    btn.disabled = true;
    try {
      const attachments = await tray.ids();
      const s = await api('/sessions', { method: 'POST', body: { prompt, cwd: project.path, agent: agent?.id || 'claude', mode: curMode, model: curModel, effort: curEffort, attachments } });
      S.sessions.set(s.id, s);
      ta.value = '';
      S.drafts.delete('home');
      tray.clear();
      ta.dispatchEvent(new Event('input'));
      if (S.filter !== 'all' && S.filter !== s.projectId) {
        S.filter = 'all';
        save('wisp.filter', S.filter);
      }
      renderFeed();
      launchedFx(btn, S.nodes.get(s.id)?.card);
      askNotify();
    } catch (err) {
      toast(esc(err.message), { tone: 'bad' });
    } finally {
      btn.disabled = false;
      ta.focus();
    }
  };
  $('#launch', box).onclick = launch;
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      launch();
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      setMode(MODES[(MODES.findIndex((m) => m.id === curMode) + 1) % MODES.length].id);
    }
  });
}

function modeMenu(anchor, current, pick) {
  const open = $('.menu.mode');
  if (open) return open.close();
  const menu = el(`
    <div class="menu mode" role="menu">
      ${MODES.map((m) => `<button role="menuitemradio" aria-checked="${m.id === current}" data-mode="${m.id}" class="m-${m.id}${m.id === current ? ' on' : ''}">
        ${icon(m.icon)}<span class="mm-text"><b>${m.label}</b><small>${esc(m.hint)}</small></span>${icon('check', 'mm-check')}
      </button>`).join('')}
    </div>`);
  const close = () => (menu.remove(), anchor.classList.remove('open'), document.removeEventListener('mousedown', outside));
  const outside = (ev) => !menu.contains(ev.target) && !anchor.contains(ev.target) && close();
  menu.close = close;
  setTimeout(() => document.addEventListener('mousedown', outside));
  menu.onclick = (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    close();
    pick(b.dataset.mode);
    $('#prompt')?.focus();
  };
  menu.addEventListener('keydown', (ev) => {
    const items = $$('button', menu);
    const i = items.indexOf(document.activeElement);
    if (ev.key === 'Escape') (close(), anchor.focus());
    else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      items[(i + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    }
  });
  document.body.append(menu);
  anchor.classList.add('open');
  const r = anchor.getBoundingClientRect();
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${r.bottom + 6 + h < innerHeight - 8 ? r.bottom + 6 : r.top - 6 - h}px`;
  $('button.on', menu)?.focus();
}

function renderLaunchChips() {
  const box = $('#launcher .l-projects');
  if (!box) return;
  const projects = S.config.projects.slice().sort((a, b) => (b.lastUsedAt || b.addedAt) - (a.lastUsedAt || a.addedAt));
  if (S.filter !== 'all' && projectById(S.filter)) launchProject = S.filter;
  if (!projectById(launchProject)) launchProject = projects[0]?.id || null;
  box.innerHTML = `
    <span class="l-in">in</span>
    ${projects.map((p) => `<button class="lp-chip c-${p.color} ${p.id === launchProject ? 'on' : ''}" data-id="${p.id}" title="${esc(p.path)}"><i class="p-dot"></i>${esc(p.name)}</button>`).join('')}
    <button class="lp-chip add" id="lpAdd">${icon('folder')}${projects.length ? 'Other folder…' : 'Choose a project folder…'}</button>`;
  $$('.lp-chip[data-id]', box).forEach((b) =>
    b.addEventListener('click', () => {
      launchProject = b.dataset.id;
      save('wisp.launchProject', launchProject);
      $$('.lp-chip', box).forEach((x) => x.classList.toggle('on', x === b));
    }),
  );
  $('#lpAdd', box).onclick = () => openProjects({ focusAdd: true });
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

// --- project filter (top bar) ---------------------------------------------------

function renderProjects() {
  const all = [...S.sessions.values()];
  const stats = (pid) => {
    const l = pid === 'all' ? all : all.filter((s) => s.projectId === pid);
    return { run: l.filter((s) => s.state === 'running').length, need: l.filter((s) => s.state === 'waiting' || (s.state === 'review' && s.unread)).length };
  };
  const chip = (id, name, color) => {
    const st = stats(id);
    return `<button class="p-chip ${S.filter === id ? 'on' : ''} c-${color}" data-id="${id}" title="${esc(id === 'all' ? 'All projects' : projectById(id)?.path || '')}">
      ${id === 'all' ? '' : '<i class="p-dot"></i>'}<span>${esc(name)}</span>${st.run ? `<span class="p-run" title="${st.run} working"></span>` : ''}${st.need ? `<span class="p-need">${st.need}</span>` : ''}
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
  const close = () => (menu.remove(), document.removeEventListener('mousedown', outside));
  const outside = (ev) => !menu.contains(ev.target) && close();
  menu.close = close;
  setTimeout(() => document.addEventListener('mousedown', outside));
  menu.onclick = async (ev) => {
    const a = ev.target.closest('button')?.dataset.a;
    close();
    if (a === 'manage') openProjects();
    if (a === 'delete' && confirm(`Remove “${p.name}” from wisp? Sessions and files are kept.`)) {
      try {
        await api(`/projects/${id}`, { method: 'DELETE' });
      } catch (err) {
        return toast(esc(err.message), { tone: 'bad' });
      }
      if (S.filter === id) {
        S.filter = 'all';
        save('wisp.filter', S.filter);
      }
      await loadConfig();
      renderFeed();
    }
  };
  document.body.append(menu);
  // Keep the menu on-screen when right-clicking near the window edge.
  const r = menu.getBoundingClientRect();
  if (r.right > innerWidth - 8) menu.style.left = `${innerWidth - r.width - 8}px`;
  if (r.bottom > innerHeight - 8) menu.style.top = `${innerHeight - r.height - 8}px`;
}

// --- expanded item body ------------------------------------------------------------

function ctxFor(s, turn, isLatest) {
  return {
    session: s,
    turn,
    isLatest,
    reply: (text) => sendReply(s.id, text),
    draft: (text) => {
      const ta = $('.reply', S.nodes.get(s.id)?.card);
      if (!ta) return;
      ta.value = text;
      ta.dispatchEvent(new Event('input'));
      ta.focus();
      ta.setSelectionRange(text.length, text.length);
    },
    openFile: (p, line) => openInEditor(s, p, line),
    fileUrl: (p) => `/api/sessions/${s.id}/file?path=${encodeURIComponent(p)}`,
    zoom: (src) => overlay(el(`<img class="lightbox" src="${esc(src)}">`)),
  };
}

// Older turns render as one-line folded rows; past this many they hide behind "Show earlier".
const VISIBLE_TURNS = 8;

function renderBody(id, { fresh }) {
  const s = S.full.get(id);
  const n = S.nodes.get(id);
  if (!s || !n) return;
  const summary = S.sessions.get(id) || {};

  if (fresh || !n.body?.querySelector('.turns')) {
    n.turnNodes.clear();
    const body = el(`
      <div class="it-body">
        <div class="it-bar">
          <div class="it-meta"></div>
          <div class="it-actions">
            <button class="ghost xs" data-a="replay" title="Replay presentation (R)">${icon('replay')}</button>
            <button class="ghost xs" data-a="takeover" title="Take over in your terminal (T)">${icon('terminal')}<span>Take over</span></button>
            <button class="ghost xs" data-a="done" title="Mark done (E)">${icon('done')}<span>Done</span></button>
            <button class="ghost xs" data-a="more" title="More">${icon('dots')}</button>
          </div>
        </div>
        <button class="link xs earlier" hidden></button>
        <div class="turns"></div>
        <div class="it-dock"></div>
      </div>`);
    n.body ? n.body.replaceWith(body) : n.card.append(body);
    n.body = body;
    $('.it-bar', body).addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'replay') replay(id);
      if (a === 'takeover') takeOver(id);
      if (a === 'done') toggleDone(id);
      if (a === 'more') moreMenu(id, e.target.closest('button'));
    });
    $('.earlier', body).onclick = () => ((n.showAll = true), renderBody(id, { fresh: false }));
    renderDock(id);
  }

  const body = n.body;
  const proj = projectById(summary.projectId);
  $('.it-meta', body).innerHTML = `
    <span class="m">${esc(agentName(s.agent))}</span>
    <span class="m">${esc(MODES.find((m) => m.id === s.mode)?.label || s.mode)}</span>
    ${s.model ? `<span class="m">${esc(s.model)}</span>` : ''}
    ${s.effort ? `<span class="m">${esc(effortLabel(s.effort))} thinking</span>` : ''}
    <span class="m path" title="${esc(s.cwd)}">${esc((proj?.path || s.cwd).replace(S.config.home || '', '~'))}</span>`;
  // Done lives both in the top bar and next to the composer, so it's reachable after reading.
  $$('[data-a="done"]', body).forEach((b) => {
    b.classList.toggle('on', s.state === 'done');
    b.hidden = s.state === 'running' || s.state === 'waiting';
    $('span', b).textContent = s.state === 'done' ? 'Reopen' : b.closest('.c-bar') ? 'Mark done' : 'Done';
  });
  $('[data-a="takeover"]', body).hidden = !s.agentSessionId;

  // Turns: keep nodes whose content hasn't changed so animations don't replay.
  const turnsEl = $('.turns', body);
  const turns = n.showAll ? s.turns : s.turns.slice(-VISIBLE_TURNS);
  const hiddenCount = s.turns.length - turns.length;
  const earlier = $('.earlier', body);
  earlier.hidden = !hiddenCount;
  earlier.textContent = `Show ${hiddenCount} earlier turn${hiddenCount === 1 ? '' : 's'}`;
  // A new turn re-folds everything older, so the latest exchange is what's open by default.
  const latestId = s.turns.at(-1)?.id;
  if (n.latestTurn !== latestId) (n.unfolded.clear(), (n.latestTurn = latestId));
  const keep = new Set();
  let firstNew = null;
  turns.forEach((t) => {
    const isLatest = t.id === latestId;
    const folded = !isLatest && !n.unfolded.has(t.id);
    const key = `${t.status}|${isLatest}|${folded}|${t.status === 'running' ? (s.ask?.id || '') + s.queue?.length : ''}`;
    const prev = n.turnNodes.get(t.id);
    let node = prev?.node;
    if (!prev || prev.key !== key) {
      const toggle = () => (n.unfolded.has(t.id) ? n.unfolded.delete(t.id) : n.unfolded.add(t.id), renderBody(id, { fresh: false }));
      node = folded ? renderFoldedTurn(t, toggle) : renderTurn(s, t, isLatest, isLatest ? null : toggle);
      if (prev) prev.node.replaceWith(node);
      if (!prev && !fresh && !folded) firstNew ??= node;
      if (prev && prev.status === 'running' && t.status !== 'running') firstNew ??= node;
      n.turnNodes.set(t.id, { key, node, status: t.status });
    }
    keep.add(t.id);
    turnsEl.append(node); // re-append keeps order
  });
  for (const [tid, v] of n.turnNodes) if (!keep.has(tid)) (v.node.remove(), n.turnNodes.delete(tid));

  updateDock(id);
  if (firstNew && isInView(n.card)) requestAnimationFrame(() => firstNew.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function isInView(node) {
  const r = node.getBoundingClientRect();
  return r.bottom > 0 && r.top < innerHeight;
}

function renderFoldedTurn(t, unfold) {
  const hero = t.presentation?.blocks?.find((b) => b.type === 'hero');
  const node = el(`
    <article class="turn folded" data-turn="${t.id}">
      <button class="t-fold" title="Show this exchange">
        ${icon('chevron', 'chev')}
        <span class="t-prompt">${esc(t.prompt.replace(/\s+/g, ' '))}</span>
        ${hero?.title ? `<span class="t-result">${esc(hero.title)}</span>` : ''}
        <time>${new Date(t.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
      </button>
    </article>`);
  $('.t-fold', node).onclick = unfold;
  return node;
}

// `fold` is set for older turns the user unfolded, so they can tuck them away again.
function renderTurn(s, t, isLatest, fold) {
  const node = el(`<article class="turn" data-turn="${t.id}"></article>`);
  const long = t.prompt.length > 360 || t.prompt.split('\n').length > 5;
  const ask = el(`
    <div class="ask">
      <div class="ask-text ${long ? 'clamped' : ''}">${esc(t.prompt)}</div>
      ${long ? '<button class="link xs more-btn">Show all</button>' : ''}
      ${t.attachments?.length ? `<div class="ask-atts">${t.attachments.map((a) => (a.mime?.startsWith('image/') ? `<img src="/api/uploads/${a.id}" alt="${esc(a.name)}" title="${esc(a.name)}">` : `<a class="att-pill" href="/api/uploads/${a.id}" target="_blank">${icon('file')}${esc(a.name)}</a>`)).join('')}</div>` : ''}
      <div class="ask-foot">${modelBadge(t.agent || s.agent, t.model ?? s.model, t.effort ?? s.effort)}<time>${new Date(t.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></div>
      ${fold ? `<button class="ghost xs t-unfold" title="Collapse this exchange">${icon('chevron', 'chev')}</button>` : ''}
    </div>`);
  if (fold) ask.querySelector('.t-unfold').onclick = fold;
  ask.querySelector('.more-btn')?.addEventListener('click', (e) => {
    ask.querySelector('.ask-text').classList.toggle('clamped');
    e.target.textContent = ask.querySelector('.ask-text').classList.contains('clamped') ? 'Show all' : 'Show less';
  });
  ask.querySelectorAll('.ask-atts img').forEach((img) => img.addEventListener('click', () => overlay(el(`<img class="lightbox" src="${img.src}">`))));
  node.append(ask);

  if (t.status === 'running') {
    node.append(renderWorking(s, t));
  } else {
    node.append(renderPresentation(t.presentation, ctxFor(s, t, isLatest)));
    node.append(renderTrail(s, t));
  }
  return node;
}

function renderWorking(s, t) {
  const waiting = !!s.ask;
  const node = el(`
    <div class="w-panel ${waiting ? 'waiting' : ''}">
      <div class="w-orb"><div class="orb live"><i></i><i></i><i></i></div></div>
      <div class="w-body">
        <div class="w-status">
          <b>${waiting ? `${esc(agentName(s.agent))} is waiting for you` : `${esc(agentName(s.agent))} is working`}</b>
          <span class="elapsed" data-start="${t.startedAt}">${fmtDuration(Date.now() - t.startedAt)}</span>
          <span class="w-count">${t.activity.filter((a) => a.kind !== 'text').length} actions</span>
        </div>
        <div class="ask-slot"></div>
        <ul class="ticker"></ul>
        <div class="w-actions">
          <button class="link xs peek">Show all activity</button>
          ${s.queue?.length ? `<span class="w-queued">${s.queue.length} follow-up${s.queue.length > 1 ? 's' : ''} queued</span>` : ''}
          <span class="grow"></span>
          <button class="ghost sm danger stop">${icon('stop')}Stop</button>
        </div>
        <ul class="log" hidden></ul>
      </div>
    </div>`);
  if (waiting) $('.ask-slot', node).append(renderAskCard(s));
  const ticker = $('.ticker', node);
  t.activity
    .filter((a) => a.kind !== 'text')
    .slice(-5)
    .forEach((a) => ticker.prepend(actItem(a)));
  $('.stop', node).onclick = async () => {
    await api(`/sessions/${s.id}/stop`, { method: 'POST', body: {} }).catch((e) => toast(esc(e.message), { tone: 'bad' }));
  };
  $('.peek', node).onclick = (e) => {
    const log = $('.log', node);
    log.hidden = !log.hidden;
    e.target.textContent = log.hidden ? 'Show all activity' : 'Hide activity';
    if (!log.hidden) log.innerHTML = t.activity.map((a) => actItem(a).outerHTML).join('');
  };
  return node;
}

function actItem(a) {
  return el(`<li class="act k-${a.kind}">${icon(KIND_ICON[a.kind] || 'tool')}<span>${esc(a.label || '')}</span></li>`);
}

function renderAskCard(s) {
  const a = s.ask;
  const node = el(`
    <div class="ask-card">
      <div class="q-head">${icon('ask')}<span>Needs your call</span></div>
      <p class="q-text">${esc(a.question)}</p>
      ${a.context ? `<div class="prose q-context">${md(a.context)}</div>` : ''}
      ${a.options?.length ? `<div class="q-opts">${a.options.map((o, i) => `<button class="opt" data-i="${i}"><span class="k">${i + 1}</span>${esc(o)}</button>`).join('')}</div>` : ''}
      <form class="q-own"><input placeholder="${a.options?.length ? 'Or answer in your own words…' : 'Your answer…'}"><button class="primary sm">Answer</button></form>
    </div>`);
  const answer = async (text) => {
    if (!text.trim()) return;
    node.classList.add('sent');
    await api(`/sessions/${s.id}/answer`, { method: 'POST', body: { text } }).catch((e) => toast(esc(e.message), { tone: 'bad' }));
  };
  node.addEventListener('click', (e) => {
    const b = e.target.closest('.opt');
    if (b) answer(a.options[b.dataset.i]);
  });
  $('form', node).onsubmit = (e) => (e.preventDefault(), answer($('input', node).value));
  return node;
}

function renderTrail(s, t) {
  const acts = t.activity || [];
  const count = (k) => acts.filter((a) => a.kind === k).length;
  const parts = [
    ['read', 'read', count('read')],
    ['pen', 'edited', count('edit')],
    ['terminal', 'ran', count('run')],
    ['search', 'searched', count('search')],
    ['web', 'web', count('web')],
  ].filter((p) => p[2]);
  const totals = (t.changes || []).reduce((acc, c) => {
    const n = countChanges(c.edits);
    return { add: acc.add + n.add, del: acc.del + n.del };
  }, { add: 0, del: 0 });
  const st = t.stats || {};
  const node = el(`
    <div class="trail">
      <div class="trail-bar">
        ${parts.map(([ic, l, n]) => `<span class="tb" title="${n} ${l}">${icon(ic)}${n}</span>`).join('')}
        ${t.endedAt ? `<span class="tb">${fmtDuration(t.endedAt - t.startedAt)}</span>` : ''}
        ${st.costUsd ? `<span class="tb">$${st.costUsd.toFixed(2)}</span>` : ''}
        <span class="grow"></span>
        ${t.changes?.length ? `<button class="link xs" data-tab="changes">${t.changes.length} file${t.changes.length > 1 ? 's' : ''} <span class="plus">+${totals.add}</span> <span class="minus">−${totals.del}</span></button>` : ''}
        ${acts.length ? `<button class="link xs" data-tab="activity">Activity</button>` : ''}
        ${t.presentation?.notes ? `<button class="link xs" data-tab="notes">Agent notes</button>` : ''}
      </div>
      <div class="trail-body" hidden></div>
    </div>`);
  const body = $('.trail-body', node);
  let open = null;
  node.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    const tab = b.dataset.tab;
    $$('[data-tab]', node).forEach((x) => x.classList.toggle('on', x === b && open !== tab));
    if (open === tab) {
      open = null;
      body.hidden = true;
      return;
    }
    open = tab;
    body.hidden = false;
    body.innerHTML = '';
    if (tab === 'activity') body.append(el(`<ul class="log">${acts.map((a) => actItem(a).outerHTML).join('')}</ul>`));
    if (tab === 'notes') body.append(el(`<div class="prose">${md(t.presentation.notes)}</div>`));
    if (tab === 'changes') {
      body.append(renderPresentation({ blocks: t.changes.map((c) => ({ type: 'diff', file: c.file })) }, ctxFor(s, t, false)));
    }
  });
  return node;
}

// Live activity without re-rendering the whole turn.
function onActivity({ sessionId, turnId, item }) {
  const s = S.full.get(sessionId);
  if (!s) return;
  const turn = s.turns.find((t) => t.id === turnId);
  if (turn && !turn.activity.includes(item)) turn.activity.push(item);
  const node = S.nodes.get(sessionId)?.turnNodes.get(turnId)?.node;
  if (!node || item.kind === 'text') return;
  const ticker = $('.ticker', node);
  if (ticker) {
    const li = actItem(item);
    li.classList.add('new');
    ticker.prepend(li);
    while (ticker.children.length > 5) ticker.lastElementChild.remove();
  }
  const log = $('.log', node);
  if (log && !log.hidden) log.append(actItem(item));
  const c = $('.w-count', node);
  if (c && turn) c.textContent = `${turn.activity.filter((a) => a.kind !== 'text').length} actions`;
}

// --- per-item composer ---------------------------------------------------------

function renderDock(id) {
  const n = S.nodes.get(id);
  const dock = $('.it-dock', n.body);
  const comp = el(`
    <div class="composer">
      <ul class="c-queued"></ul>
      <textarea class="reply" rows="1" spellcheck="false"></textarea>
      <div class="c-bar">
        <button class="icon-btn c-attach" title="Attach files">${icon('clip')}</button>
        <span class="c-hint"></span>
        <button class="ghost sm c-done" data-a="done" title="Mark done (E)">${icon('done')}<span>Mark done</span></button>
        <button class="ghost xs c-queue" hidden>${icon('queue')}<span>Queue</span></button>
        <button class="send" title="Send (Enter · Shift+Enter for newline)">${icon('enter')}</button>
      </div>
    </div>`);
  dock.append(comp);
  n.tray = attachTray();
  comp.prepend(n.tray.node);
  const ta = $('.reply', comp);
  autosize(ta, 260);
  acceptFiles(comp, ta, n.tray);
  $('.c-attach', comp).onclick = n.tray.pick;
  $('.c-done', comp).onclick = () => toggleDone(id);
  $('.c-queue', comp).onclick = toggleQueue;
  ta.value = S.drafts.get(id) || '';
  ta.addEventListener('input', () => S.drafts.set(id, ta.value));
  ta.addEventListener('focus', () => setFocus(id, { scroll: false }));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendReply(id, ta.value);
    }
  });
  $('.send', comp).onclick = () => sendReply(id, ta.value);
}

function updateDock(id) {
  const s = S.full.get(id);
  const n = S.nodes.get(id);
  const ta = n && $('.reply', n.card);
  if (!s || !ta) return;
  const name = agentName(s.agent);
  const tour = s.agent === 'wisp';
  ta.disabled = tour;
  ta.placeholder = tour
    ? 'This is the tour — launch a real wisp from the box at the top'
    : s.ask
      ? `Answer ${name}…`
      : s.state === 'running'
        ? queueing()
          ? `Queue a follow-up — sent when ${name} finishes`
          : `Steer ${name} — interrupts and sends now`
        : s.state === 'done'
          ? 'Follow up to reopen…'
          : `Follow up with ${name}…`;
  $('.c-hint', n.card).innerHTML = s.queue?.length ? `${s.queue.length} queued` : '';
  renderQueued(s, $('.c-queued', n.card), name);
  const q = $('.c-queue', n.card);
  q.hidden = tour || s.state !== 'running';
  q.classList.toggle('on', queueing());
  q.title = queueing()
    ? `Queueing: follow-ups wait until ${name} finishes. Click to send now instead.`
    : `Sending now: follow-ups interrupt ${name}. Click to queue them instead.`;
}

// Follow-ups waiting their turn, shown above the composer so it's clear what goes out next.
function renderQueued(s, list, name) {
  const key = (s.queue || []).map((q) => q.id).join();
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  list.innerHTML = '';
  (s.queue || []).forEach((q, i) => {
    const li = el(`
      <li class="cq">
        <span class="cq-tag">${i === 0 ? `Next · after ${esc(name)} finishes` : `Queued #${i + 1}`}</span>
        <span class="cq-text">${esc(q.text)}</span>
        <button class="att-x" title="Cancel this follow-up">${icon('x')}</button>
      </li>`);
    const cancel = () => {
      // Items queued by a wisp older than queue ids get one when wisp restarts.
      if (!q.id) return toast('Restart wisp to cancel this follow-up.', { tone: 'bad' });
      const short = q.text.length > 80 ? `${q.text.slice(0, 80)}…` : q.text;
      if (!confirm(`Cancel this queued follow-up?\n\n“${short}”`)) return;
      api(`/sessions/${s.id}/queue?item=${encodeURIComponent(q.id)}`, { method: 'DELETE' }).catch((err) => toast(esc(err.message), { tone: 'bad' }));
    };
    $('.att-x', li).onclick = cancel;
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      queuedMenu(e, cancel);
    });
    list.append(li);
  });
}

// Right-click on a queued follow-up.
function queuedMenu(e, cancel) {
  $('.menu.queued')?.close();
  const menu = el(`
    <div class="menu queued" style="top:${e.clientY}px;left:${e.clientX}px">
      <button data-a="cancel" class="danger">${icon('x')}Cancel follow-up</button>
    </div>`);
  const close = () => (menu.remove(), document.removeEventListener('mousedown', outside));
  const outside = (ev) => !menu.contains(ev.target) && close();
  menu.close = close;
  setTimeout(() => document.addEventListener('mousedown', outside));
  menu.onclick = (ev) => {
    const a = ev.target.closest('button')?.dataset.a;
    close();
    if (a === 'cancel') cancel();
  };
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  if (r.right > innerWidth - 8) menu.style.left = `${innerWidth - r.width - 8}px`;
  if (r.bottom > innerHeight - 8) menu.style.top = `${innerHeight - r.height - 8}px`;
}

// Follow-ups sent while an agent works interrupt it, unless the user flipped this on.
const queueing = () => S.config?.defaults?.followUp === 'queue';

async function toggleQueue() {
  const followUp = queueing() ? 'now' : 'queue';
  S.config.defaults.followUp = followUp;
  S.nodes.forEach((_, id) => updateDock(id));
  await api('/config', { method: 'PATCH', body: { defaults: { followUp } } }).catch((err) => toast(esc(err.message), { tone: 'bad' }));
}

async function sendReply(id, text) {
  const s = S.full.get(id);
  const n = S.nodes.get(id);
  text = (text || '').trim();
  if (!s || !text) return;
  if (n?.tray?.busy) toast('Waiting for uploads…');
  const attachments = n?.tray ? await n.tray.ids() : [];
  try {
    const r = s.ask && !attachments.length
      ? await api(`/sessions/${id}/answer`, { method: 'POST', body: { text } })
      : await api(`/sessions/${id}/reply`, { method: 'POST', body: { text, attachments, queue: queueing() } });
    const ta = n && $('.reply', n.card);
    if (ta) ((ta.value = ''), ta.dispatchEvent(new Event('input')));
    S.drafts.delete(id);
    n?.tray?.clear();
    if (r.queued)
      toast(r.ahead ? `Queued behind ${r.ahead} earlier follow-up${r.ahead > 1 ? 's' : ''} — they go out first, in order.` : 'Queued — it goes out as soon as the agent finishes.');
  } catch (err) {
    toast(esc(err.message), { tone: 'bad' });
  }
}

// --- item actions ------------------------------------------------------------------

async function toggleDone(id) {
  const s = S.sessions.get(id);
  if (!s) return;
  if (s.state === 'running' || s.state === 'waiting') return toast('Still working — stop it first or let it finish.');
  const next = s.state === 'done' ? 'review' : 'done';
  await api(`/sessions/${id}`, { method: 'PATCH', body: { state: next } });
  if (next === 'done') {
    const nextUp = groups().needs.find((x) => x.id !== id);
    collapse(id);
    if (nextUp) setFocus(nextUp.id);
    toast(`Marked done`, { action: { label: 'Undo', run: () => api(`/sessions/${id}`, { method: 'PATCH', body: { state: 'review' } }) } });
  }
}

async function takeOver(id) {
  const s = S.full.get(id) || (await api(`/sessions/${id}`).catch(() => null));
  if (!s?.agentSessionId) return;
  if (s.state === 'running' && !confirm(`${agentName(s.agent)} is still running. Stop it and take over in your terminal?`)) return;
  try {
    const { command } = await api(`/sessions/${id}/takeover`, { method: 'POST', body: {} });
    toast(`${icon('terminal')} Opened in your terminal`, { action: { label: 'Copy command', run: () => copy(command) } });
  } catch (err) {
    toast(esc(err.message), { tone: 'bad' });
  }
}

function rename(id) {
  const n = S.nodes.get(id);
  const title = n && $('.it-title', n.head);
  if (!title) return;
  title.contentEditable = 'true';
  title.focus();
  document.getSelection().selectAllChildren(title);
  const done = (commit) => {
    title.contentEditable = 'false';
    const s = S.sessions.get(id);
    const t = title.textContent.trim();
    if (commit && t && t !== s.title) api(`/sessions/${id}`, { method: 'PATCH', body: { title: t } }).catch((e) => toast(esc(e.message), { tone: 'bad' }));
    else title.textContent = s.title;
  };
  title.onkeydown = (e) => {
    if (e.key === 'Enter') (e.preventDefault(), title.blur());
    if (e.key === 'Escape') ((title.textContent = S.sessions.get(id).title), title.blur());
  };
  title.onclick = (e) => e.stopPropagation();
  title.onblur = () => done(true);
}

// One popover for all three choices: harnesses on the left, the focused harness's models on the
// right, and its thinking levels underneath. Clicking (or arrowing to) a harness previews its
// models; picking a model commits harness + model, picking a thinking level commits it in place.
function runnerPicker(anchor, { agent, model, effort, savedModel, savedEffort }, pick) {
  const open = $('.picker');
  if (open) return open.close();
  let focusAgent = S.agents.find((a) => a.id === agent && a.available) ? agent : S.agents.find((a) => a.available)?.id;

  const r = anchor.getBoundingClientRect();
  const width = Math.min(580, innerWidth - 24);
  // Stay inside the launcher card when there's room, else inside the window.
  const box = anchor.closest('.launcher')?.getBoundingClientRect();
  const right = Math.min(innerWidth - 12, box && box.width >= width ? box.right : innerWidth - 12);
  const left = Math.max(12, Math.min(r.left, right - width));
  const below = r.bottom + 440 < innerHeight;
  const node = el(`
    <div class="picker" role="dialog" aria-label="Harness, model and thinking level" style="left:${left}px;width:${width}px;${below ? `top:${r.bottom + 6}px` : `bottom:${innerHeight - r.top + 6}px`}">
      <div class="pk-side" role="listbox" aria-label="Harness">
        <div class="pk-head">Harness</div>
        ${S.agents
          .map(
            (a) => `<button class="pk-h${a.available ? '' : ' off'}" role="option" data-id="${esc(a.id)}" ${a.available ? '' : 'disabled'}>
              <span class="pk-logo">${harnessLogo(a.id)}</span>
              <span class="pk-text"><b>${esc(a.name)}</b><small>${esc(a.available ? `${(a.models || []).length > 1 ? `${a.models.length - 1} models` : 'Default model'}` : 'Not installed')}</small></span>
              ${a.id === agent ? '<span class="pk-dot" title="In use"></span>' : ''}
            </button>`,
          )
          .join('')}
      </div>
      <div class="pk-main">
        <label class="pk-search">${icon('search')}<input spellcheck="false" autocomplete="off"></label>
        <div class="pk-list" role="listbox" aria-label="Model"></div>
        <div class="pk-effort" role="radiogroup" aria-label="Thinking level"></div>
      </div>
    </div>`);
  const input = $('.pk-search input', node);
  const list = $('.pk-list', node);
  const sideRows = $$('.pk-h', node);
  const seg = $('.pk-effort', node);
  const modelOf = (id) => (id === agent ? model : savedModel(id));
  const effortOf = (id) => (id === agent ? effort : savedEffort(id, modelOf(id)));

  const paintEffort = () => {
    const levels = effortsFor(focusAgent, modelOf(focusAgent));
    const current = effortOf(focusAgent);
    seg.hidden = !levels.length;
    seg.innerHTML = `<span class="pk-ehead">Thinking</span><span class="pk-seg">${['', ...levels]
      .map((e) => `<button role="radio" aria-checked="${e === current}" class="${e === current ? 'on' : ''}" data-e="${esc(e)}" title="${e ? `${esc(effortLabel(e))} reasoning effort` : 'Whatever the harness is set to'}">${esc(e ? effortLabel(e) : 'Default')}</button>`)
      .join('')}</span>`;
  };
  const markInUse = (id) => {
    $$('.pk-dot', node).forEach((d) => d.remove());
    sideRows.find((b) => b.dataset.id === id)?.insertAdjacentHTML('beforeend', '<span class="pk-dot" title="In use"></span>');
  };
  const chooseEffort = (e) => {
    const m = modelOf(focusAgent);
    if (focusAgent === agent && e === effort) return;
    if (focusAgent !== agent) markInUse(focusAgent);
    agent = focusAgent;
    model = m;
    effort = e;
    pick(agent, model, effort);
    paintEffort();
    $(`button[data-e="${CSS.escape(e)}"]`, seg)?.focus();
  };

  const paintModels = () => {
    const a = S.agents.find((x) => x.id === focusAgent);
    sideRows.forEach((b) => b.classList.toggle('on', b.dataset.id === focusAgent));
    const models = a?.models || [{ id: '', label: 'Default' }];
    const current = focusAgent === agent ? model : savedModel(focusAgent);
    input.placeholder = `Search ${a?.name || ''} models`;
    $('.pk-search', node).hidden = models.length <= 6;
    // opencode-style ids (provider/model) group by provider.
    const groups = new Map();
    for (const m of models) {
      const g = m.id && m.id.includes('/') ? m.hint || '' : '';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(m);
    }
    list.innerHTML = [...groups]
      .map(
        ([g, ms]) =>
          `<div class="pk-group">${g ? `<div class="pk-ghead">${esc(g)}</div>` : ''}${ms
            .map(
              (m) => `<button class="pk-m${m.id === current ? ' on' : ''}" role="option" aria-selected="${m.id === current}" data-id="${esc(m.id)}">
                <span class="pk-text"><b>${esc(m.id ? m.label : 'Default')}</b><small>${esc(m.id ? (m.hint && m.hint !== g ? m.hint : '') : m.hint || `Whatever ${a?.name} is set to`)}</small></span>${icon('check', 'pk-check')}
              </button>`,
            )
            .join('')}</div>`,
      )
      .join('') + '<div class="pk-empty" hidden>No models match</div>';
    filter();
    paintEffort();
  };
  const rows = () => $$('.pk-m', list).filter((b) => !b.hidden);
  const filter = () => {
    const q = input.value.trim().toLowerCase();
    for (const b of $$('.pk-m', list)) b.hidden = !!q && !`${b.dataset.id} ${b.textContent}`.toLowerCase().includes(q);
    for (const g of $$('.pk-group', list)) g.hidden = !$$('.pk-m', g).some((b) => !b.hidden);
    $('.pk-empty', list).hidden = rows().length > 0;
  };
  const focusModels = () => {
    const rs = rows();
    const target = rs.find((b) => b.classList.contains('on')) || rs[0];
    target?.focus();
    target?.scrollIntoView({ block: 'nearest' });
  };
  const preview = (id, { focus } = {}) => {
    if (id !== focusAgent) {
      focusAgent = id;
      input.value = '';
      paintModels();
    }
    if (focus) sideRows.find((b) => b.dataset.id === id)?.focus();
  };

  // Picking a harness applies it straight away with the model and level it shows as selected.
  const useAgent = (id) => {
    preview(id);
    if (id === agent) return;
    markInUse(id);
    agent = id;
    model = savedModel(id);
    effort = savedEffort(id, model);
    pick(agent, model, effort);
  };

  const close = () => {
    node.remove();
    anchor.classList.remove('open');
    document.removeEventListener('mousedown', outside);
    document.removeEventListener('keydown', keys, true);
  };
  node.close = close;
  const choose = (m) => {
    close();
    anchor.focus();
    // Carry the thinking level over when the new model accepts it, else fall back to the saved one.
    const cur = effortOf(focusAgent);
    const e = effortsFor(focusAgent, m).includes(cur) ? cur : savedEffort(focusAgent, m);
    if (focusAgent !== agent || m !== model || e !== effort) pick(focusAgent, m, e);
  };
  const outside = (e) => !node.contains(e.target) && !anchor.contains(e.target) && close();
  const step = (items, d) => {
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    const next = items[i < 0 ? (d > 0 ? 0 : items.length - 1) : (i + d + items.length) % items.length];
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
    return next;
  };
  const keys = (e) => {
    const inSide = sideRows.includes(document.activeElement);
    const live = sideRows.filter((b) => !b.disabled);
    const segBtns = $$('button', seg);
    const inSeg = segBtns.includes(document.activeElement);
    if (e.key === 'Escape') return e.preventDefault(), e.stopPropagation(), close(), anchor.focus();
    // Tab hops from the model list to the thinking levels and back; anywhere else it leaves.
    if (e.key === 'Tab' && !seg.hidden && (inSeg ? e.shiftKey : !e.shiftKey && !inSide)) {
      e.preventDefault();
      return inSeg ? focusModels() : (segBtns.find((b) => b.classList.contains('on')) || segBtns[0]).focus();
    }
    if (e.key === 'Tab') return close();
    if (inSeg && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      e.stopPropagation();
      return step(segBtns, e.key === 'ArrowRight' ? 1 : -1);
    }
    if (inSeg && e.key === 'ArrowUp') return e.preventDefault(), focusModels();
    if (inSeg && (e.key === 'Enter' || e.key === ' ')) return e.preventDefault(), chooseEffort(document.activeElement.dataset.e);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      if (inSide) preview(step(live, d)?.dataset.id);
      else step(rows(), d);
    } else if (e.key === 'ArrowLeft' && document.activeElement !== input) {
      e.preventDefault();
      preview(focusAgent, { focus: true });
    } else if ((e.key === 'ArrowRight' || e.key === 'Enter') && inSide) {
      e.preventDefault();
      if (e.key === 'Enter') useAgent(focusAgent);
      focusModels();
    } else if (e.key === 'Enter' && document.activeElement === input && rows()[0]) {
      e.preventDefault();
      choose(rows()[0].dataset.id);
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !$('.pk-search', node).hidden && document.activeElement !== input) {
      input.focus(); // type-to-search from anywhere in the picker
    }
  };
  sideRows.forEach((b) => (b.onclick = () => useAgent(b.dataset.id)));
  list.onclick = (e) => {
    const b = e.target.closest('.pk-m');
    if (b) choose(b.dataset.id);
  };
  input.oninput = filter;
  seg.onclick = (e) => {
    const b = e.target.closest('button[data-e]');
    if (b) chooseEffort(b.dataset.e);
  };

  paintModels();
  setTimeout(() => document.addEventListener('mousedown', outside));
  document.addEventListener('keydown', keys, true);
  document.body.append(node);
  anchor.classList.add('open');
  focusModels(); // scrolls the current model into view…
  if (!$('.pk-search', node).hidden) input.focus({ preventScroll: true }); // …then search is ready to type
}

function moreMenu(id, anchor) {
  const s = S.full.get(id);
  if (!s) return;
  const r = anchor.getBoundingClientRect();
  const menu = el(`
    <div class="menu" style="top:${r.bottom + 6}px;right:${innerWidth - r.right}px">
      <button data-a="rename">${icon('pen')}Rename${keyHint('M')}</button>
      ${s.agentSessionId ? `<button data-a="copy">${icon('copy')}Copy resume command</button>` : ''}
      <button data-a="folder">${icon('folder')}Open project in editor</button>
      ${s.archived ? `<button data-a="unarchive">${icon('archive')}Unarchive${keyHint('A')}</button>` : s.state !== 'running' && s.state !== 'waiting' ? `<button data-a="archive">${icon('archive')}Archive${keyHint('A')}</button>` : ''}
      <button data-a="delete" class="danger">${icon('trash')}Delete session${keyHint('⌫')}</button>
    </div>`);
  const close = () => (menu.remove(), document.removeEventListener('mousedown', outside));
  const outside = (e) => !menu.contains(e.target) && close();
  setTimeout(() => document.addEventListener('mousedown', outside));
  menu.onclick = async (e) => {
    const a = e.target.closest('button')?.dataset.a;
    close();
    if (a === 'rename') rename(id);
    if (a === 'copy') {
      const { command } = await api(`/sessions/${id}/takeover`);
      copy(command);
      toast('Copied resume command');
    }
    if (a === 'folder') openInEditor(s, '.');
    if (a === 'archive' || a === 'unarchive') setArchived(id, a === 'archive');
    if (a === 'delete') deleteSession(id);
  };
  document.body.append(menu);
}

// Right-click on a feed item.
function taskMenu(id, e) {
  const s = S.sessions.get(id);
  if (!s) return;
  $('.menu.task')?.close();
  const busy = s.state === 'running' || s.state === 'waiting';
  const menu = el(`
    <div class="menu task" style="top:${e.clientY}px;left:${e.clientX}px">
      ${S.open.has(id) ? `<button data-a="collapse">${icon('chevron')}Collapse${keyHint('O')}</button>` : `<button data-a="open">${icon('chevron')}Open${keyHint('O')}</button>`}
      <button data-a="rename">${icon('pen')}Rename${keyHint('M')}</button>
      ${busy || s.archived ? '' : `<button data-a="done">${icon('done')}${s.state === 'done' ? 'Reopen' : 'Mark done'}${keyHint('E')}</button>`}
      ${s.archived ? `<button data-a="unarchive">${icon('archive')}Unarchive${keyHint('A')}</button>` : busy ? '' : `<button data-a="archive">${icon('archive')}Archive${keyHint('A')}</button>`}
      <button data-a="delete" class="danger">${icon('trash')}Delete session${keyHint('⌫')}</button>
    </div>`);
  const close = () => (menu.remove(), document.removeEventListener('mousedown', outside));
  const outside = (ev) => !menu.contains(ev.target) && close();
  menu.close = close;
  setTimeout(() => document.addEventListener('mousedown', outside));
  menu.onclick = async (ev) => {
    const a = ev.target.closest('button')?.dataset.a;
    close();
    if (a === 'open') expand(id);
    if (a === 'collapse') collapse(id);
    if (a === 'rename') rename(id);
    if (a === 'done') toggleDone(id);
    if (a === 'archive' || a === 'unarchive') setArchived(id, a === 'archive');
    if (a === 'delete') deleteSession(id);
  };
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  if (r.right > innerWidth - 8) menu.style.left = `${innerWidth - r.width - 8}px`;
  if (r.bottom > innerHeight - 8) menu.style.top = `${innerHeight - r.height - 8}px`;
}

// The keyboard shortcut for a menu item, shown at its right edge. Menus act on the
// focused card, so the key does the same thing as the click.
const keyHint = (k) => `<kbd class="menu-kbd">${k}</kbd>`;

async function deleteSession(id) {
  if (!confirm('Delete this session from wisp? (The agent’s own history is kept.)')) return;
  await api(`/sessions/${id}`, { method: 'DELETE' }).catch((err) => toast(esc(err.message), { tone: 'bad' }));
}

async function setArchived(id, archived) {
  try {
    await api(`/sessions/${id}`, { method: 'PATCH', body: { archived } });
  } catch (err) {
    return toast(esc(err.message), { tone: 'bad' });
  }
  if (archived) {
    if (S.open.has(id)) collapse(id);
    toast('Archived', { action: { label: 'Undo', run: () => setArchived(id, false) } });
  }
}

function replay(id) {
  const n = S.nodes.get(id);
  if (!n?.body) return;
  for (const v of n.turnNodes.values()) v.node.remove();
  n.turnNodes.clear();
  renderBody(id, { fresh: false });
  $('.turns', n.body).lastElementChild?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

const EDITORS = {
  vscode: (f, l) => `vscode://file${f}${l ? `:${l}` : ''}`,
  cursor: (f, l) => `cursor://file${f}${l ? `:${l}` : ''}`,
  windsurf: (f, l) => `windsurf://file${f}${l ? `:${l}` : ''}`,
  zed: (f, l) => `zed://file${f}${l ? `:${l}` : ''}`,
  idea: (f, l) => `idea://open?file=${encodeURIComponent(f)}${l ? `&line=${l}` : ''}`,
};

function openInEditor(s, p, line) {
  const editor = S.config.defaults.editor || 'vscode';
  const abs = p.startsWith('/') ? p : `${s.cwd}/${p}`.replace(/\/\.$/, '');
  if (editor === 'none' || !EDITORS[editor]) {
    copy(abs);
    return toast(`Copied path ${esc(abs)}`);
  }
  location.href = EDITORS[editor](abs, line);
}

// Bring an item into view, expanded — used by notifications and links.
function reveal(id) {
  const s = S.sessions.get(id);
  if (!s) return;
  if (s.archived) S.showArchived = true;
  else if (s.state === 'done' && !S.showDone) {
    S.showDone = true;
    save('wisp.showDone', true);
  }
  if (S.filter !== 'all' && S.filter !== s.projectId) {
    S.filter = 'all';
    save('wisp.filter', S.filter);
    renderLaunchChips();
  }
  renderFeed();
  setFocus(id, { scroll: false });
  if (S.open.has(id)) S.nodes.get(id)?.card.scrollIntoView({ block: 'start', behavior: 'smooth' });
  else expand(id);
}

// --- projects modal ---------------------------------------------------------------------

const COLORS = ['violet', 'teal', 'amber', 'rose', 'sky', 'lime', 'orange', 'indigo'];

async function openProjects({ focusAdd = false } = {}) {
  const node = el(`
    <div class="modal projects-modal">
      <header><h2>Projects</h2><button class="icon-btn close">${icon('x')}</button></header>
      <div class="add-row">
        <div class="path-input">
          ${window.wispDesktop ? `<button class="browse" title="Browse…">${icon('folder')}</button>` : icon('folder')}
          <input id="ppath" placeholder="~/code/my-app" spellcheck="false" autocomplete="off">
          <div class="suggest" hidden></div>
        </div>
        ${window.wispDesktop ? `<button class="ghost" id="pbrowse">${icon('folder')}Browse…</button>` : ''}
        <button class="primary" id="padd">Add</button>
      </div>
      <p class="hint">Tip: run <code>wisp add</code> inside any folder, or launch from a terminal with <code>wisp "task"</code> — the folder is added automatically.</p>
      <div class="plist" id="plist"></div>
      <div class="discover" id="discover"><h4>Found on this machine</h4><p class="muted">Looking for git repos…</p></div>
    </div>`);
  const close = overlay(node);
  $('.close', node).onclick = close;
  const input = $('#ppath', node);
  const sug = $('.suggest', node);

  const add = async (p) => {
    try {
      const proj = await api('/projects', { method: 'POST', body: { path: p } });
      await loadConfig();
      launchProject = proj.id;
      save('wisp.launchProject', launchProject);
      renderLaunchChips();
      toast(`Added <b>${esc(proj.name)}</b>`);
      input.value = '';
      sug.hidden = true;
      list();
      discover();
    } catch (err) {
      toast(esc(err.message), { tone: 'bad' });
    }
  };
  $('#padd', node).onclick = () => input.value.trim() && add(input.value.trim());
  const browse = async () => {
    const dir = await window.wispDesktop.pickFolder();
    if (dir) add(dir);
  };
  $$('#pbrowse, .browse', node).forEach((b) => (b.onclick = browse));

  let sel = -1;
  let t;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = input.value;
      if (!q) return (sug.hidden = true);
      const dirs = await api(`/fs?q=${encodeURIComponent(q)}`).catch(() => []);
      sel = -1;
      sug.hidden = !dirs.length;
      sug.innerHTML = dirs.map((d) => `<button data-p="${esc(d)}">${esc(d.replace(S.config.home, '~'))}</button>`).join('');
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
      input.value = (opts[Math.max(0, sel)].dataset.p + '/').replace(S.config.home, '~');
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
    const projects = S.config.projects;
    box.innerHTML = projects.length
      ? projects
          .map((p) => {
            const n = [...S.sessions.values()].filter((s) => s.projectId === p.id).length;
            return `<div class="prow c-${p.color}" data-id="${p.id}">
              <button class="swatch" title="Change colour"><i class="p-dot"></i></button>
              <div class="prow-main"><input class="pname" value="${esc(p.name)}"><span class="ppath">${esc(p.path.replace(S.config.home, '~'))}</span></div>
              <span class="pcount">${n} session${n === 1 ? '' : 's'}</span>
              <button class="icon-btn premove" title="Remove from wisp (files untouched)">${icon('trash')}</button>
            </div>`;
          })
          .join('')
      : '<p class="muted">No projects yet. Add a folder above, or pick one below.</p>';
    $$('.prow', box).forEach((row) => {
      const id = row.dataset.id;
      const p = projectById(id);
      $('.pname', row).onchange = (e) => api(`/projects/${id}`, { method: 'PATCH', body: { name: e.target.value } }).then(loadConfig);
      $('.swatch', row).onclick = () => {
        const color = COLORS[(COLORS.indexOf(p.color) + 1) % COLORS.length];
        api(`/projects/${id}`, { method: 'PATCH', body: { color } }).then(async () => (await loadConfig(), list()));
      };
      $('.premove', row).onclick = async () => {
        if (!confirm(`Remove “${p.name}” from wisp? Sessions and files are kept.`)) return;
        await api(`/projects/${id}`, { method: 'DELETE' });
        await loadConfig();
        list();
      };
    });
  };

  const discover = async () => {
    const box = $('#discover', node);
    const found = await api('/projects/discover').catch(() => []);
    box.innerHTML = found.length
      ? `<h4>Found on this machine <span class="muted">· git repos</span></h4><div class="found">${found
          .map((f) => `<button class="found-item" data-p="${esc(f.path)}">${icon('plus')}<b>${esc(f.name)}</b><span>${esc(f.path.replace(S.config.home, '~').replace(/\/[^/]+$/, ''))}</span></button>`)
          .join('')}</div>`
      : '';
    box.onclick = (e) => {
      const b = e.target.closest('.found-item');
      if (b) add(b.dataset.p);
    };
  };

  list();
  discover();
  if (focusAdd) setTimeout(() => input.focus(), 60);
}

// --- settings -----------------------------------------------------------------------------

function openSettings() {
  const d = S.config.defaults;
  const node = el(`
    <div class="modal settings-modal">
      <header><h2>Settings</h2><button class="icon-btn close">${icon('x')}</button></header>
      <label><span>Open files in</span>
        <select name="editor">${[['vscode', 'VS Code'], ['cursor', 'Cursor'], ['windsurf', 'Windsurf'], ['zed', 'Zed'], ['idea', 'JetBrains'], ['none', 'Copy path']]
          .map(([v, l]) => `<option value="${v}" ${d.editor === v || (!d.editor && v === 'vscode') ? 'selected' : ''}>${l}</option>`)
          .join('')}</select></label>
      <label><span>Take over in</span>
        <select name="terminal">${(S.config.terminals || []).map((t) => `<option value="${t.id}" ${(d.terminal || 'auto') === t.id ? 'selected' : ''}>${t.label}</option>`).join('')}</select></label>
      <label class="custom-term" ${d.terminal === 'custom' ? '' : 'hidden'}><span>Terminal command</span>
        <input name="terminalCommand" value="${esc(d.terminalCommand || '')}" placeholder="alacritty --working-directory {cwd} -e {cmd}" spellcheck="false"></label>
      <div class="setting"><span>Desktop notifications</span><span class="notif-hint muted xs"></span><button class="switch" id="notif" role="switch"></button></div>
      <div class="setting"><span>Anonymous usage stats</span><span class="tele-hint muted xs"></span><button class="switch" id="tele" role="switch"></button></div>
      <div class="agents">${S.agents
        .map((a) => `<div class="agent-row"><span class="dot ${a.available ? 'ok' : 'bad'}"></span><b>${esc(a.name)}</b><span class="muted">${esc(a.available ? a.version : a.error || 'not found')}</span></div>`)
        .join('')}<p class="muted xs">Pick the agent next to the model in the launcher. Others plug in via <code>server/adapters</code>.</p></div>
    </div>`);
  const close = overlay(node);
  $('.close', node).onclick = close;
  node.addEventListener('change', async (e) => {
    const { name, value } = e.target;
    if (!name) return;
    if (name === 'terminal') $('.custom-term', node).hidden = value !== 'custom';
    await api('/config', { method: 'PATCH', body: { defaults: { [name]: value } } });
    await loadConfig();
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
    await api('/config', { method: 'PATCH', body: { defaults: { notify: want ? 'on' : 'off' } } });
    await loadConfig();
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
    await api('/config', { method: 'PATCH', body: { defaults: { telemetry: S.config.telemetry?.enabled ? 'off' : 'on' } } });
    await loadConfig();
    paintTele();
  };
  paintTele();
}

// Say once that anonymous stats are on, with a way out.
function telemetryNotice() {
  if (!S.config.telemetry?.enabled || S.config.defaults.telemetryNotice === 'seen') return;
  S.config.defaults.telemetryNotice = 'seen';
  api('/config', { method: 'PATCH', body: { defaults: { telemetryNotice: 'seen' } } }).catch(() => {});
  toast('wisp sends anonymous usage stats and error reports. No prompts, paths or code.', { timeout: 10_000, action: { label: 'Settings', run: openSettings } });
}

function shortcuts() {
  const rows = [
    [combo('K'), 'Search & commands'],
    [`N · ${combo('L')}`, 'New wisp (focus the launcher)'],
    ['J / K', 'Next / previous item'],
    ['O / ↵', 'Expand / collapse item'],
    ['/', 'Follow up on item'],
    ['E', 'Mark done & go to next'],
    ['A', 'Archive / unarchive'],
    ['M', 'Rename item'],
    ['⌫', 'Delete item'],
    ['T', 'Take over in terminal'],
    ['R', 'Replay presentation'],
    ['1–9', 'Pick an answer when asked'],
    ['↵', 'Launch / send'],
    ['⇧↵', 'New line'],
    ['C', 'Collapse all'],
    ['Esc', 'Close / collapse'],
  ];
  const node = el(`<div class="modal keys-modal"><header><h2>Shortcuts</h2></header>${rows.map(([k, l]) => `<div class="krow"><kbd>${k}</kbd><span>${l}</span></div>`).join('')}</div>`);
  overlay(node);
}

// --- command palette ------------------------------------------------------------------

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
// How a modifier shortcut reads on this OS: "⌘L" on macOS, "Ctrl+L" on Windows/Linux.
const combo = (k) => (IS_MAC ? `⌘${k}` : `Ctrl+${k}`);
// ⌘ on macOS, Ctrl elsewhere (AltGr on Windows reports Ctrl+Alt, so Alt is excluded). Falls back to
// the physical key on non-Latin layouts, where e.key is e.g. "д" for the L key.
const modKey = (e, k) =>
  (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey &&
  (e.key.toLowerCase() === k || (!/^[a-z]$/i.test(e.key) && e.code === `Key${k.toUpperCase()}`));
const STATE_LABEL = { running: 'Working', waiting: 'Asking', review: 'Review', done: 'Done' };

function focusLauncher() {
  stage.scrollTo({ top: 0, behavior: 'smooth' });
  $('#prompt')?.focus({ preventScroll: true });
}

// Run something on a session's card, expanding it first if the action needs the body.
function withCard(id, fn, { open = false } = {}) {
  reveal(id);
  if (!open || S.open.has(id)) return setTimeout(fn, 50);
  expand(id).then(fn);
}

function paletteItems() {
  const items = [];
  const cur = S.focus && S.sessions.get(S.focus);
  if (cur) {
    const id = cur.id;
    const live = cur.state === 'running' || cur.state === 'waiting';
    const g = 'This wisp';
    const sub = cur.title;
    items.push({ group: g, label: 'Follow up', sub, icon: 'send', kbd: '/', run: () => withCard(id, () => $('.reply', S.nodes.get(id)?.card)?.focus(), { open: true }) });
    if (!live) items.push({ group: g, label: cur.state === 'done' ? 'Move back to review' : 'Mark done', sub, icon: 'done', kbd: 'E', run: () => toggleDone(id) });
    if (cur.archived || !live) items.push({ group: g, label: cur.archived ? 'Unarchive' : 'Archive', sub, icon: 'archive', kbd: 'A', run: () => setArchived(id, !cur.archived) });
    items.push({ group: g, label: 'Take over in terminal', sub, icon: 'terminal', kbd: 'T', run: () => takeOver(id) });
    items.push({ group: g, label: 'Replay presentation', sub, icon: 'replay', kbd: 'R', run: () => withCard(id, () => replay(id), { open: true }) });
    items.push({ group: g, label: 'Rename', sub, icon: 'pen', kbd: 'M', run: () => withCard(id, () => rename(id)) });
    items.push({ group: g, label: 'Delete session', sub, icon: 'trash', kbd: '⌫', keywords: 'remove', run: () => deleteSession(id) });
  }

  const sessions = [...S.sessions.values()].sort((a, b) => a.archived - b.archived || b.updatedAt - a.updatedAt);
  for (const s of sessions) {
    const state = s.archived ? 'Archived' : s.state === 'review' ? STATUS_LABEL[s.status] || 'Review' : STATE_LABEL[s.state] || s.state;
    items.push({
      group: 'Wisps',
      label: s.title,
      sub: `${s.project} · ${state} · ${ago(s.updatedAt)}`,
      dot: s.color,
      keywords: [s.preview, s.live, s.question, agentName(s.agent)].filter(Boolean).join(' '),
      // Live and unread work floats up; archived sinks.
      rank: (s.state === 'waiting' ? 3 : 0) + (s.unread ? 2 : 0) + (s.state === 'running' ? 1 : 0) - (s.archived ? 4 : 0),
      run: () => reveal(s.id),
    });
  }

  const a = 'Actions';
  items.push(
    { group: a, label: 'New wisp', icon: 'plus', kbd: 'N', keywords: 'launch create prompt task', run: focusLauncher },
    { group: a, label: S.showDone ? 'Hide done' : 'Show done', icon: 'done', keywords: 'toggle finished', run: () => $('#secDone .toggle-done').click() },
    { group: a, label: S.showArchived ? 'Hide archived' : 'Show archived', icon: 'archive', keywords: 'toggle', run: () => $('#secArchived .toggle-done').click() },
  );
  if (S.open.size) items.push({ group: a, label: 'Collapse all', icon: 'minus', kbd: 'C', run: collapseAll });
  items.push(
    { group: a, label: 'Add project…', icon: 'folder', keywords: 'folder repo directory', run: () => openProjects({ focusAdd: true }) },
    { group: a, label: 'Manage projects', icon: 'folder', keywords: 'rename color remove', run: () => openProjects() },
    { group: a, label: 'Settings', icon: 'settings', keywords: 'preferences editor terminal notifications', run: openSettings },
    { group: a, label: 'Keyboard shortcuts', icon: 'info', kbd: '?', keywords: 'keys help hotkeys', run: shortcuts },
  );

  const filter = (id) => () => {
    S.filter = id;
    save('wisp.filter', id);
    renderProjects();
    renderFeed();
    renderLaunchChips();
  };
  items.push({ group: 'Projects', label: 'All projects', sub: S.filter === 'all' ? 'Current filter' : '', dot: 'slate', keywords: 'filter clear', run: filter('all') });
  for (const p of S.config.projects.slice().sort((x, y) => (y.lastUsedAt || y.addedAt) - (x.lastUsedAt || x.addedAt))) {
    items.push({ group: 'Projects', label: p.name, sub: S.filter === p.id ? 'Current filter' : p.path, dot: p.color, keywords: `filter ${p.path}`, run: filter(p.id) });
  }
  return items;
}

let paletteOpen = false;
function openPalette() {
  if (paletteOpen) return closeOverlay();
  // Don't stack over another modal (settings, projects…); the palette replaces nothing.
  if (!$('#overlay').hidden) return;
  paletteOpen = true;
  palette({ items: paletteItems(), overlay: (node) => overlay(node, { onClose: () => (paletteOpen = false) }) });
}

// --- notifications -----------------------------------------------------------------------

// On unless turned off in settings, and only if the browser lets us.
function notifyOn() {
  return S.config.defaults.notify !== 'off' && 'Notification' in window && Notification.permission === 'granted';
}

function askNotify() {
  if (S.config.defaults.notify !== 'off' && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}

function notifyFinished(s) {
  const n = S.nodes.get(s.id);
  const viewing = S.open.has(s.id) && n && isInView(n.card) && document.hasFocus();
  if (viewing) return;
  const verb = s.state === 'waiting' ? 'has a question' : 'is ready';
  toast(`${icon(s.state === 'waiting' ? 'ask' : 'spark')} <b>${esc(s.title)}</b> ${verb}`, { action: { label: 'Open', run: () => reveal(s.id) }, timeout: 7000 });
  if (notifyOn() && !document.hasFocus()) {
    const note = new Notification(`${s.project}: ${s.title}`, { body: s.state === 'waiting' ? s.question : s.preview || 'Ready for review', icon: '/favicon.svg', tag: s.id });
    note.onclick = () => (window.focus(), reveal(s.id));
  }
}

// --- live events --------------------------------------------------------------------------

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('summary', (e) => {
    const s = JSON.parse(e.data);
    const prev = S.sessions.get(s.id);
    S.sessions.set(s.id, s);
    // A card left open while it worked shouldn't land in "Needs you" expanded —
    // fold it unless the user is actually watching it.
    const n = S.nodes.get(s.id);
    if (prev?.state === 'running' && s.state !== 'running' && S.open.has(s.id) && !(n && isInView(n.card) && document.hasFocus())) collapse(s.id);
    renderFeed();
    if (prev?.state !== s.state || prev?.queued !== s.queued) scheduleRefetch(s.id);
  });
  es.addEventListener('activity', (e) => onActivity(JSON.parse(e.data)));
  es.addEventListener('turn', (e) => scheduleRefetch(JSON.parse(e.data).sessionId));
  es.addEventListener('finished', (e) => notifyFinished(JSON.parse(e.data).session));
  es.addEventListener('removed', (e) => {
    const { id } = JSON.parse(e.data);
    S.sessions.delete(id);
    S.full.delete(id);
    S.open.delete(id);
    saveOpen();
    renderFeed();
  });
  es.addEventListener('config', () => loadConfig());
  es.addEventListener('hello', () => loadSessions());
}

async function loadSessions() {
  const list = await api('/sessions');
  S.sessions = new Map(list.map((s) => [s.id, s]));
  for (const id of S.open) if (!S.sessions.has(id)) S.open.delete(id);
  saveOpen();
  renderFeed();
  for (const id of S.open) scheduleRefetch(id);
}

async function loadConfig() {
  S.config = await api('/config');
  renderProjects();
  renderLaunchChips();
}

// --- keyboard ---------------------------------------------------------------------------

const feedIds = () => $$('#feed .item').map((x) => x.dataset.id);

document.addEventListener('keydown', (e) => {
  // ⌘K / Ctrl+K works from anywhere, even mid-sentence in the launcher.
  if (modKey(e, 'k')) {
    e.preventDefault();
    return openPalette();
  }
  // ⌘L / Ctrl+L jumps to the launcher from anywhere, including another composer.
  if (modKey(e, 'l')) {
    e.preventDefault();
    if (!$('#overlay').hidden) closeOverlay();
    return focusLauncher();
  }
  const typing = e.target.closest('input, textarea, select, [contenteditable="true"]');
  if (e.key === 'Escape') {
    if (!$('#overlay').hidden) return closeOverlay();
    if (typing) return e.target.blur();
    if (S.focus && S.open.has(S.focus)) collapse(S.focus);
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || !$('#overlay').hidden) return;
  const k = e.key.toLowerCase();
  const id = S.focus && S.nodes.has(S.focus) ? S.focus : null;
  if (k === 'n') {
    e.preventDefault();
    focusLauncher();
  } else if (k === 'j' || k === 'k') {
    const ids = feedIds();
    if (!ids.length) return;
    const i = ids.indexOf(id);
    const next = i < 0 ? ids[0] : ids[k === 'j' ? Math.min(ids.length - 1, i + 1) : Math.max(0, i - 1)];
    setFocus(next);
  } else if ((k === 'o' || (k === 'enter' && !e.target.closest('button, a'))) && id) {
    e.preventDefault();
    toggle(id);
  } else if (k === 'e' && id) toggleDone(id);
  else if (k === 'a' && id) {
    const s = S.sessions.get(id);
    if (s && (s.archived || (s.state !== 'running' && s.state !== 'waiting'))) setArchived(id, !s.archived);
  }
  else if (k === 'c' && S.open.size) collapseAll();
  else if (k === 'm' && id) {
    e.preventDefault();
    rename(id);
  } else if ((k === 'delete' || k === 'backspace') && id) {
    e.preventDefault();
    deleteSession(id);
  } else if (k === 't' && id) takeOver(id);
  else if (k === 'r' && id) replay(id);
  else if (k === '/' && id) {
    e.preventDefault();
    const focusReply = () => $('.reply', S.nodes.get(id)?.card)?.focus();
    if (S.open.has(id)) focusReply();
    else expand(id).then(focusReply);
  } else if (k === '?') shortcuts();
  else if (/^[1-9]$/.test(k) && id && S.open.has(id)) {
    const card = S.nodes.get(id).card;
    const opts = $$('.ask-card .opt', card).length ? $$('.ask-card .opt', card) : $$('.turn:last-child .b-question:not(.answered) .opt:not(.own)', card);
    opts[Number(k) - 1]?.click();
  }
});

$('#settingsBtn').onclick = openSettings;
$('#searchBtn').onclick = openPalette;
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

// Sticky top bar gets a hairline once the page scrolls; "back to top" shows after a screen's worth.
const toTop = $('#toTop');
stage.addEventListener('scroll', () => {
  $('#topbar').classList.toggle('scrolled', stage.scrollTop > 4);
  toTop.hidden = stage.scrollTop < stage.clientHeight * 0.75;
}, { passive: true });
toTop.onclick = () => stage.scrollTo({ top: 0, behavior: 'smooth' });

if (/Electron/.test(navigator.userAgent)) document.body.classList.add('electron', /Mac/.test(navigator.platform) ? 'mac' : 'other');

// --- links -------------------------------------------------------------------------------

// #/s/<id> still works (notifications, CLI): it reveals that item in the feed.
function route() {
  const m = location.hash.match(/^#\/s\/(\w+)/);
  if (!m) return;
  history.replaceState(null, '', '#/');
  reveal(m[1]);
}

window.addEventListener('hashchange', route);
window.addEventListener('focus', () => {
  for (const id of S.open) if (S.sessions.get(id)?.unread) scheduleRefetch(id);
});

(async () => {
  [S.agents] = await Promise.all([api('/agents').catch(() => []), loadConfig(), loadSessions()]);
  renderLauncher();
  connect();
  route();
  $('#prompt')?.focus();
  telemetryNotice();
})();
