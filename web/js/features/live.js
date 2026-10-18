// Live events from the server (SSE) and the loads they trigger.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { S, saveOpen } from '../core/state.js';
import { toast } from '../ui/toast.js';
import { paintAutoBtn } from './automations.js';
import { collapse, renderFeed, scheduleRefetch, sectionOf } from './feed.js';
import { dropPending, renderLaunchChips } from './launcher.js';
import { loadMachines, setMachines } from './machines.js';
import { notifyFinished } from './notify.js';
import { renderProjects } from './projects.js';
import { feedAnchor, keepInPlace, watching } from './scroll.js';
import { openSettings } from './settings.js';
import { renderPrStrip } from './ship.js';
import { onChildSummary } from './team.js';
import { onActivity } from './turns.js';
import { loadUpdate, renderUpdate } from './update.js';

export function connect() {
  const es = new EventSource('/api/events');
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
    keepInPlace(follow ? S.nodes.get(s.id).card : feedAnchor(s.id), () => {
      // A card left open while it worked shouldn't land in "Needs you" expanded —
      // fold it unless the user is actually watching it.
      if (prev?.state === 'running' && s.state !== 'running' && S.open.has(s.id) && !(watching(s.id) && document.hasFocus())) collapse(s.id);
      renderFeed();
    });
    if (prev?.state !== s.state || prev?.queued !== s.queued) scheduleRefetch(s.id);
    if (JSON.stringify([prev?.pr, prev?.toShip, prev?.state]) !== JSON.stringify([s.pr, s.toShip, s.state])) renderPrStrip(s.id);
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
    keepInPlace(feedAnchor(id), renderFeed);
  });
  es.addEventListener('config', () => (loadConfig(), bus.emit('config')));
  es.addEventListener('remote', () => bus.emit('remote'));
  es.addEventListener('machines', (e) => setMachines(JSON.parse(e.data)));
  es.addEventListener('update', (e) => renderUpdate(JSON.parse(e.data)));
  // A new harness or model Auto can use: it gets a few tasks before Auto relies on it.
  es.addEventListener('router', (e) => {
    const { added = [] } = JSON.parse(e.data || '{}');
    bus.emit('router');
    if (added.length) toast(`New for Auto: <b>${added.map((a) => esc(a.label)).join('</b>, <b>')}</b>${added.some((a) => a.state === 'new') ? ' · it will try it on a few tasks' : ''}`, { action: { label: 'Auto settings', run: () => openSettings({ pane: 'auto' }) }, timeout: 8000 });
  });
  es.addEventListener('preferences', () => bus.emit('preferences'));
  es.addEventListener('hello', () => (loadSessions(), loadUpdate(), loadMachines())); // also after sleep/reconnect
}

export async function loadSessions() {
  const list = await api('/sessions');
  S.sessions = new Map(list.map((s) => [s.id, s]));
  for (const id of S.open) if (!S.sessions.has(id)) S.open.delete(id);
  saveOpen();
  keepInPlace(feedAnchor(), renderFeed);
  for (const id of S.open) scheduleRefetch(id);
}

export async function loadConfig() {
  S.config = await api('/config');
  renderProjects();
  renderLaunchChips();
  paintAutoBtn();
}
