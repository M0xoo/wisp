// Live events from the server (SSE) and the loads they trigger.

import { esc } from '../md.js';
import { api, shared } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $ } from '../core/dom.js';
import { COMPUTER, MOBILE, S, nameHere, saveOpen, setAgents } from '../core/state.js';
import { toast } from '../ui/toast.js';
import { keepSignIns } from './agent-login.js';
import { paintAutoBtn } from './automations.js';
import { updateDock } from './composer.js';
import { paintCrew, paintOffers } from './crew.js';
import { renderFeed, scheduleRefetch } from './feed.js';
import { dropPending, renderLaunchChips } from './launcher.js';
import { loadMachines, openComputers, paintMachinesBtn, setMachines } from './machines.js';
import { notifyFinished, notifyReminder } from './notify.js';
import { renderProjects } from './projects.js';
import { feedAnchor, keepInPlace } from './scroll.js';
import { openSettings } from './settings.js';
import { renderPrStrip } from './ship.js';
import { renderOverlapStrip } from './overlaps.js';
import { onChildSummary } from './team.js';
import { keepSubs } from './lineage.js';
import { onActivity } from './turns.js';
import { applySpells, spellEvent } from './spells.js';
import { loadUpdate, renderUpdate } from './update.js';
import { applyView } from './split.js';
import { applyTheme } from './theme.js';
import { checkBuild, syncing } from './cache.js';
import { streamDown, streamUp } from './reconnecting.js';
import { homeScreenTags } from './homescreen.js';
import { stream } from '../no-output.js';

let es = null;
let hiddenAt = 0;
let helloed = false;
let firstStream = 0; // when the page opened its first stream

export function connect() {
  if (es) stream.drop(); // a new stream: the old one may have been dead for a while
  es?.close();
  firstStream ||= performance.now();
  es = new EventSource('/api/events');
  // The browser retries a dropped stream by itself, but gives up for good after an HTTP error
  // (a tunnel that is half back up can answer one): start a new one then.
  es.addEventListener('error', function () {
    if (this === es) {
      syncing(true);
      streamDown();
      stream.drop();
    }
    if (this.readyState === EventSource.CLOSED && this === es) setTimeout(() => this === es && connect(), 3000);
  });
  es.addEventListener('summary', (e) => {
    const s = JSON.parse(e.data);
    if (s.parentId) return onChildSummary(s); // a subagent: lives inside its lead's card
    if (s.delegated) return; // a delegate's run for a lead elsewhere: its lead's card shows it
    if (S.deleting.has(s.id)) return; // swiped away, its Undo still showing
    const prev = S.sessions.get(s.id);
    if (!prev) dropPending(s);
    S.sessions.set(s.id, s);
    bus.emit('summary', s.id); // panes that watch tasks (panes.js)
    // A section change moves the row (a follow-up sends it from "Needs you" to "Working"), the open
    // task's too: the list stays where it was, and the main pane still shows the task.
    keepInPlace(feedAnchor(s.id), renderFeed);
    // The full task too when only it is behind: an optimistic Mark done / Reopen already set the summary.
    if (prev?.state !== s.state || prev?.queued !== s.queued || (S.full.get(s.id) && S.full.get(s.id).state !== s.state)) scheduleRefetch(s.id);
    if (!!prev?.term !== !!s.term && S.nodes.has(s.id)) updateDock(s.id); // the follow-up box says it's in a terminal
    else if (JSON.stringify(prev?.later || null) !== JSON.stringify(s.later || null) && S.nodes.has(s.id)) updateDock(s.id); // its scheduled follow-ups, above the box
    if (JSON.stringify([prev?.pr, prev?.also, prev?.prs, prev?.toShip, prev?.state, prev?.shipping, prev?.review]) !== JSON.stringify([s.pr, s.also, s.prs, s.toShip, s.state, s.shipping, s.review])) renderPrStrip(s.id);
    if (prev?.shipping && !s.shipping) bus.emit('shipped', s.id); // landed here or in another window: Changes looks again
    if (JSON.stringify(prev?.review || null) !== JSON.stringify(s.review || null)) bus.emit('review', s.id); // the PR panel's review section
    if (JSON.stringify(prev?.overlaps || null) !== JSON.stringify(s.overlaps || null)) renderOverlapStrip(s.id);
    if (prev?.state !== s.state || prev?.pr?.state !== s.pr?.state) spellEvent('summary');
    // Watch: the page its agent keeps beside it moved (panel.js); opened: put up just now.
    if (s.watch && (prev?.watch?.seq !== s.watch.seq || prev?.state !== s.state)) bus.emit('watch', { id: s.id, opened: !!prev && !s.watch.closed && (!prev.watch || (prev.watch.closed && prev.watch.seq !== s.watch.seq)) });
  });
  es.addEventListener('activity', (e) => {
    const a = JSON.parse(e.data);
    onActivity(a);
    if (a.item?.kind === 'edit') bus.emit('edit', a.sessionId); // the panel's Changes looks again
  });
  es.addEventListener('goal-run', (e) => bus.emit('goal-run', JSON.parse(e.data))); // a goal check's page (goal-run.js)
  es.addEventListener('turn', (e) => scheduleRefetch(JSON.parse(e.data).sessionId));
  es.addEventListener('finished', (e) => (notifyFinished(JSON.parse(e.data).session), spellEvent('finished')));
  es.addEventListener('reminder', (e) => notifyReminder(JSON.parse(e.data).session));
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
    bus.emit('summary', id);
  });
  es.addEventListener('config', () => (loadConfig(), bus.emit('config')));
  es.addEventListener('remote', () => bus.emit('remote'));
  es.addEventListener('connectors', () => bus.emit('connectors'));
  es.addEventListener('machines', (e) => setMachines(JSON.parse(e.data)));
  es.addEventListener('cloud', (e) => bus.emit('cloud', JSON.parse(e.data)));
  es.addEventListener('computer', (e) => bus.emit('computer', JSON.parse(e.data)));
  es.addEventListener('sandbox', (e) => bus.emit('sandbox', JSON.parse(e.data)));
  es.addEventListener('sandbox-step', (e) => bus.emit('sandbox-step', JSON.parse(e.data)));
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
  es.addEventListener('ping', () => {
    stream.heard(Date.now());
  });
  es.addEventListener('preferences', () => bus.emit('preferences'));
  es.addEventListener('stuff', () => bus.emit('stuff'));
  // Also after sleep or a reconnect: everything may have changed meanwhile.
  // The first one: boot asked for the lists right after opening the stream, so those answers
  // already have everything since; it waits for them instead of asking again.
  es.addEventListener('hello', () => {
    streamUp();
    stream.hello(Date.now());
    const fresh = (load) => (helloed ? load() : load.since(firstStream));
    fresh(loadSessions)
      .then(() => syncing(false))
      .catch(() => {});
    if (helloed) loadConfig().then(() => bus.emit('config'), () => {});
    else loadConfig.since(firstStream).catch(() => {});
    if (helloed) bus.emit('stuff'); // My Stuff may have changed while the stream was down
    fresh(loadMachines); // before helloed is set: the first one shares boot's request
    helloed = true;
    checkBuild();
    loadUpdate();
  });
}

