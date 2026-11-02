// Preview: the task's app, run from its folder (its worktree) and shown in the side panel
// (panel.js, tab 'preview'; server/runs.js runs it). Three states, each in its final shape at once:
//
//   not running  the command (.wisp/worktree.json's run, a guess from package.json said to be
//                one, or yours) in an editable box, and Run.
//   running      a slim bar (dot, address, Pick element, Logs, Restart, Stop, Open in browser) and
//                the app in a frame; until its port answers, its output in the frame's place.
//   failed       the exit code, its last lines, Run again.
//
// The frame loads the app through wisp's proxy for it (its own port: framable, and a small script
// in its pages that does the picking). Pick element is there once that script says hello: a click
// on an element puts a line naming it into the task's reply box. Without the proxy (it couldn't
// start) the frame shows the app itself and Pick isn't offered.
// Run, Stop and Restart change the page first and roll back with a toast if the server refuses.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, icon } from '../core/dom.js';
import { MOBILE, S } from '../core/state.js';
import { toastError } from '../ui/toast.js';
import { boxUrl, isLoopback, previewSandbox, shortUrl } from '../preview-spec.js';

const runs = new Map(); // task id -> the last run seen (GET /sessions/:id/run), or the one we just asked for
const drafts = new Map(); // task id -> the command as you typed it
const logsOn = new Set(); // task ids whose Logs are open
let frame = null; // { id, src, startedAt, node, pickable, picking }
let timer = null;

export const runOf = (id) => runs.get(id);
export const appRunning = (id) => !!runs.get(id)?.running;
export const runLabel = (id) => (appRunning(id) ? 'Stop app' : 'Run app');

export const RUN_HTML = `
  <section class="pn-run" hidden>
    <div class="rn-bar" hidden></div>
    <div class="rn-empty" hidden></div>
    <div class="rn-body" hidden><div class="rn-box"></div><div class="rn-log" hidden><pre></pre></div></div>
  </section>`;

const changed = (id) => bus.emit('run', id);

export async function loadRun(id) {
  try {
    const was = runs.get(id);
    const v = await api(`/sessions/${id}/run`);
    // A start or stop on its way: its answer is newer than this one.
    if (runs.get(id) !== was && runs.get(id)?.pending) return;
    runs.set(id, v);
  } catch (err) {
    if (!runs.has(id)) runs.set(id, { error: err.message, running: false, canRun: false });
  }
  changed(id);
}

const commandFor = (id) => {
  const d = runs.get(id);
  return (drafts.get(id) ?? d?.command ?? d?.config?.command ?? '').trim();
};

// Run (or Restart): the bar at once with "Starting", the server after; back as it was if it refuses.
export async function startRun(id, { restart = false, command = commandFor(id) } = {}) {
  const prev = runs.get(id);
  if (!command) return void $('.rn-cmd', document.querySelector('#sidePanel .pn-run'))?.focus();
  const mine = { ...(prev || {}), command, running: true, ready: false, exitCode: null, signal: null, stopped: false, startedAt: Date.now(), tail: '', proxyUrl: null, pending: true };
  runs.set(id, mine);
  changed(id);
  try {
    const v = await api(`/sessions/${id}/run`, { method: 'POST', body: { command, ...(restart && { restart: true }) } });
    if (runs.get(id) === mine) runs.set(id, { ...v, config: prev?.config, canRun: true });
    drafts.delete(id);
  } catch (err) {
    if (runs.get(id) === mine) runs.set(id, prev);
    toastError(err);
  }
  changed(id);
}

// Stop: the empty state at once; the app back if the server refuses.
export async function stopRun(id) {
  const prev = runs.get(id);
  if (!prev?.running) return;
  const mine = { ...prev, running: false, ready: false, stopped: true, pending: true };
  runs.set(id, mine);
  changed(id);
  try {
    const v = await api(`/sessions/${id}/run`, { method: 'DELETE' });
    if (runs.get(id) === mine) runs.set(id, { ...prev, ...v, running: false, stopped: true });
  } catch (err) {
    if (runs.get(id) === mine) runs.set(id, prev);
    toastError(err);
  }
  changed(id);
}

// Where the frame loads from here. Read away from the computer it runs on (a grid box), its
// localhost has an address of its own; elsewhere (a machine's task, a phone) it may not load.
function srcOf(id, d) {
  const url = d.proxyUrl || d.url;
  const boxed = !isLoopback(location.href) && !String(id).includes('@') && boxUrl(url, S.config?.preview || S.config?.grid?.preview);
  // The phone app reaches wisp through a tunnel: the app's own port isn't in it.
  return { src: boxed || url, far: !boxed && (MOBILE || String(id).includes('@') || !isLoopback(location.href)) };
}

const stateOf = (d) => (d.running ? 'live' : d.command && d.exitCode !== null && d.exitCode !== undefined && !d.stopped ? 'failed' : 'idle');
const lastLines = (tail, n) => String(tail || '').split('\n').slice(-n).join('\n');

