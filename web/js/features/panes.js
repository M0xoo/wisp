// Panes: a My Stuff app pinned beside the open task (a tab in the side panel, panel.js) or on split
// view's home (split.js). The pins are the `panes` setting ("<app>@task,<app>@home": a spell can set
// it); what each app may use is yours to allow (POST /stuff/:id/allow), never a spell's.
//
// The app runs where Launch runs it (its own port, services/apps.js), in a frame with no popups.
// It talks to wisp only through messages (/_wisp/pane.js): each call is checked here against what
// you allowed (pane-bridge.js refusal) and only then goes to the real API, with light shapes back.
// The Allow card only ever comes from your own click (Pin, or Allow… on the pane), never by itself,
// and never on a task while it runs in Full auto.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { el, icon } from '../core/dom.js';
import { MOBILE, S } from '../core/state.js';
import { ask } from '../ui/confirm.js';
import { toast, toastError } from '../ui/toast.js';
import { boxUrl, isLoopback } from '../preview-spec.js';
import { gridLink } from '../grid-link.js';
import { appFor, argsOf, lightMember, lightPrs, lightTask, listedTasks, missingOf, PANE_USES, PANE_WRITES_PER_MIN, panesString, parsePanes, refusal } from '../pane-bridge.js';

const frames = new Map(); // `${where}:${app id}` -> { node, iframe, origin, id, where, task, watching, writes }

// --- the pins ----------------------------------------------------------------------------------

const pinsNow = () => parsePanes(S.config?.defaults?.panes);
const appNow = (id) => (S.stuff || []).find((x) => x.id === id) || null;

// The apps pinned at a place (task or home), in their order: [{ it, pin }]. An app that isn't in
// My Stuff (yet: a spell named it) is left out.
export function panesAt(where) {
  const seen = new Set();
  return pinsNow()
    .filter((p) => p.where === where)
    .map((pin) => ({ pin, it: appFor(pin, S.stuff || []) }))
    .filter(({ it }) => it && !seen.has(it.id) && seen.add(it.id));
}
export const pinnedAt = (it, where) => panesAt(where).some((x) => x.it.id === it.id);

async function setPins(pins) {
  const was = S.config.defaults.panes;
  const next = panesString(pins);
  S.config.defaults.panes = next; // optimistic: the tab or the home pane shows now
  bus.emit('panes');
  try {
    await api('/config', { method: 'PATCH', body: { defaults: { panes: next } } });
    return true;
  } catch (err) {
    S.config.defaults.panes = was;
    bus.emit('panes');
    toastError(err);
    return false;
  }
}

const WHERE_WORDS = { task: 'beside tasks', home: 'on home' };

// Pin: in the setting at once; when the app asks to use wisp, the Allow card first (your click).
export async function pinApp(it, where, anchor = null) {
  if (pinnedAt(it, where)) return;
  if (missingOf(it).length && !(await allowApp(it, anchor, { pinning: where }))) return;
  const pins = pinsNow().filter((p) => !(p.where === where && appFor(p, S.stuff || [])?.id === it.id));
  if (await setPins([...pins, { app: it.id, where }])) toast(`Pinned <b>${esc(it.title)}</b> ${WHERE_WORDS[where]}`, { action: { label: 'Undo', run: () => unpinApp(it, where) } });
}

export async function unpinApp(it, where) {
  const pins = pinsNow().filter((p) => !(p.where === where && appFor(p, S.stuff || [])?.id === it.id));
  if (await setPins(pins)) {
    drop(`${where}:${it.id}`);
    toast(`Unpinned <b>${esc(it.title)}</b>`);
  }
}

// The Allow card: what the app asks for, in words. true when it's pinned with that (or without
// any, if you say so), false on Cancel.
export async function allowApp(it, anchor = null, { pinning = '' } = {}) {
  const want = it.uses || [];
  if (!want.length) return true;
  const lines = want.map((u) => `• ${PANE_USES[u]}`).join('\n');
  const head = pinning ? `Pin ${it.title} ${WHERE_WORDS[pinning]}? It asks to:` : `Allow ${it.title} to:`;
  const answer = await ask(`${head}\n\n${lines}\n\nIt can’t reach the internet while it uses wisp. You can take it back from its menu in My Stuff.`, { ok: pinning ? 'Allow and pin' : 'Allow', alt: pinning ? 'Pin without' : '', anchor });
  if (!answer) return false;
  if (answer === 'alt') return true;
  return setAllowed(it, want);
}

