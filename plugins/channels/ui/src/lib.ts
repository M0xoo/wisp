// Settings → Phone, pure (v1 web/js/features/phone.js): each channel's fields, its setup steps and where it stands,
// and the change a save shows at once. The Rust rules (plugins/channels/core/src/setup.rs) decide; these mirror them
// only so the pane can answer in one frame.

import type { Key } from './i18n.ts';
import { NOTIFY, type ChannelSetup, type NotifyEvent, type SetupArgs, type SetupState, type Tested, type Transport } from './types.ts';

export interface FieldDef {
  readonly key: string;
  readonly secret: boolean;
  readonly kind: 'text' | 'bool';
  readonly label: Key;
  readonly placeholder?: Key;
  /** only on a cloud computer (true) or only on one that isn't (false) */
  readonly cloud?: boolean;
}

const secret = (key: string, label: Key, placeholder: Key, cloud?: boolean): FieldDef => ({ key, secret: true, kind: 'text', label, placeholder, ...(cloud !== undefined && { cloud }) });
const text = (key: string, label: Key, placeholder: Key): FieldDef => ({ key, secret: false, kind: 'text', label, placeholder });
const bool = (key: string, label: Key): FieldDef => ({ key, secret: false, kind: 'bool', label });

/** v1's fields per channel, in its order. */
export const FIELDS: Readonly<Record<Transport, readonly FieldDef[]>> = {
  ntfy: [text('topic', 'channels.field.topic', 'channels.field.topic.ph'), text('server', 'channels.field.server', 'channels.field.server.ph'), secret('token', 'channels.field.access', 'channels.field.access.ph')],
  telegram: [secret('token', 'channels.field.botToken', 'channels.field.telegram.ph'), bool('allowStart', 'channels.field.allowStart')],
  slack: [
    secret('appToken', 'channels.field.appToken', 'channels.field.appToken.ph', false),
    secret('signingSecret', 'channels.field.signingSecret', 'channels.field.signingSecret.ph', true),
    secret('botToken', 'channels.field.botToken', 'channels.field.slackBot.ph'),
  ],
  discord: [secret('token', 'channels.field.botToken', 'channels.field.discordBot.ph'), secret('publicKey', 'channels.field.publicKey', 'channels.field.publicKey.ph', true)],
  github: [bool('publicReports', 'channels.field.publicReports')],
  email: [text('sender', 'channels.field.sender', 'channels.field.sender.ph')],
};

export const isTransport = (t: string): t is Transport => Object.hasOwn(FIELDS, t);

/** The fields shown here: a cloud-only field on a cloud computer, a computer-only one elsewhere. Telegram's Start
 * tasks shows once a chat is linked (v1). */
export function fieldsFor(row: ChannelSetup, cloud: boolean): readonly FieldDef[] {
  if (!isTransport(row.transport)) return [];
  return FIELDS[row.transport].filter((f) => (f.cloud === undefined || f.cloud === cloud) && !(f.key === 'allowStart' && row.linked === 0));
}

/** What a channel still needs (core setup.rs `missing`), for the change shown before the answer. */
export function missingOf(transport: string, cloud: boolean, saved: readonly string[], settings: Readonly<Record<string, string | boolean>>): string[] {
  const has = (f: string): boolean => saved.includes(f);
  const filled = (f: string): boolean => typeof settings[f] === 'string' && (settings[f] as string).trim() !== '';
  switch (transport) {
    case 'ntfy':
      return filled('topic') ? [] : ['topic'];
    case 'telegram':
      return has('token') ? [] : ['token'];
    case 'slack':
      return [cloud ? 'signingSecret' : 'appToken', 'botToken'].filter((f) => !has(f));
    case 'discord':
      return ['token', ...(cloud ? ['publicKey'] : [])].filter((f) => !has(f));
    case 'email':
      return !cloud ? ['cloud'] : filled('sender') ? [] : ['sender'];
    default:
      return [];
  }
}

