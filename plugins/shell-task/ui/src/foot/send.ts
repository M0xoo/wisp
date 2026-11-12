// A follow-up sent from over the reply box (Send comments): the task shows it's starting at once; its turn comes
// with the server's answer.
import { defineCommand, type EntityKey } from '@wisp/client';

const bare = (k: string): string => k.slice(k.indexOf(':') + 1);

export const followUp = defineCommand<{ id: string; text: string; turnId: string; idx: number; at: number }>({
  id: 'runtime.followUp',
  owner: (a) => a.id,
  wire: (a) => ({ ...a, id: bare(a.id) }),
  optimistic: (_base, a) => [
    {
      e: 'session',
      id: a.id as EntityKey,
      op: 'patch',
      ops: [
        { op: 'replace', path: '/state', value: 'running' },
        { op: 'replace', path: '/summary/live', value: 'Starting…' },
      ],
    },
  ],
});
