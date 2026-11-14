// The rows, topics, keys and command args Settings → Updates reads and writes, until Rust generates
// them (packages/protocol/src/generated). The state row is v1's GET /api/update (`Updater.view()`,
// plugins/update/core/src/updater.rs `View`) plus three fields the pane needs and v1 kept elsewhere:
// `checked_at` (v1 Updater.checkedAt), `checking` (a check in flight) and `running` (tasks an
// install would stop, which v1 counted on the page from S.sessions).

import type { PeerId } from '@wisp/client';
import type { Topic } from '@wisp/protocol';

/** The home peer publishes one row, id `update`. */
export const TOPIC: Topic = 'plugin:wisp.update:state';
export const KIND = 'update.state';
export const ROW_ID = 'update';

export const CHANNELS = ['stable', 'beta', 'nightly'] as const;
export type Channel = (typeof CHANNELS)[number];

/** How this copy of wisp was installed (v1 installMethod): npm -g, npx, Homebrew, a git clone, the desktop app. */
export type Method = 'global' | 'npx' | 'brew' | 'git' | 'app';
export type Status = 'idle' | 'installing' | 'restarting';

export interface UpdateState {
  current: string;
  latest: string | null;
  available: boolean;
  method: Method;
  channel: Channel;
  status: Status;
  error: string | null;
  /** false: a git clone, WISP_UPDATE_CHECK=0 or CI */
  enabled: boolean;
  /** what installs the latest (a downloads page for the app); none for a clone */
  command?: string;
  /** when the last check finished (ms); null before the first */
  checked_at?: number | null;
  /** a check is in flight */
  checking?: boolean;
  /** running or waiting tasks an install stops */
  running?: number;
}

/** Registry keys (v1 config.defaults names after the dot). */
export const KEYS = {
  channel: 'update.updateChannel', // stable | beta | nightly
} as const;

export interface CheckArgs {
  peer: PeerId;
}

export interface InstallArgs {
  peer: PeerId;
  /** v1 `force`: stop the running tasks (asked first) */
  force: boolean;
}
