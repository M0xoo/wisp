// Settings → Phone's pure helpers (lib.ts): the fields each channel shows here, the change a save shows at once,
// the setup steps and where each stands.
import { expect, test } from 'vitest';
import { fieldsFor, linkLine, marked, missingOf, optimistic, stepsOf, testNote, toneOf, withRow } from '../src/lib.ts';
import type { ChannelSetup } from '../src/types.ts';

const row = (transport: string, more: Partial<ChannelSetup> = {}): ChannelSetup => ({
  transport,
  installed: true,
  enabled: false,
  state: 'off',
  saved: [],
  settings: {},
  missing: [],
  linked: 0,
  ...more,
});

test('a_channel_shows_the_fields_this_computer_takes_slacks_app_token_here_its_signing_secret_on_a_cloud_computer', () => {
  expect(fieldsFor(row('slack'), false).map((f) => f.key)).toEqual(['appToken', 'botToken']);
  expect(fieldsFor(row('slack'), true).map((f) => f.key)).toEqual(['signingSecret', 'botToken']);
  expect(fieldsFor(row('discord'), false).map((f) => f.key)).toEqual(['token']);
  expect(fieldsFor(row('discord'), true).map((f) => f.key)).toEqual(['token', 'publicKey']);
  // v1: Start tasks from Telegram shows once a chat is linked
  expect(fieldsFor(row('telegram'), false).map((f) => f.key)).toEqual(['token']);
  expect(fieldsFor(row('telegram', { linked: 1 }), false).map((f) => f.key)).toEqual(['token', 'allowStart']);
  expect(fieldsFor(row('irc'), false)).toEqual([]);
  expect(fieldsFor(row('ntfy'), false).filter((f) => f.secret).map((f) => f.key)).toEqual(['token']);
});

test('what_a_channel_still_needs_matches_the_hubs_rules', () => {
  expect(missingOf('ntfy', false, [], {})).toEqual(['topic']);
  expect(missingOf('ntfy', false, [], { topic: 'wisp-1' })).toEqual([]);
  expect(missingOf('slack', false, ['botToken'], {})).toEqual(['appToken']);
  expect(missingOf('slack', true, ['appToken'], {})).toEqual(['signingSecret', 'botToken']);
  expect(missingOf('discord', true, ['token'], {})).toEqual(['publicKey']);
  expect(missingOf('email', false, [], {})).toEqual(['cloud']);
  expect(missingOf('email', true, [], { sender: ' ' })).toEqual(['sender']);
  expect(missingOf('github', false, [], {})).toEqual([]);
});

test('a_save_shows_at_once_switched_on_saved_and_checking_never_with_the_secret_itself', () => {
  const before = row('telegram', { missing: ['token'] });
  const on = optimistic(before, { transport: 'telegram', enabled: true, secrets: { token: '123456:ABCDEFGHIJ' } }, false);
  expect(on).toMatchObject({ enabled: true, saved: ['token'], missing: [], state: 'checking' });
  expect(JSON.stringify(on)).not.toContain('ABCDEFGHIJ');
  // switched on with nothing saved: Not set up
  expect(optimistic(before, { transport: 'telegram', enabled: true }, false)).toMatchObject({ state: 'incomplete', missing: ['token'] });
  // an empty secret removes it
  const gone = optimistic(row('telegram', { enabled: true, saved: ['token'], state: 'connected' }), { transport: 'telegram', secrets: { token: '' } }, false);
  expect(gone).toMatchObject({ saved: [], missing: ['token'], state: 'incomplete' });
  // switched off: Off, and the last error goes with it
  expect(optimistic(row('ntfy', { enabled: true, state: 'failing', error: 'ntfy answered 500', settings: { topic: 'wisp-1' } }), { transport: 'ntfy', enabled: false }, false)).not.toHaveProperty('error');
  // a switch flipped back on that changes nothing else waits for the hub to say how it went
  expect(optimistic(row('ntfy', { settings: { topic: 'wisp-1' } }), { transport: 'ntfy', enabled: true }, false).state).toBe('checking');
  // a setting changes in place
  expect(optimistic(row('ntfy', { enabled: true, state: 'connected', settings: { topic: 'a' } }), { transport: 'ntfy', settings: { topic: 'b' } }, false)).toMatchObject({ settings: { topic: 'b' }, state: 'checking' });
});

test('steps_tick_as_they_are_done_and_the_first_open_one_is_current', () => {
  const tg = (more: Partial<ChannelSetup>) => marked(stepsOf(row('telegram', more), false, false)).map((s) => s.status);
  expect(tg({})).toEqual(['current', 'pending', 'pending']);
  expect(tg({ saved: ['token'] })).toEqual(['done', 'current', 'pending']);
  expect(tg({ saved: ['token'], enabled: true })).toEqual(['done', 'done', 'current']);
  expect(tg({ saved: ['token'], enabled: true, linked: 1 })).toEqual(['done', 'done', 'done']);
  const ntfy = marked(stepsOf(row('ntfy', { enabled: true, settings: { topic: 'wisp-1' } }), false, true)).map((s) => s.status);
  expect(ntfy).toEqual(['done', 'done', 'done']);
  expect(stepsOf(row('slack'), true, false)[1]?.title).toBe('channels.step.slack.paste.cloud');
  for (const t of ['ntfy', 'telegram', 'slack', 'discord', 'github', 'email']) expect(stepsOf(row(t), false, false).length).toBeGreaterThan(1);
});

test('the_link_line_is_what_the_person_sends_the_bot', () => {
  expect(linkLine(row('telegram', { linkCode: '123456' }))).toBe('/link 123456');
  expect(linkLine(row('slack', { linkCode: '654321' }))).toBe('link 654321');
  expect(linkLine(row('discord'))).toBeUndefined();
});

test('states_and_tests_read_as_v1s_marks', () => {
  expect(toneOf('connected')).toBe('good');
  expect(toneOf('failing')).toBe('bad');
  expect(toneOf('incomplete')).toBe('warn');
  expect(toneOf('off')).toBe('neutral');
  expect(testNote({ channel: 'ntfy', outcome: 'failed', error: 'ntfy answered 500' })).toEqual({ tone: 'bad', key: 'channels.test.failed', error: 'ntfy answered 500' });
  expect(testNote({ channel: 'slack', outcome: 'unprompted' }).tone).toBe('muted');
  expect(testNote({ channel: 'ntfy', outcome: 'sent' }).tone).toBe('good');
});

test('one_rows_answer_replaces_only_that_row', () => {
  const s = { cloud: false, channels: [row('ntfy'), row('telegram')] };
  const next = withRow(s, row('telegram', { enabled: true }));
  expect(next.channels[0]).toBe(s.channels[0]);
  expect(next.channels[1]?.enabled).toBe(true);
});
