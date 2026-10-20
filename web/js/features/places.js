// Projects and machines: the places a task can run. A project is a folder, on this computer or on a
// machine (another computer running its own wisp, reached over SSH).

import { esc } from '../md.js';
import { icon } from '../core/dom.js';
import { S } from '../core/state.js';

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
export const placeName = (k) => (k ? machineById(k)?.name || 'machine' : 'This computer');
export const recentFirst = (a, b) => (b.lastUsedAt || b.addedAt) - (a.lastUsedAt || a.addedAt);
export const projectsAt = (k) => S.config.projects.filter((p) => placeOf(p) === k).sort(recentFirst);

// A machine runs its own wisp; this one signs in over SSH, tunnels to it and shows its sessions
// as <id>@<machine>. Projects can live on a machine; launching in one runs the agent there.
export const machineById = (id) => S.machines.find((m) => m.id === id);
const machineOnline = (id) => machineById(id)?.state === 'online';
export const MACHINE_STATE = { online: 'Online', connecting: 'Connecting…', reconnecting: 'Reconnecting…', error: 'Couldn’t connect', off: 'Not connected' };
export const projectTitle = (p) => {
  if (!p) return '';
  const m = p.machine && machineById(p.machine);
  return m ? `${p.path} on ${m.name}${m.state === 'online' ? '' : ' (not connected)'}` : p.path;
};

export function machinePill(mt) {
  const on = machineOnline(mt.id);
  return `<span class="q-machine ${on ? '' : 'off'}" title="Runs on ${esc(mt.name)} (${esc(mt.target)})${on ? '' : ' · not connected'}">${icon('server')}<span>${esc(mt.name)}</span></span>`;
}

export function machinesSummary() {
  const n = S.machines.length;
  if (!n) return 'None yet · run agents on another computer over SSH';
  const on = S.machines.filter((m) => m.state === 'online').length;
  return `${n} machine${n === 1 ? '' : 's'} · ${on ? `${on} online` : 'none online'}`;
}

export const projectName = (p) => S.config.projects.find((x) => x.path === p)?.name || String(p || '').split(/[\\/]/).pop();
