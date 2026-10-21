// Projects and machines: the places a task can run. A project is one repo, and runs on every place:
// it was added on one (path, machine), and wisp clones it onto the others the first time a task
// runs there (copies: { [machine id | 'here']: path }; server/services/places.js).

import { esc } from '../md.js';
import { icon } from '../core/dom.js';
import { HERE, S } from '../core/state.js';

export const projectById = (id) => S.config.projects.find((p) => p.id === id);

export const placeOf = (p) => p?.machine || '';
// A task's projects: its own, then those of the other folders it works in (also).
export const inProject = (s, id) => s.projectId === id || !!s.also?.some((a) => a.projectId === id);

// The project on a card: "api + web", or "api +2" past that, each one in the tooltip.
export function projectLabel(s) {
  const also = s.also || [];
  if (!also.length) return `<span class="q-proj">${esc(s.project)}</span>`;
  const names = [s.project, ...also.map((a) => a.project)];
  return `<span class="q-proj multi" title="${esc(`One task in ${names.length} folders: ${names.join(', ')}`)}">${esc(s.project)}<span class="q-also ${also.length === 1 ? `c-${also[0].color}` : ''}">${also.length === 1 ? `+ ${esc(also[0].project)}` : `+${also.length}`}</span></span>`;
}
export const placeName = (k) => (k ? machineById(k)?.name || 'machine' : HERE);
export const recentFirst = (a, b) => (b.lastUsedAt || b.addedAt) - (a.lastUsedAt || a.addedAt);
// Every project, on every place: one that isn't on a place yet gets cloned there on first use.
export const projects = () => [...S.config.projects].sort(recentFirst);
// The project's folder on place k, or '' when wisp still has to put it there.
export const pathAt = (p, k) => (placeOf(p) === k ? p.path : p?.copies?.[k || 'here'] || '');
// The places that have a checkout of it: where it was added first.
export const placesOf = (p) => (p ? [placeOf(p), ...Object.keys(p.copies || {}).map((k) => (k === 'here' ? '' : k))].filter((k, i, a) => a.indexOf(k) === i && (!k || machineById(k))) : []);

// A machine runs its own wisp; this one signs in over SSH, tunnels to it and shows its sessions
// as <id>@<machine>. Any project runs there; the launch clones it there first if it has to.
export const machineById = (id) => S.machines.find((m) => m.id === id);
// A cloud computer asleep still takes tasks: sending one wakes it.
export const usable = (m) => m?.state === 'online' || m?.state === 'asleep';
const machineOnline = (id) => usable(machineById(id));
export const MACHINE_STATE = { online: 'Online', asleep: 'Asleep', connecting: 'Connecting…', reconnecting: 'Reconnecting…', error: 'Couldn’t connect', off: 'Not connected' };
// Where it is: "~/code/app", "on devbox: /srv/app", plus the other places that have it.
export const projectTitle = (p) => {
  if (!p) return '';
  const tilde = (x) => (S.config.home && x.startsWith(S.config.home) ? `~${x.slice(S.config.home.length)}` : x);
  const m = p.machine && machineById(p.machine);
  const first = m ? `${p.path} on ${m.name}${m.state === 'online' ? '' : ' (not connected)'}` : tilde(p.path);
  const also = placesOf(p).slice(1).map(placeName);
  return also.length ? `${first}\nAlso checked out on ${also.join(', ')}` : first;
};

export function machinePill(mt) {
  const on = machineOnline(mt.id);
  return `<span class="q-machine ${on ? '' : 'off'}" title="Runs on ${esc(mt.name)} (${esc(mt.target)})${on ? '' : ' · not connected'}">${icon('server')}<span>${esc(mt.name)}</span></span>`;
}

export function machinesSummary() {
  const n = S.machines.length;
  if (!n) return 'None yet · run agents on another computer over SSH';
  const on = S.machines.filter(usable).length;
  return `${n} machine${n === 1 ? '' : 's'} · ${on ? `${on} online` : 'none online'}`;
}

export const projectName = (p) => S.config.projects.find((x) => x.path === p)?.name || String(p || '').split(/[\\/]/).pop();
