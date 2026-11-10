// Settings → Privacy's writes: usage stats on or off (telemetry.set). The row shows it at once.
import { defineCommand, entityKey, type PeerId } from '@wisp/client';

export const KIND = 'telemetry.state';
export const TOPIC = 'plugin:wisp.telemetry:state';

export interface StateRow {
  readonly on: boolean;
  /** the switch */
  readonly setting: boolean;
  /** DO_NOT_TRACK, WISP_TELEMETRY=0 or CI turn stats off whatever the switch says */
  readonly blocked: boolean;
}

export const setStats = defineCommand<{ peer: PeerId; on: boolean }>({
  id: 'telemetry.set',
  owner: (a) => a.peer,
  wire: (a) => ({ on: a.on }),
  optimistic: (base, a) => {
    const id = entityKey(a.peer, 'this');
    const row = base.peek<StateRow>(KIND, id);
    return row ? [{ e: KIND, id, op: 'upsert', v: { ...row, setting: a.on, on: a.on && !row.blocked } }] : [];
  },
});
