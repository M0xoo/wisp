// "Get the app": in a plain browser tab (a wisp Grid, or `wisp --browser`), a pill in the top bar
// invites you to the desktop app. Not in the desktop app itself, the phone app, or on a phone's
// browser. Its card says what the app adds and links to trywisp.dev; "Hide this" keeps it away
// (the command palette still has it).

import { track } from '../core/api.js';
import { $, el, icon } from '../core/dom.js';
import { MOBILE, inGrid, load, save } from '../core/state.js';
import { popover } from '../ui/popover.js';
import { toast } from '../ui/toast.js';

export const APP_URL = 'https://trywisp.dev/#install';
const HIDDEN = 'wisp.getApp.hidden';

export const inBrowser = () => !MOBILE && !window.wispDesktop && !/Electron/.test(navigator.userAgent) && matchMedia('(pointer: fine)').matches;

export function paintGetApp() {
  const b = $('#getAppBtn');
  if (!b) return;
  b.hidden = !inBrowser() || load(HIDDEN, false);
  b.onclick = () => {
    openGetApp(b, 'button');
  };
}

export function openGetApp(anchor = $('#getAppBtn'), from = 'search') {
  if ($('.getapp')) return $('.getapp').close?.();
  track('getapp_opened', { from });
  const why = [
    ['bolt', 'Notifications when an agent needs you, with no tab to keep open'],
    ['terminal', 'Opens files in your editor and your terminal in one click'],
    inGrid() ? ['cloud', 'Your agents on your own computer too, and this cloud computer right next to them'] : ['laptop', 'Its own window and Dock icon, a folder picker, and it starts with your computer'],
  ];
  const node = el(`<div class="getapp" role="dialog" aria-label="Get the desktop app">
      <div class="ga-head"><span class="orb tiny"></span><div><b>wisp for your desktop</b><small>macOS, Windows and Linux · free</small></div></div>
      <ul>${why.map(([i, t]) => `<li>${icon(i)}<span>${t}</span></li>`).join('')}</ul>
      <div class="ga-acts">
        <a class="primary sm btn-link" href="${APP_URL}" target="_blank" rel="noopener">${icon('external')}Get it on trywisp.dev</a>
        ${$('#getAppBtn') && !$('#getAppBtn').hidden ? '<button class="ghost sm" data-hide>Hide this</button>' : ''}
      </div>
    </div>`);
  const r = anchor && !anchor.hidden ? anchor.getBoundingClientRect() : { bottom: 52, right: innerWidth - 16 };
  node.style.top = `${r.bottom + 8}px`;
  node.style.right = `${Math.max(12, innerWidth - r.right)}px`;
  node.addEventListener('click', (e) => {
    if (e.target.closest('a')) {
      track('getapp_clicked');
      node.close();
    }
    if (!e.target.closest('[data-hide]')) return;
    node.close();
    save(HIDDEN, true);
    track('getapp_hidden');
    paintGetApp();
    toast('Hidden. Search (⌘K) still has <b>Get the desktop app</b>.');
  });
  popover(node, { anchor });
}
