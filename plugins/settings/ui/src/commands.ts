// Settings → All settings' read: every setting the plugins declare (settings.list), with its owner, type,
// default and lock. Values are the `setting` rows (live); writes are settings.set through source.ts.
import { defineCommand, type PeerId } from '@wisp/client';

export interface SettingInfo {
  readonly key: string;
  readonly owner: string;
  readonly decl: {
    readonly key: string;
    readonly type: string;
    readonly values?: readonly string[] | null;
    readonly default?: unknown;
    readonly title?: string | null;
    readonly secret?: boolean;
  };
  readonly scope: string;
  readonly value?: unknown;
  readonly lockedBy?: string | null;
}

export const list = defineCommand<{ peer: PeerId }, SettingInfo[]>({ id: 'settings.list', owner: (a) => a.peer, wire: () => ({}), optimistic: 'none', pending: 'the settings list' });