function emptyHtml(id, d, failed) {
  if (!d.canRun && !failed) return `<div class="rn-msg">${icon('folder')}<p>This task has no folder to run an app from.</p></div>`;
  const cmd = drafts.get(id) ?? (failed ? d.command : d.config?.command) ?? '';
  const src = d.config?.source;
  const said = drafts.has(id) && drafts.get(id).trim() !== (d.config?.command || '') ? '' : src === 'config' ? 'From <code>.wisp/worktree.json</code>' : src === 'package.json' ? 'From package.json: a guess. Set <code>run</code> in <code>.wisp/worktree.json</code> to fix it.' : '';
  const head = failed
    ? `<div class="rn-fail">${icon('warn')}<b>${d.signal ? `Stopped by ${esc(d.signal)}` : `Exited with code ${esc(String(d.exitCode))}`}</b></div><pre class="rn-last">${esc(lastLines(d.tail, 12)) || 'No output.'}</pre>`
    : `<div class="rn-intro">${icon('play')}<p>Run the app from this task’s folder and see it here.</p></div>`;
  return `${head}
    <form class="rn-form">
      <label class="rn-lbl" for="rnCmd">Command</label>
      <div class="rn-row">
        <input id="rnCmd" class="input mono rn-cmd" value="${esc(cmd)}" placeholder="npm run dev" spellcheck="false" autocomplete="off" autocapitalize="off" aria-describedby="rnSaid">
        <button class="primary sm rn-go" type="submit"${cmd.trim() ? '' : ' disabled'}>${icon('play')}<span>${failed ? 'Run again' : 'Run'}</span></button>
      </div>
      <p class="rn-said" id="rnSaid">${said || 'It gets <code>PORT</code>: a free port for this task.'}</p>
    </form>`;
}

function barHtml(id, d) {
  const where = shortUrl(d.url || `localhost:${d.port || ''}`);
  const ready = d.ready;
  const pickOk = frame?.id === id && frame.pickable;
  const canPick = !!d.proxyUrl && !srcOf(id, d).far;
  return `<i class="rn-dot${ready ? ' on' : ''}" aria-hidden="true"></i>
    <span class="rn-state" title="${esc([d.url, d.command].filter(Boolean).join(' · '))}">${ready ? `Running · <span class="rn-addr">${esc(where)}</span>` : `Starting · <code>${esc(d.command || '')}</code>`}</span>
    <span class="grow"></span>
    ${canPick ? `<button class="ghost xs rn-pick" data-a="run-pick" aria-pressed="${!!frame?.picking}"${ready && pickOk ? '' : ' disabled'} title="${ready && pickOk ? 'Pick element: click one in the page to name it in the reply box' : 'Pick element (once the page has loaded)'}">${icon('target')}<span>Pick</span></button>` : ''}
    <button class="ghost xs rn-logs" data-a="run-logs" aria-pressed="${logsOn.has(id) || !ready}"${ready ? '' : ' disabled'} title="Logs: the app’s output">${icon('terminal')}<span>Logs</span></button>
    <button class="icon-btn xs" data-a="run-restart" title="Restart" aria-label="Restart">${icon('replay')}</button>
    <button class="icon-btn xs rn-stop" data-a="run-stop" title="Stop app" aria-label="Stop app">${icon('stop')}</button>
    <a class="icon-btn xs" href="${esc(d.url || '#')}" target="_blank" rel="noopener" title="Open in browser" aria-label="Open in browser">${icon('external')}</a>`;
}

const SKELETON = '<div class="rn-sk" aria-hidden="true"><i class="sk rn-sk-line"></i><i class="sk rn-sk-input"></i><i class="sk rn-sk-line short"></i></div>';

// Paint the task's Preview into the panel's section; unchanged parts stay as they are.
export function paintRun(sec, id) {
  const d = runs.get(id);
  const bar = $('.rn-bar', sec);
  const empty = $('.rn-empty', sec);
  const body = $('.rn-body', sec);
  if (!d) {
    bar.hidden = body.hidden = true;
    empty.hidden = false;
    if (empty.dataset.h !== 'sk') (empty.innerHTML = SKELETON), (empty.dataset.h = 'sk');
    loadRun(id);
    return;
  }
  const st = stateOf(d);
  sec.dataset.state = st;
  if (st !== 'live') {
    bar.hidden = body.hidden = true;
    empty.hidden = false;
    const html = emptyHtml(id, d, st === 'failed');
    // Typing changes the box, not the markup: while you're in it, only another task repaints it.
    if (empty.dataset.h !== html && (empty.dataset.id !== id || !empty.contains(document.activeElement))) Object.assign(empty, { innerHTML: html }).dataset.h = html;
    empty.dataset.id = id;
    dropFrame(sec);
    stopPoll();
    return;
  }
  empty.hidden = true;
  delete empty.dataset.h;
  bar.hidden = body.hidden = false;
  const b = barHtml(id, d);
  if (bar.dataset.h !== b) (bar.innerHTML = b), (bar.dataset.h = b);
  // Until the port answers, its output fills the frame's place: something is happening.
  const log = $('.rn-log', sec);
  const box = $('.rn-box', sec);
  log.hidden = d.ready && !logsOn.has(id);
  log.classList.toggle('full', !d.ready);
  box.hidden = !d.ready;
  paintLog(log, d.tail);
  if (d.ready) paintFrame(box, id, d);
  poll(sec, id);
}

