// Live events from the server (SSE) and the loads they trigger.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $ } from '../core/dom.js';
import { COMPUTER, MOBILE, S, nameHere, saveOpen, setAgents } from '../core/state.js';
import { toast } from '../ui/toast.js';
import { keepSignIns } from './agent-login.js';
import { paintAutoBtn } from './automations.js';
import { renderFeed, scheduleRefetch, sectionOf } from './feed.js';
import { dropPending, renderLaunchChips } from './launcher.js';
import { loadMachines, openComputers, paintMachinesBtn, setMachines } from './machines.js';
import { notifyFinished } from './notify.js';
import { renderProjects } from './projects.js';
import { feedAnchor, keepInPlace, watching } from './scroll.js';
import { openSettings } from './settings.js';
import { renderPrStrip } from './ship.js';
import { onChildSummary } from './team.js';
import { onActivity } from './turns.js';
import { applySpells, spellEvent } from './spells.js';
import { loadUpdate, renderUpdate } from './update.js';
import { applyView } from './split.js';
import { checkBuild, syncing } from './cache.js';

let es = null;
let hiddenAt = 0;
let helloed = false;
let configLoaded = false; // from the server, not the phone's snapshot

export function connect() {
  es?.close();
  es = new EventSource('/api/events');
  // The browser retries a dropped stream by itself, but gives up for good after an HTTP error
  // (a tunnel that is half back up can answer one): start a new one then.
  es.addEventListener('error', function () {
    if (this === es) syncing(true);
    if (this.readyState === EventSource.CLOSED && this === es) setTimeout(() => this === es && connect(), 3000);
  });
  es.addEventListener('summary', (e) => {
    const s = JSON.parse(e.data);
    if (s.parentId) return onChildSummary(s); // a subagent: lives inside its lead's card
    const prev = S.sessions.get(s.id);
    if (!prev) dropPending(s);
    const was = prev && sectionOf(prev); // before the update: a compare task's section depends on all its runs
    S.sessions.set(s.id, s);
    // A section change moves the card (a follow-up sends it from "Needs you" to "Working").
    // If the user is watching it, the view follows it there; otherwise whatever they're
    // reading stays put. Marking done or archiving is the exception: the card leaves the
    // list and focus goes to the next one instead.
    const moved = prev && was !== sectionOf(s);
    const follow = moved && s.state !== 'done' && !s.archived && watching(s.id);
    keepInPlace(follow ? S.nodes.get(s.id).card : feedAnchor(s.id), renderFeed);
    if (prev?.state !== s.state || prev?.queued !== s.queued) scheduleRefetch(s.id);
    if (JSON.stringify([prev?.pr, prev?.toShip, prev?.state, prev?.shipping]) !== JSON.stringify([s.pr, s.toShip, s.state, s.shipping])) renderPrStrip(s.id);
    if (prev?.state !== s.state || prev?.pr?.state !== s.pr?.state) spellEvent('summary');
  });
  es.addEventListener('activity', (e) => onActivity(JSON.parse(e.data)));
  es.addEventListener('turn', (e) => scheduleRefetch(JSON.parse(e.data).sessionId));
  es.addEventListener('finished', (e) => (notifyFinished(JSON.parse(e.data).session), spellEvent('finished')));
  // A spell hook's notify, from the server.
  es.addEventListener('spell', (e) => {
    const m = JSON.parse(e.data);
    if (m.toast) toast(`<b>${esc(m.spell)}</b> · ${esc(m.toast)}`);
  });
  es.addEventListener('removed', (e) => {
    const { id } = JSON.parse(e.data);
    S.sessions.delete(id);
    S.full.delete(id);
    S.open.delete(id);
    saveOpen();
    keepInPlace(feedAnchor(id), renderFeed);
  });
  es.addEventListener('config', () => (loadConfig(), bus.emit('config')));
  es.addEventListener('remote', () => bus.emit('remote'));
  es.addEventListener('machines', (e) => setMachines(JSON.parse(e.data)));
  es.addEventListener('cloud', (e) => bus.emit('cloud', JSON.parse(e.data)));
  es.addEventListener('agent-login', (e) => bus.emit('agent-login', JSON.parse(e.data)));
  es.addEventListener('update', (e) => renderUpdate(JSON.parse(e.data)));
  // A new harness or model Auto can use: it gets a few tasks before Auto relies on it.
  es.addEventListener('router', (e) => {
    const { added = [] } = JSON.parse(e.data || '{}');
    bus.emit('router');
    if (added.length) toast(`New for Auto: <b>${added.map((a) => esc(a.label)).join('</b>, <b>')}</b>${added.some((a) => a.state === 'new') ? ' · it will try it on a few tasks' : ''}`, { action: { label: 'Auto settings', run: () => openSettings({ pane: 'auto' }) }, timeout: 8000 });
  });
  // A harness was installed from wisp (maybe in another tab): fetch the new list.
  es.addEventListener('agents', async () => {
    setAgents(keepSignIns('', await api('/agents').catch(() => S.agents)));
    $('#launcher')?.placesChanged?.();
    bus.emit('agents');
  });
  es.addEventListener('preferences', () => bus.emit('preferences'));
  // Also after sleep or a reconnect: everything may have changed meanwhile.
  es.addEventListener('hello', () => {
    loadSessions()
      .then(() => syncing(false))
      .catch(() => {});
    // Config too, unless it was just loaded at boot.
    if (helloed || !configLoaded) loadConfig().then(() => bus.emit('config'), () => {});
    helloed = true;
    checkBuild();
    loadUpdate();
    loadMachines();
  });
}

