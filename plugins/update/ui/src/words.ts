// What the Updates rows say: pure, so each v1 sentence has a table test.

import { t } from './i18n.ts';
import { CHANNELS, type Channel, type UpdateState } from './types.ts';

const HINTS: Readonly<Record<Channel, () => string>> = {
  stable: () => t('update.hint.stable'),
  beta: () => t('update.hint.beta'),
  nightly: () => t('update.hint.nightly'),
};

const LABELS: Readonly<Record<Channel, () => string>> = {
  stable: () => t('update.channel.stable'),
  beta: () => t('update.channel.beta'),
  nightly: () => t('update.channel.nightly'),
};

export const isChannel = (v: string): v is Channel => (CHANNELS as readonly string[]).includes(v);

export const channelItems = (): { value: Channel; label: string }[] => CHANNELS.map((c) => ({ value: c, label: LABELS[c]() }));

/** Why this copy can't follow the channel (v1 paintUpd `why`), or ''. */
export function whyNot(u: Pick<UpdateState, 'method' | 'enabled'> | undefined): string {
  if (!u) return '';
  if (u.method === 'git') return t('update.why.git');
  if (u.method === 'brew') return t('update.why.brew');
  if (!u.enabled) return t('update.why.off');
  return '';
}

/** The channel row's line (v1 .upd-hint): what the channel means, why not, and the version. */
export function channelHint(channel: string, u: Pick<UpdateState, 'method' | 'enabled' | 'current'> | undefined): string {
  const parts = [HINTS[isChannel(channel) ? channel : 'stable'](), whyNot(u), u?.current ? t('update.youreOn', { version: u.current }) : ''];
  return parts.filter(Boolean).join('. ');
}

/** The version row's line: what's going on with this wisp's version. */
export function versionLine(u: UpdateState): string {
  const latest = u.latest ?? '';
  if (u.status === 'restarting') return t('update.state.restarting');
  if (u.status === 'installing') return t('update.state.installing', { latest });
  if (u.method === 'git') return t('update.state.clone');
  if (u.available) return t('update.state.available', { latest });
  return u.checked_at ? t('update.state.current') : t('update.state.unknown');
}

/** Update now shows while there's something to install, or an install is under way. */
export const showsInstall = (u: UpdateState): boolean => u.available || u.status !== 'idle';