function paintLog(log, tail) {
  const pre = $('pre', log);
  const text = tail || 'Starting…';
  if (pre.textContent === text) return;
  const end = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  pre.textContent = text;
  if (end) log.scrollTop = log.scrollHeight;
}

function paintFrame(box, id, d) {
  const { src, far } = srcOf(id, d);
  if (frame?.id === id && frame.src === src && frame.startedAt === d.startedAt && frame.node.isConnected) return;
  const node = document.createElement('iframe');
  node.className = 'rn-frame';
  node.title = 'Preview';
  node.setAttribute('sandbox', previewSandbox(src, location.origin));
  node.setAttribute('allow', 'clipboard-write');
  const f = (frame = { id, src, startedAt: d.startedAt, node, pickable: false, picking: false });
  // A new page in the frame (a link, a reload): its script says hello again.
  node.addEventListener('load', () => {
    if (frame !== f) return;
    f.pickable = false;
    f.picking = false;
    node.contentWindow?.postMessage({ wisp: 'pick', type: 'hello' }, '*');
    changed(id);
  });
  node.src = src;
  const note = far ? [Object.assign(document.createElement('p'), { className: 'rn-far', innerHTML: `${icon('info')}This address is on the computer the task runs on: this screen can’t reach it. Open it there.` })] : [];
  box.replaceChildren(...note, node);
}

function dropFrame(sec) {
  if (frame && sec.contains(frame.node)) (frame.node.remove(), (frame = null));
}

// While it shows: every second until it answers (or while Logs are open), else every 4s, to see
// it stop. Hidden (another tab, the panel shut, the window away), it doesn't ask.
function poll(sec, id) {
  stopPoll();
  const d = runs.get(id);
  const every = !d?.ready || logsOn.has(id) ? 1000 : 4000;
  timer = setTimeout(() => {
    timer = null;
    if (!sec.isConnected || sec.hidden || sec.closest('[hidden]') || document.visibilityState !== 'visible' || !runs.get(id)?.running) return;
    loadRun(id);
  }, every);
}
const stopPoll = () => (clearTimeout(timer), (timer = null));

// The picked element, as a line for the agent: what it is, its text, and where to find it.
export const pickLine = ({ tag, text, selector }) => `In the preview, ${tag}${text ? ` "${text}"` : ''} (selector: ${selector}):`;

function accentHex() {
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.fillStyle = '#3b82f6';
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3b82f6';
  return /^#[0-9a-f]{6}$/i.test(ctx.fillStyle) ? ctx.fillStyle : '#3b82f6';
}

function setPicking(on) {
  if (!frame) return;
  frame.picking = on;
  frame.node.contentWindow?.postMessage({ wisp: 'pick', type: on ? 'on' : 'off', color: accentHex() }, '*');
  if (on) frame.node.focus();
  changed(frame.id);
}

// A click in the section's bar.
export function runClick(e, id) {
  const a = e.target.closest('[data-a]')?.dataset.a;
  if (a === 'run-stop') return (void stopRun(id), true);
  if (a === 'run-restart') return (void startRun(id, { restart: true, command: runs.get(id)?.command }), true);
  if (a === 'run-logs') {
    logsOn.has(id) ? logsOn.delete(id) : logsOn.add(id);
    changed(id);
    return true;
  }
  if (a === 'run-pick') return (setPicking(!frame?.picking), true);
  return false;
}

// The section's form: Run (or Run again) with the command in the box; typing keeps it per task.
export function wireRun(sec, getId, { toReply }) {
  sec.addEventListener('submit', (e) => {
    if (!e.target.closest('.rn-form')) return;
    e.preventDefault();
    const id = getId();
    const command = ($('.rn-cmd', sec)?.value || '').trim();
    if (!command) return;
    drafts.set(id, command);
    startRun(id, { command });
  });
  sec.addEventListener('input', (e) => {
    if (!e.target.closest('.rn-cmd')) return;
    drafts.set(getId(), e.target.value);
    const go = $('.rn-go', sec);
    if (go) go.disabled = !e.target.value.trim();
  });
  addEventListener('message', (e) => {
    const d = e.data;
    if (!frame || e.source !== frame.node.contentWindow || d?.wisp !== 'pick') return;
    if (d.type === 'ready' && !frame.pickable) (frame.pickable = true), changed(frame.id);
    if (d.type === 'off' && frame.picking) (frame.picking = false), changed(frame.id);
    if (d.type === 'picked' && typeof d.tag === 'string' && typeof d.selector === 'string') {
      frame.picking = false;
      changed(frame.id);
      toReply(frame.id, pickLine({ tag: d.tag.slice(0, 200), text: String(d.text || '').slice(0, 80), selector: d.selector.slice(0, 300) }));
    }
  });
}

// Escape while picking ends it (when the focus is on wisp's side of the frame).
addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && frame?.picking) (e.stopPropagation(), setPicking(false));
  },
  true,
);