// Back after a while away (the phone app was in the background, the laptop slept): the stream
// may look open but be dead, and what it missed is gone. A new one says `hello`, which reloads
// the list and every open task.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (es && hiddenAt && Date.now() - hiddenAt > 10000) connect();
});
// The network is back (out of a tunnel, off a dead Wi-Fi): reconnect now rather than at the
// stream's next retry, seconds away. Its `hello` refetches the list (what changed since) and the
// open task (304 if unchanged).
addEventListener('online', () => {
  if (!es) return;
  connect();
  for (const id of S.open) scheduleRefetch(id, 0); // the task on screen doesn't wait for the stream's hello
});

// The open task's copy came from the server: fetchOnce in feed.js, after every hello.
bus.on('task', (id) => {
  stream.read(id);
});

// Hide .env values turned on or off (Settings → Privacy): the open tasks come again masked or not.
bus.on('envmask', () => {
  for (const id of S.open) scheduleRefetch(id, 0);
});

// The phone asks for what changed since its last list (thousands of tasks are hundreds of KB, and
// it fetches the list each time it comes back); the answer says when it's the whole list instead.
export const loadSessions = shared(async () => {
  const prev = S.sessions;
  if (MOBILE) {
    const r = await api(`/sessions?since=${encodeURIComponent(S.listToken)}`);
    S.listToken = r.token || '';
    // As the whole list would: no placeholders or subagents (keepSubs puts back the ones still open).
    const next = r.full ? new Map(r.full.map((s) => [s.id, s])) : new Map([...prev].filter(([, s]) => !s.pending && !s.parentId && !s.delegated));
    for (const id of r.removed || []) next.delete(id);
    for (const s of r.changed || []) next.set(s.id, s);
    for (const id of S.deleting) next.delete(id);
    S.sessions = next;
  } else {
    const list = await api('/sessions');
    S.sessions = new Map(list.filter((s) => !S.deleting.has(s.id)).map((s) => [s.id, s]));
  }
  keepSubs(prev); // subagents opened by themselves aren't in the list
  for (const id of S.open) if (!S.sessions.has(id)) S.open.delete(id);
  saveOpen();
  keepInPlace(feedAnchor(), renderFeed);
  for (const id of S.open) scheduleRefetch(id);
  bus.emit('listed'); // the server's list is in (New task's first run waits for it)
});

export const loadConfig = shared(async () => {
  const config = await api('/config');
  // The stream says `config` after every change, ours too: one already painted repaints nothing.
  if (JSON.stringify(config) !== JSON.stringify(S.config)) setConfig(config);
});
export function setConfig(config) {
  const pinned = S.config?.defaults?.panes;
  S.config = config;
  if ((config.defaults?.panes || '') !== (pinned || '')) queueMicrotask(() => bus.emit('panes')); // an agent's save pinned it
  nameHere();
  homeScreenTags();
  paintMachinesBtn();
  applySpells();
  applyTheme();
  applyView();
  renderProjects();
  renderLaunchChips();
  paintAutoBtn();
  // The crew lives in the config: its section, and the faces on its jobs' cards.
  if (S.sessions.size) renderFeed();
  else paintCrew();
  paintOffers(); // kit files proposed under an open task's answer
  // The pinned apps (the panes setting, yours or a spell's): only when they changed.
  if (config.defaults?.panes !== lastPanes) (lastPanes = config.defaults?.panes), bus.emit('panes');
}
let lastPanes;

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
    streamUp(); // the toast below says it, with Computers
    tunnelToast?.remove();
    const why = rest.replace(/^\S+ ?/, '') || 'the connection failed';
    tunnelToast = toast(`Can’t reach <b>${esc(COMPUTER || 'this computer')}</b>: ${esc(why)}`, { tone: 'bad', timeout: 600_000, action: { label: 'Computers', run: openComputers } });
  } else if (kind === 'lost') {
    syncing(true);
    stream.drop();
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
