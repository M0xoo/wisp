// Panes: a My Stuff app pinned beside the open task (a tab in the side panel, panel.js) or on split
// view's home (split.js). The pins are the `panes` setting ("<app>@task,<app>@home": a spell can set
// it); what each app may use is yours to allow (POST /stuff/:id/allow), never a spell's.
//
// The app runs where Launch runs it (its own port, services/apps.js), in a sandboxed frame with no
// popups, inside a script-less wrapper frame whose CSP stops it navigating away (paneFrameCsp).
// It talks to wisp only through messages (/_wisp/pane.js): each call is checked here against what
// you allowed (pane-bridge.js refusal) and only then goes to the real API, with light shapes back.
// Allowing tasks:write doesn't let a pane send anything: tasks.launch and tasks.followUp open
// wisp's own card (pane-card.js) and only your click on Send sends. tasks:write holds only for the
// code you allowed it on: every write asks the server first (GET /stuff/:id/grant).
// The Allow card only ever comes from your own click (Pin, or Allow… on the pane), never by itself,
// and never while the task it's for, or the task that made the app, runs in Full auto.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { el, icon } from '../core/dom.js';
import { MOBILE, S } from '../core/state.js';
import { ask } from '../ui/confirm.js';
import { toast, toastError } from '../ui/toast.js';
import { boxUrl, isLoopback } from '../preview-spec.js';
import { gridLink } from '../grid-link.js';
import { appFor, argsOf, launchBody, lightMember, lightPrs, lightTask, listedTasks, missingOf, notWhile, PANE_USES, PANE_WRITES, PANE_WRITES_PER_MIN, paneFrameCsp, panesString, paneWrapperDoc, parsePanes, refusal, runsFullAuto } from '../pane-bridge.js';
import { paneCard } from './pane-card.js';
import { agentName, DEFAULT_MODE, harnessesAt, MODES, savedAccount, savedEffort, savedModel } from './runners.js';

const frames = new Map(); // `${where}:${app id}` -> { node, iframe (the app's), origin, id, where, task, watching, writes }

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
  if (missingOf(it).length && !(await allowApp(it, anchor, { pinning: where, task: where === 'task' ? openTask() : null }))) return;
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

// The task (of those a pane's scopes can't widen under) that's running in Full auto now, if any:
// the one it's for, or the one that made the app. Crew jobs in Full auto elsewhere don't count.
const fullAutoRun = (it, task) => [task, it?.from?.session].map((id) => id && S.sessions.get(id)).find(runsFullAuto) || null;
const openTask = () => [...(S.open || [])][0] || null;

// The Allow card: what the app asks for, in words. true when it's pinned with that (or without
// any, if you say so), false on Cancel, or when a Full auto run forbids it.
export async function allowApp(it, anchor = null, { pinning = '', task = null } = {}) {
  const want = it.uses || [];
  if (!want.length) return true;
  const run = fullAutoRun(it, task);
  if (run) return toastError(new Error(notWhile(run))), false;
  const lines = want.map((u) => `• ${PANE_USES[u]}`).join('\n');
  const head = pinning ? `Pin ${it.title} ${WHERE_WORDS[pinning]}? It asks to:` : `Allow ${it.title} to:`;
  const risk = it.risky?.includes('webrtc') ? ' Its code uses WebRTC, which can send data straight out of wisp.' : '';
  const answer = await ask(`${head}\n\n${lines}\n\nwisp keeps it on its own address, but assume whoever wrote it can see what it reads.${risk} You can take back access from its menu in My Stuff.`, { ok: pinning ? 'Allow and pin' : 'Allow', alt: pinning ? 'Pin without' : '', anchor });
  if (!answer) return false;
  if (answer === 'alt') return true;
  return setAllowed(it, want, task);
}

export async function setAllowed(it, uses, task = null) {
  const was = { allowed: it.allowed, changed: it.changed };
  patchItem(it.id, { allowed: uses.length ? uses : undefined, changed: false });
  try {
    patchItem(it.id, { changed: false, ...(await api(`/stuff/${it.id}/allow`, uses.length ? { method: 'POST', body: { uses, ...(task && { task }) } } : { method: 'DELETE' })) });
    return true;
  } catch (err) {
    patchItem(it.id, was);
    toastError(err);
    return false;
  }
}

