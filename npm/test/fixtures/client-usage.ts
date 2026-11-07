// Type-checked by test/types.test.mjs (tsc --strict --noEmit). Everything sits in a function that
// is never called, so running this file by accident does nothing.

import { DEFAULT_PORT, WispClient, WispError, discover, tryProblem, tryRuns, wispHome } from '../../wisp-agents/client.js';
import type { SessionSummary, WispEvent } from '../../wisp-agents/client.js';

export async function usage(): Promise<void> {
  const port: 4477 = DEFAULT_PORT;
  const home: string = wispHome();
  const info = discover(home);
  const wisp = await WispClient.connect({ port: info?.port ?? port, start: false, timeoutMs: 5000 });
  const s: SessionSummary = await wisp.launch({ prompt: 'fix the flaky test', cwd: '.', agent: 'claude', compare: [{ agent: 'codex' }] });
  const id: string = s.id;
  const title: string | undefined = s.title;
  const list = await wisp.sessions({ state: 'running,review', limit: 5, archived: false });
  for (const x of list) x.state?.toUpperCase();
  const done = await wisp.wait(id, { timeoutMs: 60_000 });
  if (done.timedOut) return;
  const md: string | undefined = (await wisp.presentation(id, { turn: 1 })).markdown;
  await wisp.reply(id, 'more', { queue: true });
  const b = await wisp.btw(id, 'why?');
  const q = await wisp.btw(id, 'why?', { wait: false });
  const up = await wisp.upload(new Uint8Array([1]), { name: 'a.bin' });
  await wisp.revert(id, 'src/a.ts');
  await wisp.exec(id, 'ls', { cwd: '/' });
  const res: Response = await wisp.request('GET', '/events', undefined, { raw: true });
  const health = await wisp.request<{ ok: boolean }>('GET', '/health');
  for await (const e of wisp.events()) {
    const ev: WispEvent = e;
    if (ev.event === 'finished') break;
  }
  const change = tryRuns(['subagents=haiku']);
  const why: string | null = tryProblem({ agent: 'claude', worktree: true });
  try {
    await wisp.stop(id);
  } catch (err) {
    if (err instanceof WispError) console.log(err.status, err.body);
  }
  console.log(title, md, b.status, q.id, up.id, res.ok, health.ok, change.subagentModel, why);
}