// Back after a while away (the phone app was in the background, the laptop slept): the stream
// may look open but be dead, and what it missed is gone. A new one says `hello`, which reloads
// the list and every open task.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (es && hiddenAt && Date.now() - hiddenAt > 10000) connect();
});

export async function loadSessions() {
  const list = await api('/sessions');
  S.sessions = new Map(list.map((s) => [s.id, s]));
  for (const id of S.open) if (!S.sessions.has(id)) S.open.delete(id);
  saveOpen();
  keepInPlace(feedAnchor(), renderFeed);
  for (const id of S.open) scheduleRefetch(id);
}

export async function loadConfig() {
  setConfig(await api('/config'));
  configLoaded = true;
}
export function setConfig(config) {
  S.config = config;
  nameHere();
  paintMachinesBtn();
  applySpells();
  applyView();
  renderProjects();
  renderLaunchChips();
  paintAutoBtn();
}

// The phone app opens a computer's page from its cache before the tunnel is up (mobile/www/app.js)
// and passes the tunnel's progress here (WispSshPlugin.toPage). Up: catch up now instead of on
// the stream's next retry. Failed: say so, with the way back to Computers, where the fix is.
let tunnelToast = null;
function onTunnel(line) {
  const [, kind, rest = ''] = /^@@wisp (\S+) ?(.*)$/.exec(line || '') || [];
  if (kind === 'open') {
    tunnelToast?.remove();
    tunnelToast = null;
    if (es?.readyState !== EventSource.OPEN) connect();
  } else if (kind === 'fail') {
    syncing(false);
    tunnelToast?.remove();
    const why = rest.replace(/^\S+ ?/, '') || 'the connection failed';
    tunnelToast = toast(`Can’t reach <b>${esc(COMPUTER || 'this computer')}</b>: ${esc(why)}`, { tone: 'bad', timeout: 600_000, action: { label: 'Computers', run: openComputers } });
  } else if (kind === 'lost') {
    syncing(true);
  }
}
if (MOBILE) {
  addEventListener('wisp-tunnel', (e) => {
    onTunnel(e.detail);
  });
  try {
    const t = JSON.parse(window.wispAndroid?.tunnel?.() || 'null');
    if (t?.state === 'failed') onTunnel(t.line);
  } catch {}
}
