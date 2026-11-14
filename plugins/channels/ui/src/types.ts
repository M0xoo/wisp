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
}

export type TestOutcome = 'sent' | 'failed' | 'unprompted';

export interface Tested {
  readonly channel: string;
  readonly outcome: TestOutcome;
  readonly error?: string;
}
