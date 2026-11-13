// Machines' cards, found hosts, Let me in and the asks (view.ts; v1 machines.js card, found, trouble, act).
import { expect, test } from 'vitest';
import en from '../src/i18n/en.json' with { type: 'json' };
import { barOf, cloudOf, foundOf, kindOf, menuOf, nameFor, offersLetIn, portOf, primaryOf, removeAsk, stepsOf, stopAsk, troubleTitle, whereOf, type PeerLike } from '../src/view.ts';

const cat = en as Record<string, string>;
const t = (k: string, v?: Readonly<Record<string, string | number>>): string => {
  const n = v?.['count'];
  const key = typeof n === 'number' && cat[`${k}.${n === 1 ? 'one' : 'other'}`] ? `${k}.${n === 1 ? 'one' : 'other'}` : k;
  return (cat[key] ?? key).replace(/\{(\w+)\}/g, (_, w: string) => String(v?.[w] ?? ''));
};
const ssh: PeerLike = { id: 'a1', name: 'devbox', transport: 'ssh', address: 'me@devbox.local', port: 4477 };
const cloud: PeerLike = { id: 'c1', name: 'wisp Cloud', transport: 'grid', address: 'me.grid.trywisp.dev', port: 443, data: { grid: 'https://grid.trywisp.dev' } };
const mine: PeerLike = { ...cloud, id: 'g1', name: 'Studio', transport: 'grid-tunnel', data: { grid: 'https://grid.trywisp.dev', computer: 'k1' } };

test('machines_card_says_what_each_kind_is_and_where_it_is', () => {
  expect([kindOf(ssh), kindOf(cloud), kindOf(mine)]).toEqual(['ssh', 'cloud', 'grid']);
  expect(whereOf(ssh, t)).toBe('me@devbox.local');
  expect(whereOf({ ...ssh, port: 4500 }, t)).toBe('me@devbox.local · port 4500');
  expect(whereOf(cloud, t)).toBe('on grid.trywisp.dev');
  expect(whereOf(mine, t)).toBe('through grid.trywisp.dev');
});

test('machines_card_has_one_button_for_its_state', () => {
  expect(primaryOf(ssh, 'off')).toMatchObject({ act: 'connect', label: 'machines.connect', primary: true });
  expect(primaryOf(ssh, 'error')).toMatchObject({ act: 'connect', label: 'machines.tryAgain' });
  expect(primaryOf(ssh, 'connecting')).toMatchObject({ act: 'disconnect', label: 'machines.cancel', primary: false });
  expect(primaryOf(ssh, 'online')).toMatchObject({ act: 'disconnect', label: 'machines.disconnect' });
  expect(primaryOf(cloud, 'asleep').label).toBe('machines.wake');
  expect(primaryOf(mine, 'asleep').label).toBe('machines.checkAgain');
});

test('machines_menu_offers_edit_for_ssh_and_restart_only_while_online_and_not_someone_elses', () => {
  expect(menuOf(ssh, 'off')).toEqual(['edit', 'remove']);
  expect(menuOf(ssh, 'online')).toEqual(['edit', 'restart', 'stop', 'remove']);
  expect(menuOf(cloud, 'online')).toEqual(['restart', 'stop', 'remove']);
  expect(menuOf(mine, 'online')).toEqual(['remove']);
  expect(removeAsk(mine, t).ok).toBe('Remove from grid');
  expect(removeAsk(cloud, t)).toMatchObject({ title: 'Sign out of grid.trywisp.dev here?', ok: 'Sign out of the grid' });
});

test('machines_found_hosts_leave_out_added_ones_and_fill_the_name', () => {
  const hosts = [
    { target: 'me@devbox.local', name: 'devbox', source: 'ssh-config', detail: '' },
    { target: 'me@studio', name: 'studio', source: 'tailscale', detail: '100.64.0.2', online: true },
  ];
  expect(foundOf(hosts, [ssh]).map((h) => h.name)).toEqual(['studio']);
  expect(foundOf(Array.from({ length: 20 }, (_, i) => ({ ...hosts[1]!, target: `h${i}` })), []).length).toBe(12);
  expect(nameFor('me@studio', hosts)).toBe('studio');
  expect(nameFor('  bob@10.0.0.9 ', [])).toBe('10.0.0.9');
  expect(nameFor('', [])).toBe('devbox');
  expect([portOf('4500'), portOf(''), portOf('70000'), portOf('4.5')]).toEqual([4500, 4477, 4477, 4477]);
});

