// wisp.channels' Settings → Phone shapes, as plugins/channels/api/src/setup.rs serializes them (one file, so
// switching to generated types is one edit).

export type Transport = 'ntfy' | 'telegram' | 'slack' | 'discord' | 'github' | 'email';
export const ORDER: readonly Transport[] = ['ntfy', 'telegram', 'slack', 'discord', 'github', 'email'];

export type SetupState = 'off' | 'incomplete' | 'checking' | 'linking' | 'connected' | 'failing';

/** One channel as Settings shows it: secrets only as saved or not. */
export interface ChannelSetup {
  readonly transport: string;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly state: SetupState;
  readonly saved: readonly string[];
  readonly settings: Readonly<Record<string, string | boolean>>;
  readonly missing: readonly string[];
  readonly error?: string;
  readonly linkCode?: string;
  readonly linked: number;
  readonly who?: string;
  /** Send me: what it notifies about */
  readonly notify: readonly NotifyEvent[];
  /** Discord on a cloud computer: its Interactions Endpoint URL (channels.status only, never on the topic) */
  readonly endpoint?: string;
}

/** Send me's events (v1 waiting, finished), in its order. */
export type NotifyEvent = 'asks' | 'finished';
export const NOTIFY: readonly NotifyEvent[] = ['asks', 'finished'];

/** Settings → Phone's rows: `plugin:wisp.channels:phone`, kind `chan_phone`, id the transport, `body` the channel as
 * channels.status says it less what a stranger could get in by (link code, email address, endpoint URL). */
export const PHONE_TOPIC = 'plugin:wisp.channels:phone';
export const PHONE_KIND = 'chan_phone';
export interface PhoneRow {
  readonly id: string;
  readonly body: ChannelSetup;
}

export interface PhoneStatus {
  readonly cloud: boolean;
  readonly channels: readonly ChannelSetup[];
}

/** channels.setup's args: what's left out stays. */
export interface SetupArgs {
  readonly transport: string;
  readonly enabled?: boolean;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly settings?: Readonly<Record<string, string | boolean>>;
  readonly notify?: readonly NotifyEvent[];
  readonly unlink?: boolean;
}

export type TestOutcome = 'sent' | 'failed' | 'unprompted';

export interface Tested {
  readonly channel: string;
  readonly outcome: TestOutcome;
  readonly error?: string;
}

/** channels.rotate's answer (an HTTP-shaped one): `body.address` on 200, `body.error` otherwise. */
export interface Rotated {
  readonly status: number;
  readonly body: { readonly address?: string; readonly error?: string };
}