/** The row as a save leaves it, before the hub answers: switched, fields saved or removed, and checking again. */
export function optimistic(row: ChannelSetup, a: SetupArgs, cloud: boolean): ChannelSetup {
  const enabled = a.enabled ?? row.enabled;
  const secrets = Object.entries(a.secrets ?? {});
  const saved = [...row.saved.filter((f) => !secrets.some(([k]) => k === f)), ...secrets.filter(([, v]) => v.trim() !== '').map(([k]) => k)];
  const settings = { ...row.settings, ...a.settings };
  const missing = missingOf(row.transport, cloud, saved, settings);
  const changed = secrets.length > 0 || Object.keys(a.settings ?? {}).length > 0;
  const state: SetupState = !enabled ? 'off' : missing.length > 0 ? 'incomplete' : changed || !row.enabled ? 'checking' : row.state;
  const { error: _e, linkCode: _c, who: _w, ...rest } = row;
  // Send me: first switched on with nothing chosen, the hub sends questions and finished tasks (v1's default)
  const notify = a.notify ?? (enabled && !row.enabled && row.notify.length === 0 && notifies(row.transport) ? NOTIFY : row.notify);
  // unlinked: nobody counts, and the new code comes with the answer
  const linked = a.unlink === true ? 0 : row.linked;
  const keep = a.unlink !== true;
  return {
    ...rest,
    enabled,
    saved,
    settings,
    missing,
    state: a.unlink === true && state === 'connected' ? 'linking' : state,
    notify,
    linked,
    ...(state === 'failing' && row.error !== undefined && { error: row.error }),
    ...(keep && row.linkCode !== undefined && { linkCode: row.linkCode }),
    ...((keep || row.transport === 'email') && row.who !== undefined && { who: row.who }),
  };
}

/** Send me is for the channels that can send unasked (core setup.rs `notifies`). */
export const notifies = (transport: string): boolean => transport === 'ntfy' || transport === 'telegram';

/** Send me with `e` ticked or not, in Send me's order. */
export function toggled(now: readonly NotifyEvent[], e: NotifyEvent, on: boolean): NotifyEvent[] {
  return NOTIFY.filter((x) => (x === e ? on : now.includes(x)));
}

/** A channel that links people with a code, and has someone linked: Unlink is offered. */
export const unlinkable = (row: ChannelSetup): boolean => ['telegram', 'slack', 'discord'].includes(row.transport) && row.linked > 0;

/** What the pane shows for a channel: the topic's row (the hub's word, newest) with what only channels.status and the
 * commands answer (the link code, the endpoint URL, email's address) from the pane's own copy. A save on its way
 * (`busy`) keeps the pane's copy: it's newer than any row. */
export function shown(local: ChannelSetup | undefined, live: ChannelSetup | undefined, busy: boolean): ChannelSetup | undefined {
  if (!live || busy) return local;
  if (!local) return live;
  const code = live.enabled && live.linked === 0 ? local.linkCode : undefined;
  const who = live.transport === 'email' ? local.who : live.who;
  const endpoint = local.endpoint;
  // ntfy's topic is a read capability: not on the row, so the pane's own copy says it
  const topic = live.transport === 'ntfy' && live.settings['topic'] === undefined ? local.settings['topic'] : undefined;
  const settings = topic === undefined ? live.settings : { ...live.settings, topic };
  const { linkCode: _c, who: _w, endpoint: _e, ...rest } = live;
  return { ...rest, settings, ...(code !== undefined && { linkCode: code }), ...(who !== undefined && { who }), ...(endpoint !== undefined && { endpoint }) };
}

/** What a row looked like when a save was answered: until the topic brings another, that row is older than the answer. */
export const pinOf = (live: ChannelSetup | undefined): string => JSON.stringify(live ?? null);

/** The topic's row is newer than the answer pinned at `pin` (none pinned: it is). */
export const newer = (pin: string | undefined, live: ChannelSetup | undefined): boolean => pin === undefined || pinOf(live) !== pin;

/** A row's change that can change what only channels.status says (a new link code, an address, the endpoint): the
 * pane reads it again then, once, never on a timer. */
export function readAgain(was: ChannelSetup | undefined, now: ChannelSetup): boolean {
  if (!was) return false;
  return was.enabled !== now.enabled || was.linked !== now.linked || (was.state !== now.state && (now.state === 'linking' || now.state === 'connected'));
}

/** Slack's manifest as it's pasted at api.slack.com (From a manifest → JSON). */
export const manifestText = (m: unknown): string => JSON.stringify(m, null, 2);

/** Discord's invite link out of channels.extra's answer. */
export function inviteOf(v: unknown): string | undefined {
  const url = typeof v === 'object' && v !== null ? (v as { url?: unknown }).url : undefined;
  return typeof url === 'string' && url.startsWith('https://') ? url : undefined;
}

/** The pill's tone (v1 .ph-ok / .ph-bad / .ph-wait). */
export function toneOf(s: SetupState): 'good' | 'bad' | 'warn' | 'neutral' {
  return s === 'connected' ? 'good' : s === 'failing' ? 'bad' : s === 'incomplete' || s === 'linking' ? 'warn' : 'neutral';
}

