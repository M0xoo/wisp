// A task's folder on another computer (v1 services/places.js placeBody → dirAt → ensureAt): the same folder in that
// computer's checkout of the project's repo. That computer finds its checkout (one of its projects with that origin,
// else a repo in its usual folders) or clones the origin, and the checkout joins its projects, so the next launch finds
// it at once. A folder that isn't a repo with an origin can't be set up there, as v1 said.
import { defineCommand } from '@wisp/client';

type Run = <A, R>(cmd: ReturnType<typeof defineCommand<A, R>>, args: A) => Promise<R>;

const origin = defineCommand<{ peer: string; path: string }, { origin: string; root: string }>({
  id: 'git.origin',
  owner: (a) => a.peer as never,
  wire: (a) => ({ path: a.path }),
  optimistic: 'none',
  pending: 'Run on',
});
const checkout = defineCommand<{ peer: string; url: string; known: string[] }, { dir: string; existed: boolean }>({
  id: 'git.checkout',
  owner: (a) => a.peer as never,
  wire: (a) => ({ url: a.url, known: a.known }),
  optimistic: 'none',
  pending: 'Run on',
});
const projectsOf = defineCommand<{ peer: string }, { projects?: { name?: string; path?: string }[] }>({
  id: 'resources.export',
  owner: (a) => a.peer as never,
  wire: () => ({ kinds: ['project'] }),
  optimistic: 'none',
  pending: 'Run on',
});
const addProject = defineCommand<{ peer: string; name: string; path: string }>({
  id: 'resources.apply',
  owner: (a) => a.peer as never,
  wire: (a) => ({ resources: [{ kind: 'project', name: a.name, spec: { path: a.path } }] }),
  optimistic: 'none',
  pending: 'Run on',
});

export class NoOrigin extends Error {}

/** `dir` under `root`, put under `there` (both computers' separators allowed). */
export function moved(dir: string, root: string, there: string): string {
  const rest = dir.slice(root.length).split(/[\\/]/).filter(Boolean);
  return rest.length ? `${there.replace(/[\\/]+$/, '')}/${rest.join('/')}` : there;
}

/**
 * The folder to run in on `peer` for `cwd` here. Same computer: as it is. Elsewhere: that computer's checkout of the
 * repo, the same subfolder in it. `say(name, where)` words the refusal for a folder with no origin.
 */
export async function placeOn(o: {
  readonly cwd: string;
  readonly peer: string;
  readonly home: string;
  readonly name: string;
  readonly where: string;
  readonly run: Run;
  readonly say: (name: string, where: string) => string;
}): Promise<string> {
  if (!o.cwd || o.peer === o.home) return o.cwd;
  const here = await o.run(origin, { peer: o.home, path: o.cwd });
  if (!here.origin) throw new NoOrigin(o.say(o.name, o.where));
  const known = ((await o.run(projectsOf, { peer: o.peer }).catch(() => ({ projects: [] }))).projects ?? []).map((p) => p.path ?? '').filter(Boolean);
  const got = await o.run(checkout, { peer: o.peer, url: here.origin, known });
  // a checkout it didn't know as a project joins its projects (v1 store.addProject on that machine)
  if (!known.includes(got.dir)) await o.run(addProject, { peer: o.peer, name: o.name, path: got.dir }).catch(() => undefined);
  return moved(o.cwd, here.root || o.cwd, got.dir);
}