function patchItem(id, fields) {
  const i = (S.stuff || []).findIndex((x) => x.id === id);
  if (i < 0) return;
  const next = { ...S.stuff[i], ...fields };
  if (!next.allowed?.length) delete next.allowed;
  if (!next.changed) delete next.changed;
  S.stuff[i] = next;
  bus.emit('stuff-list');
}

// --- a pane on the page ---------------------------------------------------------------------------

// A Full auto task that's running never gets a card, not even the Allow… button that opens one.
const quietFor = (f) => !!fullAutoRun(appNow(f.id), f.where === 'task' ? f.task : null);

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
      if (a === 'allow') allowApp(now, e.target.closest('button'), { task: f.where === 'task' ? f.task : null }).then((ok) => ok && paintBar(f));
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
  need.textContent = !missing.length ? '' : it.changed ? 'Changed since allowed' : it.allowed?.length ? 'Some access not allowed' : 'No access yet';
  need.title = [need.textContent, ...missing.map((u) => PANE_USES[u])].join('\n'); // the bar may cut it short
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
    let link = await gridLink(url, to);
    // A preview address can send a frame through the grid's sign-in, so that origin is let through.
    const origins = [to, link, S.config?.grid?.url].filter(Boolean).map((u) => new URL(u).origin);
    // No sandbox (it's script-less and has to be same-origin for us to fill it), and it passes
    // clipboard-write on: a frame only gets what the frame around it has.
    const wrapper = el(`<iframe class="pa-frame" title="${esc(it.title)}" allow="clipboard-write"></iframe>`);
    wrapper.srcdoc = paneWrapperDoc(paneFrameCsp(origins));
    // Every load: moving the node reloads the wrapper, empty, as a new window.
    wrapper.addEventListener('load', async () => {
      const win = wrapper.contentWindow;
      const src = link || (await gridLink(url, to)); // a one-time link doesn't work twice
      link = '';
      appFrame(f, it, src, win);
    });
    stage.append(wrapper);
  } catch (err) {
    stage.innerHTML = `<p class="pa-off">${icon('warn')}${esc(err.message || 'It didn’t start.')}</p>`;
  }
}

// The app's frame, in the wrapper: its own origin (its storage, its database), scripts and forms;
// no popups, no top navigation. Its `parent` is the wrapper, so that's where its calls arrive.
function appFrame(f, it, src, win) {
  const iframe = el(`<iframe title="${esc(it.title)}" allow="clipboard-write" sandbox="allow-scripts allow-forms allow-same-origin"></iframe>`);
  iframe.addEventListener('load', () => (f.node.classList.add('ready'), context(f)));
  iframe.src = src;
  f.iframe = iframe;
  win.addEventListener('message', (e) => onMessage(f, e));
  win.document.body.append(iframe);
}

function drop(key) {
  const f = frames.get(key);
  if (!f) return;
  frames.delete(key);
  f.node.remove();
}

// --- the bridge ---------------------------------------------------------------------------------

