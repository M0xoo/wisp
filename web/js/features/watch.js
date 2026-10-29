// Watch: the page an agent keeps beside its task while it works (server/watch.js, wisp_watch). The
// side panel shows it (panel.js, tab 'watch'): a caption line with what the agent says it's doing,
// the page in a sealed frame (web/js/watch-doc.js), and how to run the thing yourself under it.
// Each change moves the task's summary (watch.seq); the panel then fetches the page and its state.
// Only a new page (watch.rev) reloads the frame: a new state is posted into it, so nothing flashes.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { copy } from '../blocks.js';
import { APP_TOKENS, themeCss } from '../app-doc.js';
import { watchDoc } from '../watch-doc.js';

const docs = new Map(); // task id -> the last page and state fetched ({ title, caption, state, run, seq, rev, closed, html, problem })
const loads = new Map(); // task id -> the fetch on its way; another change meanwhile fetches once more after it
let frame = null; // { id, rev, seq, node, ready } the frame on screen

function theme() {
  const cs = getComputedStyle(document.documentElement);
  const vars = Object.fromEntries(APP_TOKENS.map((t) => [t, cs.getPropertyValue(t).trim()]).filter(([, v]) => v));
  return { vars, scheme: cs.colorScheme === 'dark' ? 'dark' : 'light' };
}

// The task's page, fetched again; resolves once it's in docs (bus 'watch:doc' tells the panel).
export function loadWatch(id) {
  const on = loads.get(id);
  if (on) return ((on.again = true), on.p);
  const job = { again: false };
  job.p = (async () => {
    try {
      do {
        job.again = false;
        docs.set(id, await api(`/sessions/${id}/watch`));
        bus.emit('watch:doc', id);
      } while (job.again);
    } catch {
      // Gone (deleted, the machine went away): the panel keeps what it showed.
    } finally {
      loads.delete(id);
    }
  })();
  loads.set(id, job);
  return job.p;
}

// The caption line: a live dot while the task runs, what the agent says it's doing.
function captionHtml(id, d) {
  const s = S.sessions.get(id);
  const live = !d.closed && (s?.state === 'running' || s?.state === 'waiting');
  const text = d.caption || (d.closed ? 'Finished' : live ? 'Working' : 'Stopped');
  return `${live ? '<i class="wt-live" aria-hidden="true"></i>' : icon(d.closed ? 'done' : 'pause')}<span class="wt-text" title="${esc(text)}">${esc(text)}</span>`;
}

function runHtml(d) {
  const r = d.run;
  if (!r) return '';
  return `<span class="wt-lbl">${icon('terminal')}Run it yourself</span>
    <div class="wt-cmd"><code title="${esc(r.cwd)}">${esc(r.command)}</code><button class="icon-btn xs" data-a="copy-run" title="Copy the command, with cd into its folder" aria-label="Copy the command">${icon('copy')}</button></div>
    ${r.note ? `<p class="wt-note">${esc(r.note)}</p>` : ''}`;
}

const SKELETON = '<div class="wt-sk"><i class="sk wt-sk-line"></i><i class="sk wt-sk-bar"></i><i class="sk wt-sk-line short"></i><i class="sk wt-sk-box"></i></div>';

// Paint the task's watch into the panel's section. Called by the panel on every paint, and again
// when a fetch lands: unchanged parts stay as they are.
export function paintWatch(sec, id) {
  const d = docs.get(id);
  const cap = sec.querySelector('.wt-cap');
  const box = sec.querySelector('.wt-box');
  const run = sec.querySelector('.wt-run');
  if (!d) {
    if (!box.querySelector('.wt-sk')) {
      box.innerHTML = SKELETON;
      frame = null;
    }
    cap.innerHTML = '<i class="sk wt-sk-cap"></i>';
    delete cap.dataset.h;
    run.hidden = true;
    loadWatch(id);
    return;
  }
  const c = captionHtml(id, d);
  if (cap.dataset.h !== c) (cap.innerHTML = c), (cap.dataset.h = c);
  const r = runHtml(d);
  if (run.dataset.h !== r) (run.innerHTML = r), (run.dataset.h = r);
  run.hidden = !r;
  if (d.problem) {
    frame = null;
    box.innerHTML = `<div class="wt-msg">${icon('warn')}<p>${esc(d.problem)}</p></div>`;
    return;
  }
  if (frame?.id === id && frame.rev === d.rev && frame.node.isConnected) {
    // Before it has loaded, a message would be lost: its load sends what came meanwhile.
    if (frame.seq !== d.seq && frame.ready) frame.node.contentWindow?.postMessage({ type: 'state', state: d.state }, '*');
    if (frame.ready) frame.seq = d.seq;
    return;
  }
  const { vars, scheme } = theme();
  const node = document.createElement('iframe');
  node.setAttribute('sandbox', 'allow-scripts');
  node.setAttribute('title', d.title || 'Watch');
  node.className = 'wt-frame';
  node.srcdoc = watchDoc(d.html, { vars, scheme, state: d.state });
  const f = (frame = { id, rev: d.rev, seq: d.seq, node, ready: false });
  node.addEventListener('load', () => {
    f.ready = true;
    const now = docs.get(id);
    if (now && now.rev === f.rev && now.seq !== f.seq) (node.contentWindow?.postMessage({ type: 'state', state: now.state }, '*'), (f.seq = now.seq));
  });
  box.replaceChildren(node);
}

// The panel's head: the page's title.
export const watchTitle = (id) => docs.get(id)?.title || S.sessions.get(id)?.watch?.title || 'Watch';

// A click in the section.
export function watchClick(e, id) {
  const b = e.target.closest('[data-a="copy-run"]');
  const r = docs.get(id)?.run;
  if (!b || !r) return false;
  copy(`cd ${/^[\w./~-]+$/.test(r.cwd) ? r.cwd : `'${r.cwd.replace(/'/g, `'\\''`)}'`} && ${r.command}`, b);
  return true;
}

// The section's markup, for the panel.
export const WATCH_HTML = '<section class="pn-watch" hidden><div class="wt-cap"></div><div class="wt-box"></div><div class="wt-run" hidden></div></section>';

// A change elsewhere means the cached page is old: fetch it when it's shown next.
export const forgetWatch = (id) => docs.delete(id);

// Light and dark: the frame follows without reloading.
bus.on('theme', () => {
  requestAnimationFrame(() => {
    if (!frame?.node.isConnected) return;
    const { vars, scheme } = theme();
    frame.node.contentWindow?.postMessage({ type: 'theme', css: themeCss(vars, scheme), scheme }, '*');
  });
});
