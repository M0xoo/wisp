// Run on another computer (src/frame/run-on.ts, v1 services/places.js placeBody/dirAt/ensureAt).
import { expect, test } from 'vitest';
import { moved, NoOrigin, placeOn } from '../src/frame/run-on.ts';

const say = (name: string, where: string): string => `${name} has no git remote (origin) to clone from, so wisp can’t set it up on ${where}.`;

function fake(o: { origin?: string; projects?: string[]; dir?: string; existed?: boolean }) {
  const calls: [string, string, unknown][] = [];
  const run = (async (cmd: { id: string }, args: { peer: string }) => {
    calls.push([cmd.id, args.peer, args]);
    if (cmd.id === 'git.origin') return { origin: o.origin ?? '', root: o.origin ? '/me/code/web' : '' };
    if (cmd.id === 'resources.export') return { projects: (o.projects ?? []).map((path) => ({ name: 'web', path })) };
    if (cmd.id === 'git.checkout') return { dir: o.dir ?? '/studio/code/web', existed: o.existed ?? false };
    return {};
  }) as never;
  return { run, calls };
}

test('on another computer a task runs in that computer s checkout of the same repo, the same subfolder_v1_run_on_place', async () => {
  // found among its projects: used as it is, nothing added
  const f = fake({ origin: 'git@github.com:me/web.git', projects: ['/studio/code/web'], existed: true });
  expect(await placeOn({ cwd: '/me/code/web/apps/site', peer: 'studio', home: 'laptop', name: 'web', where: 'Studio', run: f.run, say })).toBe('/studio/code/web/apps/site');
  expect(f.calls.map((c) => `${c[0]}@${c[1]}`)).toEqual(['git.origin@laptop', 'resources.export@studio', 'git.checkout@studio']);
  expect(f.calls[2]?.[2]).toMatchObject({ url: 'git@github.com:me/web.git', known: ['/studio/code/web'] });
  // cloned there (or found outside its projects): it joins that computer's projects, so the next launch finds it
  const g = fake({ origin: 'git@github.com:me/web.git', dir: '/studio/code/web-2' });
  expect(await placeOn({ cwd: '/me/code/web', peer: 'studio', home: 'laptop', name: 'web', where: 'Studio', run: g.run, say })).toBe('/studio/code/web-2');
  expect(g.calls.at(-1)).toEqual(['resources.apply', 'studio', { peer: 'studio', name: 'web', path: '/studio/code/web-2' }]);
});

test('here stays as it is; a folder with no origin can t be set up there, as v1 said_v1_run_on_no_origin', async () => {
  const h = fake({});
  expect(await placeOn({ cwd: '/me/code/web', peer: 'laptop', home: 'laptop', name: 'web', where: 'Studio', run: h.run, say })).toBe('/me/code/web');
  expect(h.calls).toEqual([]);
  await expect(placeOn({ cwd: '/me/notes', peer: 'studio', home: 'laptop', name: 'notes', where: 'Studio', run: fake({}).run, say })).rejects.toThrow(NoOrigin);
  expect(moved('C:\\me\\web\\src', 'C:\\me\\web', '/studio/web')).toBe('/studio/web/src');
});