export const STATE_KEY: Readonly<Record<SetupState, Key>> = {
  off: 'channels.state.off',
  incomplete: 'channels.state.incomplete',
  checking: 'channels.state.checking',
  linking: 'channels.state.linking',
  connected: 'channels.state.connected',
  failing: 'channels.state.failing',
};

export type StepStatus = 'done' | 'current' | 'pending';

export interface StepDef {
  readonly title: Key;
  readonly detail?: Key;
  readonly done: boolean;
}

/** The first step not done is the current one; the rest wait. */
export function marked(steps: readonly StepDef[]): (StepDef & { status: StepStatus })[] {
  const first = steps.findIndex((s) => !s.done);
  return steps.map((s, i) => ({ ...s, status: s.done ? 'done' : i === first ? 'current' : 'pending' }));
}

/** v1's setup steps per channel, each ticked once it's so. `sent`: a test went out from this pane. */
export function stepsOf(row: ChannelSetup, cloud: boolean, sent: boolean): StepDef[] {
  const has = (f: string): boolean => row.saved.includes(f);
  const ready = row.missing.length === 0;
  const working = row.state === 'connected' || row.state === 'linking';
  switch (row.transport) {
    case 'ntfy':
      return [
        { title: 'channels.step.ntfy.on', done: row.enabled && ready },
        { title: 'channels.step.ntfy.app', detail: 'channels.step.ntfy.app.detail', done: sent },
        { title: 'channels.step.ntfy.test', done: sent },
      ];
    case 'telegram':
      return [
        { title: 'channels.step.telegram.bot', done: has('token') },
        { title: 'channels.step.on', done: row.enabled },
        { title: 'channels.step.telegram.link', detail: 'channels.step.telegram.link.detail', done: row.linked > 0 },
      ];
    case 'slack':
      return [
        { title: 'channels.step.slack.app', detail: 'channels.step.slack.app.detail', done: row.saved.length > 0 },
        { title: cloud ? 'channels.step.slack.paste.cloud' : 'channels.step.slack.paste', detail: cloud ? 'channels.step.slack.where.cloud' : 'channels.step.slack.where', done: ready },
        { title: 'channels.step.on', done: row.enabled },
        { title: 'channels.step.link', detail: 'channels.step.link.detail', done: row.linked > 0 },
      ];
    case 'discord':
      return [
        { title: 'channels.step.discord.app', detail: 'channels.step.discord.app.detail', done: has('token') },
        { title: cloud ? 'channels.step.discord.paste.cloud' : 'channels.step.discord.paste', detail: cloud ? 'channels.step.discord.where.cloud' : 'channels.step.discord.where', done: ready },
        { title: 'channels.step.on', done: row.enabled },
        { title: 'channels.step.link', detail: 'channels.step.link.detail', done: row.linked > 0 },
      ];
    case 'github':
      return [
        { title: 'channels.step.github.gh', detail: 'channels.step.github.gh.detail', done: working },
        { title: 'channels.step.on', done: row.enabled },
        { title: 'channels.step.github.comment', detail: 'channels.step.github.comment.detail', done: false },
      ];
    case 'email':
      return [
        { title: 'channels.step.email.sender', detail: 'channels.step.email.sender.detail', done: has('sender') || (typeof row.settings['sender'] === 'string' && row.settings['sender'] !== '') },
        { title: 'channels.step.on', done: row.enabled },
        { title: 'channels.step.email.mail', detail: 'channels.step.email.mail.detail', done: false },
      ];
    default:
      return [];
  }
}

/** The link line: what the person sends the bot (Telegram `/link 123456`, Slack and Discord `link 123456`). */
export function linkLine(row: ChannelSetup): string | undefined {
  if (row.linkCode === undefined || row.linkCode === '') return undefined;
  return row.transport === 'telegram' ? `/link ${row.linkCode}` : `link ${row.linkCode}`;
}

/** What a test said, for the line under the channel. */
export function testNote(t: Tested): { tone: 'good' | 'bad' | 'muted'; key: Key; error?: string } {
  if (t.outcome === 'sent') return { tone: 'good', key: 'channels.test.sent' };
  if (t.outcome === 'unprompted') return { tone: 'muted', key: 'channels.test.unprompted' };
  return { tone: 'bad', key: 'channels.test.failed', ...(t.error !== undefined && { error: t.error }) };
}

/** The status list with one row replaced (by transport), the others untouched. */
export function withRow<T extends { readonly channels: readonly ChannelSetup[] }>(s: T, row: ChannelSetup): T {
  return { ...s, channels: s.channels.map((c) => (c.transport === row.transport ? row : c)) };
}
