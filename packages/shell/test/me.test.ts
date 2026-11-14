// You in the avatar's menu (F-task-25, v1 split.js meInfo/paintMe): the grid account from wisp.machines' rows.
import { expect, test } from 'vitest';
import { meOf } from '../src/frame/me.ts';

test('the_avatar_menu_names_you_on_the_grid_or_says_not_connected_v1_me_menu', () => {
  // never signed in: no grid peer
  expect(meOf([], [])).toEqual({ who: '', sub: '', state: 'out' });
  // another of your computers and a sandbox aren't you
  const other = { id: 'm2', body: { transport: 'grid-tunnel', data: { computer: 'studio', grid: 'grid.trywisp.dev' } } };
  const box = { id: 'm3', body: { transport: 'grid', data: { sandbox: true, grid: 'grid.trywisp.dev' } } };
  expect(meOf([other, box], []).state).toBe('out');
  // you: name, handle · host, the initial, the account page; ringed while online
  const you = { id: 'm1', body: { transport: 'grid', data: { grid: 'https://grid.trywisp.dev', user: { handle: 'ada', name: 'Ada L', avatar: 'https://x/a.png' } } } };
  const on = meOf([other, you], [{ id: 'm1', body: { id: 'm1', state: 'online' } }]);
  expect(on).toMatchObject({ who: 'Ada L', sub: 'ada · grid.trywisp.dev', state: 'on', initial: 'A', avatar: 'https://x/a.png', href: 'https://grid.trywisp.dev/account' });
  // signed in, not reachable now: off; a handle alone shows the host under it
  const bare = { id: 'm1', body: { transport: 'grid', data: { url: 'grid.trywisp.dev', handle: 'bo' } } };
  expect(meOf([bare], [{ id: 'm1', body: { id: 'm1', state: 'connecting' } }])).toMatchObject({ who: 'bo', sub: 'grid.trywisp.dev', state: 'off', initial: 'B' });
});
