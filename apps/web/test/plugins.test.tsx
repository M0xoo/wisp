// @vitest-environment happy-dom
// Every plugin UI in this checkout registers in a real shell (apps/web/src/plugins.ts). main.tsx keeps
// going when one is refused (a bad plugin never stops the app), so a refusal, such as a string outside the
// plugin's namespace, used to drop a whole screen without a word: the open task mounted nothing
// (docs/v2-round-7.md). This test makes that loud, and checks the list has its plugin (the task screen is the frame's own until
// shell-task's is built).
import { expect, test } from 'vitest';
import { createClient, peerId } from '@wisp/client';
import { createShell, nullPlatform, type ShellWindow } from '@wisp/shell';
import { createToaster } from '@wisp/ui';
import { pluginUis } from '../src/plugins.ts';

test('every plugin UI registers, and the frame areas have their plugins', () => {
  const home = peerId('local');
  const client = createClient({ clientId: 'c1', build: 't', home, width: 1440 });
  const shell = createShell({ client, toaster: createToaster(), platform: nullPlatform(), home, window: window as unknown as ShellWindow });
  const refused: string[] = [];
  for (const { path, def } of pluginUis()) {
    if (!def) continue;
    try {
      shell.register(def);
    } catch (err) {
      refused.push(`${path}: ${String(err)}`);
    }
  }
  expect(refused).toEqual([]);
  const areas = pluginUis().flatMap(({ def }) => (def?.extensions ?? []).map((e) => e.attachTo.id));
  for (const area of ['shell.sidebar:list', 'shell.task:band', 'shell.task:foot', 'shell.side:changes']) expect(areas, area).toContain(area);
});
