// Repos being cloned. Clone in the Projects dialog hands the repo off here and the dialog closes:
// the launcher picks it at once (a spinner chip) so you can write the task while it clones, and a
// launch into it waits for the clone. Success swaps the chip for the real project.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { launch, S, save, saveLaunch } from '../core/state.js';
import { toast } from '../ui/toast.js';
import { renderFeed } from './feed.js';
import { renderLaunchChips } from './launcher.js';
import { loadConfig } from './live.js';
import { machineById, projectById } from './places.js';
import { renderProjects } from './projects.js';

// A pasted repo URL, which the server clones (server/git.js parseRepo has the full rules), vs a path.
export const isRepo = (s) => /^((https?|ssh|git):\/\/|[\w.-]+@[\w.-]+:|(www\.)?github\.com\/)/i.test(String(s).trim());
export const repoLabel = (s) =>
  String(s)
    .trim()
    .replace(/^((https?|ssh):\/\/)?([\w.-]+@)?(www\.)?github\.com[/:]([^/]+\/[^/#?]+).*$/i, '$5')
    .replace(/\.git$|\/+$/i, '');
export const repoName = (s) => repoLabel(s).split(/[/:]/).pop();

export const clones = []; // { id, url, where, name, label, promise }
export const cloneById = (id) => clones.find((c) => c.id === id);
let seq = 0;

const tilde = (p) => (S.config.home && p.startsWith(S.config.home) ? `~${p.slice(S.config.home.length)}` : p);

// Start cloning `url` on `where` (a machine id, or null for this computer) and point the launcher
// at it. job.promise resolves with the project, or rejects (already toasted) and the launcher
// goes back to what it had picked.
export function startClone(url, where = null) {
  const k = where || '';
  const prev = launch.picks[''];
  const job = { id: `clone-${++seq}`, url, where: where || null, name: repoName(url), label: repoLabel(url) };
  clones.push(job);
  // A feed filtered to another project would pull the launcher back to that project.
  if (S.filter !== 'all') {
    S.filter = 'all';
    save('wisp.filter', S.filter);
    renderFeed();
    renderProjects();
  }
  launch.picks[''] = job.id;
  delete launch.also[''];
  launch.project = job.id;
  if (!launch.where.includes(k)) launch.where = [k];
  const repick = (id) => {
    if (launch.picks[''] !== job.id) return; // picked something else meanwhile
    launch.picks[''] = id;
    launch.project = id;
    saveLaunch();
  };
  const on = where ? ` on ${esc(machineById(where)?.name || 'the machine')}` : '';
  job.promise = api('/projects', { method: 'POST', body: { repo: url, ...(where && { machine: where }) } })
    .then(
      async (proj) => {
        await loadConfig();
        repick(proj.id);
        toast(proj.cloned?.existed ? `<b>${esc(proj.name)}</b> was already cloned at ${esc(tilde(proj.path))}: added it` : `Cloned <b>${esc(proj.name)}</b>${on}${where ? '' : ` into ${esc(tilde(proj.path))}`}`);
        return proj;
      },
      (err) => {
        repick(projectById(prev) ? prev : null);
        toast(esc(err.message), { tone: 'bad', timeout: 8000 });
        throw Object.assign(err, { shown: true });
      },
    )
    .finally(() => {
      clones.splice(clones.indexOf(job), 1);
      renderLaunchChips();
      bus.emit('clones');
    });
  job.promise.catch(() => {}); // the launcher or dialog may not be waiting on it
  renderLaunchChips();
  bus.emit('clones');
  return job;
}