export async function setAllowed(it, uses) {
  const was = it.allowed;
  patchItem(it.id, { allowed: uses.length ? uses : undefined });
  try {
    patchItem(it.id, await api(`/stuff/${it.id}/allow`, uses.length ? { method: 'POST', body: { uses } } : { method: 'DELETE' }));
    return true;
  } catch (err) {
    patchItem(it.id, { allowed: was });
    toastError(err);
    return false;
  }
}

function patchItem(id, fields) {
  const i = (S.stuff || []).findIndex((x) => x.id === id);
  if (i < 0) return;
  const next = { ...S.stuff[i], ...fields };
  if (!next.allowed?.length) delete next.allowed;
  S.stuff[i] = next;
  bus.emit('stuff-list');
}

// --- a pane on the page ---------------------------------------------------------------------------

// A Full auto task that's running never gets a card, not even the Allow… button that opens one.
const quietFor = (f) => {
  const s = f.where === 'task' && S.sessions.get(f.task);
  return !!s && s.mode === 'auto' && (s.state === 'running' || s.status === 'running');
};

// Its node: a bar (name, what it still asks for, Reload, Unpin) over the frame. Made once per app
// and place, then kept: moving or re-adding a frame reloads the app.
export function paneNode(it, where, task = null) {
  const key = `${where}:${it.id}`;
  let f = frames.get(key);
  if (!f) {
    const node = el(`<section class="pa" data-app="${esc(it.id)}" aria-label="${esc(it.title)}">
      <div class="pa-bar"><span class="pa-ic">${icon('app')}</span><b class="pa-name"></b><span class="pa-need" hidden></span><span class="grow"></span>
        <button class="ghost xs pa-allow" data-pa="allow" hidden>${icon('lock')}<span>Allow…</span></button>
        <button class="icon-btn xs" data-pa="reload" title="Reload the pane" aria-label="Reload the pane">${icon('rerun')}</button>
        <button class="icon-btn xs" data-pa="unpin" title="Unpin" aria-label="Unpin">${icon('x')}</button>
      </div>
      <div class="pa-stage"><div class="pa-wait"><i></i><span>Starting ${esc(it.title)}…</span></div></div>
    </section>`);
    f = { key, id: it.id, where, task, node, iframe: null, origin: '', watching: false, writes: [] };
    frames.set(key, f);
    node.addEventListener('click', (e) => {
      const a = e.target.closest('[data-pa]')?.dataset.pa;
      const now = appNow(f.id);
      if (!a || !now) return;
      if (a === 'reload' && f.iframe) f.iframe.src = f.iframe.src;
      if (a === 'unpin') unpinApp(now, where);
      if (a === 'allow') allowApp(now, e.target.closest('button')).then((ok) => ok && paintBar(f));
    });
    start(f);
  }
  if (task !== f.task) {
    f.task = task;
    context(f);
  }
  paintBar(f);
  return f.node;
}

function paintBar(f) {
  const it = appNow(f.id);
  if (!it) return;
  f.node.querySelector('.pa-name').textContent = it.title;
  const missing = missingOf(it);
  const need = f.node.querySelector('.pa-need');
  need.hidden = !missing.length;
  need.textContent = missing.length ? (it.allowed?.length ? 'Some access not allowed' : 'No access yet') : '';
  need.title = missing.map((u) => PANE_USES[u]).join('\n');
  f.node.querySelector('.pa-allow').hidden = !missing.length || quietFor(f);
}

async function start(f) {
  const it = appNow(f.id);
  const stage = f.node.querySelector('.pa-stage');
  // Over the phone app's SSH tunnel only wisp itself is reachable (as Launch says).
  if (MOBILE && isLoopback(location.href)) return (stage.innerHTML = `<p class="pa-off">${icon('info')}Panes open here when you connect through wisp Cloud, or in a browser on the computer running wisp.</p>`);
  try {
    const { url } = await api(`/stuff/${it.id}/launch`, { method: 'POST' });
    const to = isLoopback(location.href) ? url : boxUrl(url, S.config?.preview || S.config?.grid?.preview);
    if (!to) return (stage.innerHTML = `<p class="pa-off">${icon('info')}It runs on the computer with wisp, at <code>${esc(url)}</code>.</p>`);
    f.origin = new URL(to).origin;
    // Its own origin (its storage, its database), scripts and forms; no popups, no top navigation.
    const iframe = el(`<iframe class="pa-frame" title="${esc(it.title)}" allow="clipboard-write" sandbox="allow-scripts allow-forms allow-same-origin"></iframe>`);
    iframe.addEventListener('load', () => (f.node.classList.add('ready'), context(f)));
    iframe.src = await gridLink(url, to);
    f.iframe = iframe;
    stage.append(iframe);
  } catch (err) {
    stage.innerHTML = `<p class="pa-off">${icon('warn')}${esc(err.message || 'It didn’t start.')}</p>`;
  }
}

