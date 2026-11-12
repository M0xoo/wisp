// The composer's env (src/env.ts): built once per plugin client, its store under the client's own name.
import { expect, test } from 'vitest';
import { createClient, memoryPersist, type PeerId } from '@wisp/client';
import { envOf } from '../src/env.ts';

test('the queue over the reply box can build its env: the store is the client s own and asking twice is one env_v1_queue_mounts', () => {
  const client = createClient({ clientId: 'c', build: 't', home: 'p' as PeerId, width: 1280, persist: memoryPersist() });
  const c = client.plugin('shell-composer');
  const env = envOf(c);
  expect(envOf(client.plugin('shell-composer'))).toBe(env);
  expect(() => envOf(c)).not.toThrow();
});
