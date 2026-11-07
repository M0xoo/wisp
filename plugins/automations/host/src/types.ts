// A trigger as the host keeps it: the view's fields plus its bookkeeping (what it has seen, which
// task works on each CI branch, whether the first poll ran) and the hook's signing secret, which
// lives in the secrets service, never in a row.

import type { TriggerView } from '@wisp-plugin/automations-api';

export interface Trigger extends Omit<TriggerView, 'watching' | 'nextAt' | 'hasSecret' | 'open'> {
  seen: string[];
  /** ci: branch → the task working on its failures */
  tasks: Record<string, string>;
  seeded: boolean;
  /** a hook's signing secret ('' = none); kept in the secrets service */
  secret: string;
}

/** A crew member as a trigger needs it (from `crew.get`, or sent by the crew with syncMember). */
export interface Member {
  id: string;
  name: string;
  cwd: string;
  machine?: string;
}