function drop(key) {
  const f = frames.get(key);
  if (!f) return;
  frames.delete(key);
  f.node.remove();
}

// --- the bridge ---------------------------------------------------------------------------------

const post = (f, m) => f.iframe?.contentWindow?.postMessage({ wispPane: 1, ...m }, f.origin || '*');
const theme = () => { const t = document.documentElement.dataset.theme; return t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'; };
const context = (f) => post(f, { event: 'context', data: { where: f.where, task: f.where === 'task' ? f.task : null, theme: theme() } });

const tasksNow = () => listedTasks(S.sessions.values()).filter((s) => !s.archived).map(lightTask);
const projectFor = (v) => {
  if (!v) return null;
  const k = String(v).toLowerCase();
  return (S.config.projects || []).find((p) => p.id === v || p.path === v || p.name?.toLowerCase() === k) || null;
};

// One call from a frame: checked, then done. Resolves with what goes back, or throws why not.
export async function paneCall(f, method, raw) {
  const it = appNow(f.id);
  const why = refusal(method, it?.allowed || []);
  if (why) throw new Error(why);
  const { args, error } = argsOf(method, Array.isArray(raw) ? raw : []);
  if (error) throw new Error(error);
  if (method.startsWith('tasks.') && ['tasks.launch', 'tasks.followUp', 'tasks.done'].includes(method)) {
    const now = Date.now();
    f.writes = f.writes.filter((t) => now - t < 60_000);
    if (f.writes.length >= PANE_WRITES_PER_MIN) throw new Error(`Slow down: a pane can start or change ${PANE_WRITES_PER_MIN} tasks a minute.`);
    f.writes.push(now);
  }
  const task = (id) => {
    const s = S.sessions.get(id);
    if (!s || !listedTasks([s]).length) throw new Error(`No task ${String(id).slice(0, 40)}.`);
    return s;
  };
  switch (method) {
    case 'tasks.list':
      return tasksNow();
    case 'tasks.get':
      return lightTask(task(args[0]));
    case 'tasks.watch':
      f.watching = true;
      setTimeout(() => post(f, { event: 'tasks', data: tasksNow() }));
      return true;
    case 'tasks.launch': {
      const p = projectFor(args[0].project);
      if (args[0].project && !p) throw new Error(`No project ${args[0].project}.`);
      // Your defaults decide the harness and the mode: a pane can't pick Full auto for itself.
      const out = await api('/sessions', { method: 'POST', body: { prompt: args[0].prompt, ...(p ? { cwd: p.path } : { scratch: true }) } });
      toast(`<b>${esc(it.title)}</b> started <b>${esc(out.title || 'a task')}</b>`);
      return out.id ? lightTask(out) : { queued: true };
    }
    case 'tasks.followUp': {
      task(args[0]);
      const { sendTo } = await import('./spell-actions.js');
      await sendTo(args[0], args[1]);
      return true;
    }
    case 'tasks.done': {
      const s = task(args[0]);
      if (s.state === 'done') return true;
      const { toggleDone } = await import('./actions.js');
      await toggleDone(s.id);
      return true;
    }
    case 'prs.list':
      return lightPrs(S.sessions.values());
    case 'crew.list':
      return (S.config.crew || []).map(lightMember);
  }
  throw new Error(`wisp has no ${method}().`);
}

addEventListener('message', async (e) => {
  const m = e.data;
  if (!m?.wispPane) return;
  const f = [...frames.values()].find((x) => x.iframe && x.iframe.contentWindow === e.source);
  // Only from a pane's own frame, on the origin it was opened on.
  if (!f || (f.origin && e.origin !== f.origin)) return;
  if (m.hello) return context(f);
  if (!m.id) return;
  try {
    post(f, { id: m.id, result: await paneCall(f, String(m.method || ''), m.args) });
  } catch (err) {
    post(f, { id: m.id, error: String(err?.message || err) });
  }
});

// Live: tasks that changed go to the panes that asked (wisp.on('tasks')), at most every 300 ms.
let soon = 0;
function pushTasks() {
  clearTimeout(soon);
  soon = setTimeout(() => {
    const list = tasksNow();
    for (const f of frames.values()) if (f.watching && !refusal('tasks.watch', appNow(f.id)?.allowed || [])) post(f, { event: 'tasks', data: list });
  }, 300);
}
bus.on('summary', pushTasks);
bus.on('listed', pushTasks);
bus.on('theme', () => frames.forEach(context));
bus.on('stuff-list', () => frames.forEach(paintBar));