const post = (f, m) => f.origin && f.iframe?.contentWindow?.postMessage({ wispPane: 1, ...m }, f.origin);
const theme = () => { const t = document.documentElement.dataset.theme; return t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'; };
const context = (f) => post(f, { event: 'context', data: { where: f.where, task: f.where === 'task' ? f.task : null, theme: theme() } });

const tasksNow = () => listedTasks(S.sessions.values()).filter((s) => !s.archived).map(lightTask);
const projectFor = (v) => {
  if (!v) return null;
  const k = String(v).toLowerCase();
  return (S.config.projects || []).find((p) => p.id === v || p.path === v || p.name?.toLowerCase() === k) || null;
};

// New task's defaults, resolved as the launcher resolves them: your harness if it's available
// here, else the first that is, and your mode. Not left to the server, which falls back to Full auto.
function launchDefaults() {
  const d = S.config.defaults;
  const here = harnessesAt([''], { auto: true });
  const chosen = here.find((a) => a.id === (d.agent || 'auto'));
  const agent = (chosen?.available ? chosen : here.find((a) => a.available) || chosen || here[0])?.id || d.agent || 'auto';
  const model = savedModel(agent);
  return { agent, mode: d.mode || DEFAULT_MODE.id, model, effort: savedEffort(agent, model), account: savedAccount(agent), worktree: d.worktree };
}

const modeRow = (id) => {
  const m = MODES.find((x) => x.id === id) || DEFAULT_MODE;
  return ['Mode', m.id === 'auto' ? `${m.label}: no permission prompts` : m.label, m.id === 'auto'];
};
const STATE_WORDS = { running: 'Working', waiting: 'Asking', review: 'Review', done: 'Done' };

// The server's word on what this pane may do now, into S.stuff; throws if it may not.
async function grantNow(f, method) {
  const { allowed, changed } = await api(`/stuff/${f.id}/grant`);
  patchItem(f.id, { allowed, changed });
  if (changed) throw new Error('This pane changed since you allowed it: allow it again from its bar.');
  const why = refusal(method, allowed);
  if (why) throw new Error(why);
}

// Only your click on the card lets a write go, one card at a time (no queue: a pane can't line up
// clicks), and what's true after the card is what counts, not what was true before it.
let waiting = false;
async function confirmed(f, method, spec, d) {
  if (waiting) throw new Error('A card is already waiting for you.');
  waiting = true;
  let yes = false;
  try {
    yes = await d.card(spec);
  } finally {
    waiting = false;
  }
  if (!yes) throw new Error('You didn’t send it.');
  if (!d.pinned(f)) throw new Error('This pane isn’t pinned any more, so nothing was sent.');
  await grantNow(f, method);
}

// One call from a frame: checked, then done. Resolves with what goes back, or throws why not.
// deps: what a test puts in place of the card, the frame list and sending.
export async function paneCall(f, method, raw, deps = {}) {
  const d = { card: paneCard, pinned: (x) => frames.get(x.key) === x, ...deps };
  const it = appNow(f.id);
  const write = PANE_WRITES.includes(method);
  // A changed app's list has lost tasks:write: that's for the server to say, in those words.
  const why = write && it?.changed ? '' : refusal(method, it?.allowed || []);
  if (why) throw new Error(why);
  const { args, error } = argsOf(method, Array.isArray(raw) ? raw : []);
  if (error) throw new Error(error);
  if (write) {
    const now = Date.now();
    f.writes = f.writes.filter((t) => now - t < 60_000);
    if (f.writes.length >= PANE_WRITES_PER_MIN) throw new Error(`Slow down: a pane can start or change ${PANE_WRITES_PER_MIN} tasks a minute.`);
    f.writes.push(now);
    await grantNow(f, method);
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
      const body = launchBody(launchDefaults(), args[0].prompt, p);
      await confirmed(f, method, { head: `${it.title} wants to start a task`, rows: [['Project', p?.name || 'No project'], ['Harness', agentName(body.agent)], modeRow(body.mode)], prompt: body.prompt }, d);
      const out = await api('/sessions', { method: 'POST', body });
      toast(`<b>${esc(it.title)}</b> started <b>${esc(out.title || 'a task')}</b>`);
      return out.id ? lightTask(out) : { queued: true };
    }
    case 'tasks.followUp': {
      const s = task(args[0]);
      await confirmed(f, method, { head: `${it.title} wants to send a follow-up`, rows: [['Task', s.title || 'Untitled'], ['Harness', agentName(s.agent)], modeRow(S.replyModes?.get(s.id) || s.mode), ['State', s.archived ? 'Archived' : STATE_WORDS[s.state] || s.state || '']], prompt: args[1] }, d);
      task(args[0]); // it may have gone while the card was up
      const { sendTo } = d.sendTo ? d : await import('./spell-actions.js');
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

// On the wrapper's window, one listener per wrapper load (appFrame). Only from this pane's own
// frame, on the origin it was opened on: no origin set, no call.
async function onMessage(f, e) {
  const m = e.data;
  if (!m?.wispPane || !f.iframe || e.source !== f.iframe.contentWindow || !f.origin || e.origin !== f.origin) return;
  if (m.hello) return context(f);
  if (!m.id) return;
  try {
    post(f, { id: m.id, result: await paneCall(f, String(m.method || ''), m.args) });
  } catch (err) {
    post(f, { id: m.id, error: String(err?.message || err) });
  }
}

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
