// The mock's second computer (dev/seed.ts `computers`, dev/mock-commands.ts): Studio listed here, a project with an
// origin here, and over there the checkout v1 places.js found or cloned, joining Studio's projects.
import { expect, test } from 'vitest';
import { COMMANDS, type CommandCtx } from '../dev/mock-commands.ts';
import { createMockPeer } from '../dev/mock-peer.ts';
import { COMPUTERS_PROJECT, STUDIO } from '../dev/seed.ts';

const ctxOf = (peer: ReturnType<typeof createMockPeer>, name: string): CommandCtx =>
  ({ peer: name, now: () => 1, row: () => undefined, rows: (t: string) => peer.rows(t as never), stream: () => undefined, later: () => undefined }) as never;

test('two computers: Studio is listed here, this computer s project has an origin, Studio sets up its checkout_v1_run_on_mock', () => {
  const home = createMockPeer({ peer: 'local', computers: true });
  const studio = createMockPeer({ peer: STUDIO, firstRun: true });
  expect(home.rows('machines' as never).some((r) => r.e === 'machines_peer' && (r.v as { body?: { peer?: string } }).body?.peer === STUDIO)).toBe(true);
  expect(home.rows('config' as never).some((r) => r.e === 'project')).toBe(true);
  const origin = COMMANDS['git.origin']?.({ path: `${COMPUTERS_PROJECT.path}/web` }, ctxOf(home, 'local'));
  expect(origin?.result).toEqual({ origin: 'git@github.com:WispAgents/wisp.git', root: COMPUTERS_PROJECT.path });
  expect(COMMANDS['git.origin']?.({ path: '/tmp/notes' }, ctxOf(home, 'local'))?.result).toEqual({ origin: '', root: '' });
  // Studio has no projects yet: a fresh checkout, then it's one of Studio's projects
  expect(COMMANDS['resources.export']?.({}, ctxOf(studio, STUDIO))?.result).toEqual({ projects: [] });
  const got = COMMANDS['git.checkout']?.({ url: 'git@github.com:WispAgents/wisp.git', known: [] }, ctxOf(studio, STUDIO))?.result;
  expect(got).toEqual({ dir: `/Users/${STUDIO}/code/wisp`, existed: false });
  const added = COMMANDS['resources.apply']?.({ resources: [{ kind: 'project', name: 'wisp', spec: { path: `/Users/${STUDIO}/code/wisp` } }] }, ctxOf(studio, STUDIO));
  expect(added?.ops[0]).toMatchObject({ topic: 'config', e: 'project', v: { name: 'wisp', path: `/Users/${STUDIO}/code/wisp` } });
  // known next time: used as it is
  expect(COMMANDS['git.checkout']?.({ url: 'x', known: ['/Users/studio/code/wisp'] }, ctxOf(studio, STUDIO))?.result).toEqual({ dir: '/Users/studio/code/wisp', existed: true });
});
