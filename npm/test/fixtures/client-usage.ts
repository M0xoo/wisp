// A realistic use of the v2 SDK, type-checked under strict settings (types.test.mjs).

import { DEFAULT_PORT, WispClient, WispError, discover, generateTypes, wispHome } from '../../wisp-agents/client.js';
import type { CatalogueEntry, Task } from '../../wisp-agents/client.js';

async function main(): Promise<void> {
  const port: number = discover(wispHome()) ?? DEFAULT_PORT;
  const w = await WispClient.connect({ port, start: false });
  const t = await w.run({ prompt: 'fix the flaky test', agent: 'claude', mode: 'edits', confirmLimit: true });
  const done: Task = await w.wait(t.id, { timeoutMs: 60_000, until: (s) => s.state === 'review' });
  const p = await w.presentation(done.id);
  console.log(p?.blocks.length ?? 0);
  await w.followUp(done.id, 'and add a test', { queue: true });
  for await (const m of w.events(['list'], { signal: AbortSignal.timeout(1000) })) {
    if (m.t === 'patch') break;
  }
  const list: CatalogueEntry[] = await w.catalogue();
  const types: string = generateTypes(list);
  console.log(types.length);
  try {
    await w.cmd('runtime.stop', { id: done.id });
  } catch (e) {
    if (e instanceof WispError && e.retry) console.log(e.code, e.status);
  }
}

void main();