test('machines_let_me_in_shows_for_a_refused_key_not_while_retrying', () => {
  const refused = { state: 'error', error: 'Permission denied (publickey)', hint: { title: 'This computer isn’t allowed in yet', text: '', letIn: true } };
  expect(offersLetIn(refused)).toBe(true);
  expect(offersLetIn({ ...refused, state: 'reconnecting' })).toBe(false);
  expect(offersLetIn({ ...refused, hint: { text: '' } })).toBe(false);
  expect(troubleTitle(refused, t)).toBe('This computer isn’t allowed in yet');
  expect(troubleTitle({ state: 'reconnecting', error: '', attempt: 3 }, t)).toBe('Connection lost. Trying again (attempt 3)…');
});

test('machines_connection_steps_map_to_the_kit', () => {
  const s = stepsOf([
    { id: 'ssh', label: 'Connect over SSH', status: 'done', detail: 'Linux box' },
    { id: 'install', label: 'Install wisp there', status: 'run', detail: '' },
    { id: 'wisp', label: 'Start wisp there', status: 'fail', detail: '' },
    { id: 'tunnel', label: 'Open the tunnel', status: 'pending', detail: '' },
  ]);
  expect(s.map((x) => x.status)).toEqual(['done', 'current', 'failed', 'pending']);
  expect(s[0]).toEqual({ title: 'Connect over SSH', status: 'done', detail: 'Linux box' });
  expect('detail' in s[1]!).toBe(false);
});

test('machines_update_and_restart_ask_only_when_agents_work_there_and_stop_always_asks', () => {
  expect(stopAsk({ name: 'devbox', working: 0, verb: 'update', version: '2.1.0' }, t)).toBeNull();
  expect(stopAsk({ name: 'devbox', working: 2, verb: 'update', version: '2.1.0' }, t)).toEqual({
    title: '2 agents are working on devbox',
    body: 'Updating wisp there to 2.1.0 stops them.',
    ok: 'Update and stop agents',
    danger: true,
  });
  expect(stopAsk({ name: 'devbox', working: 0, verb: 'stop' }, t)).toMatchObject({ title: 'Stop wisp on devbox?', danger: false });
  expect(stopAsk({ name: 'devbox', working: 1, verb: 'stop' }, t)?.body).toBe('1 working agent stops too. Its tasks stay there for next time.');
});

test('machines_top_bar_counts_online_and_flags_trouble', () => {
  expect(barOf([ssh, cloud], [{ id: 'a1', state: 'online', error: '' }, { id: 'c1', state: 'asleep', error: '' }])).toEqual({ count: 2, online: 1, trouble: false });
  expect(barOf([ssh], [{ id: 'a1', state: 'reconnecting', error: '' }]).trouble).toBe(true);
  expect(barOf([], [])).toEqual({ count: 0, online: 0, trouble: false });
});

test('cloud_pane_lists_the_grids_boxes_with_open_and_says_wake_first_once', () => {
  const sbx: PeerLike = { ...cloud, id: 's1', name: 'sbx', data: { grid: 'https://grid.trywisp.dev', sandbox: 'x' } };
  const two: PeerLike = { ...cloud, id: 'c2', name: 'wisp Cloud (bea)', data: { grid: 'https://grid.trywisp.dev/', handle: 'bea' } };
  const named: PeerLike = { ...cloud, data: { grid: 'https://grid.trywisp.dev', handle: 'mo' } };
  const out = cloudOf([ssh, mine, sbx, named, two], [
    { id: 'c1', state: 'asleep', error: '' },
    { id: 'c2', state: 'asleep', error: '' },
  ]);
  expect(out.map((x) => x.m.id)).toEqual(['c1', 'c2']);
  expect(out.map((x) => x.who)).toEqual(['mo · grid.trywisp.dev', 'grid.trywisp.dev']);
  expect(out.map((x) => x.open)).toEqual(['https://grid.trywisp.dev/go', 'https://grid.trywisp.dev/go']);
  expect(out.map((x) => x.wakeLine)).toEqual([true, false]);
  const err = cloudOf([named], [{ id: 'c1', state: 'error', error: 'raw', hint: { title: 'The grid refused', text: 'Sign in again' } }]);
  expect(err[0]?.error).toBe('The grid refused · Sign in again');
});
