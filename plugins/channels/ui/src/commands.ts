// Settings → Phone's commands (plugins/channels/api/src/setup.rs). Where each channel stands is the hub's memory
// (ADR-0037): read once with channels.status, then watched on `plugin:wisp.channels:phone` (one row per channel the hub
// writes when it changes). The pane shows each save at once in its own copy (lib.ts `optimistic`) and puts it back
// when the command is refused; the shell's onError toasts why.

import { defineCommand, type PeerId } from '@wisp/client';
import type { ChannelSetup, PhoneStatus, Rotated, SetupArgs, Tested } from './types.ts';

type OnPeer = { readonly peer: PeerId };

export const phoneStatus = defineCommand<OnPeer, PhoneStatus>({
  id: 'channels.status',
  owner: (a) => a.peer,
  wire: () => ({}),
  optimistic: 'none',
  pending: 'the Phone pane skeleton', // a read: the pane shows its rows as soon as it answers
});

export const setupChannel = defineCommand<OnPeer & SetupArgs, ChannelSetup>({
  id: 'channels.setup',
  owner: (a) => a.peer,
  wire: ({ peer: _p, ...args }) => args,
  // the hub's state isn't in the entity store: the pane patches its own copy at once (lib.ts optimistic)
  optimistic: 'none',
  pending: 'the channel row, patched in place by the pane',
  // a save with a token is its own run: no part of a token goes into a dedupe key (kept in the outbox's record)
  dedupe: (a) =>
    a.secrets !== undefined && Object.keys(a.secrets).length > 0
      ? `secret:${crypto.randomUUID()}`
      : a.unlink === true
        ? `unlink:${a.transport}:${crypto.randomUUID()}` // each Unlink is its own: it makes a new code
        : `${a.transport}:${String(a.enabled ?? '')}:${JSON.stringify(a.settings ?? {})}:${JSON.stringify(a.notify ?? null)}`,
});

export const testChannel = defineCommand<OnPeer & { readonly channel: string }, Tested[]>({
  id: 'channels.test',
  owner: (a) => a.peer,
  wire: (a) => ({ channel: a.channel }),
  optimistic: 'none',
  pending: 'the Test button',
});

/** Slack's manifest, Discord's invite link: what a channel offers besides its setup (answered even while it's off,
 * where it needs no connection). */
export const channelExtra = defineCommand<OnPeer & { readonly channel: string; readonly what: string }, unknown>({
  id: 'channels.extra',
  owner: (a) => a.peer,
  wire: (a) => ({ channel: a.channel, what: a.what }),
  optimistic: 'none',
  pending: 'the button that asked',
});

/** Email's New address: the old one stops working at once. */
export const rotateChannel = defineCommand<OnPeer & { readonly channel: string }, Rotated>({
  id: 'channels.rotate',
  owner: (a) => a.peer,
  wire: (a) => ({ channel: a.channel }),
  optimistic: 'none',
  pending: 'the New address button',
  dedupe: (a) => `rotate:${a.channel}:${crypto.randomUUID()}`,
});
