// The side panel's Browser tab, on a task that runs in a sandbox (services/sandbox.js): the
// sandbox's Chromium, live, the one its agent drives through the Browser connector. It's noVNC
// served from the sandbox through the grid (p6080--sb-…), opened with a one-time link the server
// asks for (POST /api/sandbox/browser). You can click and type in it too.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import { icon } from '../core/dom.js';
import { S } from '../core/state.js';

export const BROWSER_HTML = '<section class="pn-browser" hidden><div class="br-box"></div></section>';
export const sandboxed = (s) => !!s?.machine?.sandbox && !s.pending;

const views = new Map(); // task id -> { url } | { error } | { loading: true }
let frame = null; // { id, url, node }

const SKELETON = '<div class="br-sk"><i class="sk br-sk-bar"></i><i class="sk br-sk-page"></i><p class="br-wait"><i class="spin"></i>Starting the sandbox’s browser…</p></div>';

// size: the tab's box, so the sandbox's screen fits it and the view is 1:1.
async function load(id, repaint, size = {}) {
  views.set(id, { loading: true });
  try {
    const { url } = await api('/sandbox/browser', { method: 'POST', body: { task: id, ...size } });
    views.set(id, { url });
  } catch (err) {
    views.set(id, { error: err.message });
  }
  repaint();
}

// sec: the panel's .pn-browser; repaint: paint the panel again once the link is in.
export function paintBrowser(sec, id, repaint) {
  const box = sec.querySelector('.br-box');
  const s = S.sessions.get(id);
  if (!sandboxed(s)) {
    frame = null;
    box.innerHTML = `<div class="br-msg">${icon('info')}<p>Only a task started with <code>/sandbox</code> has a browser here.</p></div>`;
    return;
  }
  const v = views.get(id);
  const size = () => ({ width: box.clientWidth || 800, height: Math.max(0, (box.clientHeight || 600) - 32) });
  if (!v) return void ((box.innerHTML = SKELETON), (frame = null), load(id, repaint, size()));
  if (v.loading) {
    if (!box.querySelector('.br-sk')) (box.innerHTML = SKELETON), (frame = null);
    return;
  }
  if (v.error) {
    frame = null;
    box.innerHTML = `<div class="br-msg">${icon('warn')}<p>${esc(v.error)}</p><button class="ghost sm" data-br="retry">Try again</button></div>`;
    box.querySelector('[data-br="retry"]').onclick = () => {
      views.delete(id);
      repaint();
    };
    return;
  }
  // Already showing it: never reload the frame on a repaint (the view would reconnect).
  if (frame?.id === id && frame.url === v.url && frame.node.isConnected) return;
  // Its link signs in once: shown before (then another task), it takes a fresh one.
  if (v.used) return void (views.delete(id), paintBrowser(sec, id, repaint));
  v.used = true;
  box.innerHTML = `<div class="br-bar"><span>${icon('box')}Sandbox browser · what the agent drives, live</span><span class="br-acts"><button class="icon-btn" data-br="pop" title="Open in its own window" aria-label="Open in its own window">${icon('external')}</button><button class="icon-btn" data-br="reload" title="Reconnect and fit the panel" aria-label="Reconnect and fit the panel">${icon('rerun')}</button></span></div><iframe class="br-frame" title="The sandbox’s browser" allow="clipboard-read; clipboard-write"></iframe>`;
  const node = box.querySelector('.br-frame');
  node.src = v.url;
  frame = { id, url: v.url, node };
  // Its own window, the size of your screen: the window opens at once (a popup after an await is
  // blocked), then gets a fresh link (the frame's was used).
  box.querySelector('[data-br="pop"]').onclick = async () => {
    const w = window.open('about:blank', '_blank');
    try {
      const { url } = await api('/sandbox/browser', { method: 'POST', body: { task: id, width: Math.min(screen.availWidth, 1920), height: Math.min(screen.availHeight - 80, 1200) } });
      if (w) w.location.href = url;
    } catch (err) {
      w?.close();
      views.set(id, { error: err.message });
      repaint();
    }
  };
  // A link signs in once: reconnecting asks for a fresh one.
  box.querySelector('[data-br="reload"]').onclick = () => {
    views.delete(id);
    frame = null;
    repaint();
  };
}
