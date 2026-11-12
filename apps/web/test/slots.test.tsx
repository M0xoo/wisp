// @vitest-environment happy-dom
// The frame's extension inputs (v1's spell SLOTS): a plugin's extension on each one renders where the
// input is (the sidebar's head, a task's row, the open task's head), through the real client and shell
// against the mock peer. With nothing attached the inputs render no box (the parity gate checks pixels).
import { expect, test } from 'vitest';
import type { JSX } from 'solid-js';
import { createClient, peerId, type EntityKey } from '@wisp/client';
import { createShell, defineExtension, definePluginUi, nullPlatform, type ShellWindow } from '@wisp/shell';
import { createToaster } from '@wisp/ui';
import { createMockPeer } from '../dev/mock-peer.ts';
import { memTransport } from '../dev/mem-transport.ts';

const INPUTS = [
  'shell.topbar:brand',
  'shell.topbar:search',
  'shell.topbar:account',
  'shell.topbar:view',
  'shell.topbar:machines',
  'shell.topbar:getapp',
  'shell.topbar:automations',
  'shell.topbar:settings',
  'shell.topbar:projects',
  'shell.row:top',
  'shell.row:head',
  'shell.row:hover',
  'shell.row:bottom',
  'shell.task:head',
] as const;

const settle = async (n = 30): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
/** until `ok`: the task screen is a lazy import, so it shows a beat after the navigation (2 s at most) */
const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
};

function Mark(input: string): () => JSX.Element {
  return () => <span data-test-ext={input}>{input}</span>;
}

async function start(withPlugin: boolean) {
  const mock = createMockPeer({ epoch: 'e1' });
  const home = peerId('local');
  const client = createClient({ clientId: 'c1', build: 't', home, width: 1440 });
  const shell = createShell({ client, toaster: createToaster(), platform: nullPlatform(), home, window: window as unknown as ShellWindow });
  if (withPlugin)
    shell.register(
      definePluginUi({
        id: 'test.slots',
        extensions: INPUTS.map((input) => defineExtension({ id: `test.${input.replace(/[:.]/g, '-')}`, attachTo: { id: input as never }, component: Mark(input) })),
      }),
    );
  await client.start([{ peer: home, name: 'mock', transport: memTransport(mock) }]);
  const root = document.createElement('div');
  document.body.append(root);
  const stop = shell.render(root);
  await settle();
  return { client, shell, root, stop };
}

test('a plugin extension renders in every input of the frame', async () => {
  const { client, root, stop } = await start(true);
  const first = client.entities.list<{ id: string }>('session')()[0];
  expect(first).toBeDefined();
  client.nav.navigate({ t: 'openTask', id: first?.id as EntityKey as never });
  await until(() => root.querySelector('[data-part~="split.head"]') !== null);
  await settle();
  for (const input of INPUTS) expect(root.querySelector(`[data-test-ext="${input}"]`), input).not.toBeNull();
  // an area's extension replaces the built-in control it overrides
  expect(root.querySelector('[data-kit="brand"]')).toBeNull();
  expect(root.querySelector('[data-kit="search-btn"]')).toBeNull();
  // row inputs render once per row
  expect(root.querySelectorAll('[data-test-ext="shell.row:head"]').length).toBe(client.entities.list<{ archived: boolean }>('session')().filter((s) => !s.archived).length);
  stop();
});

test('with nothing attached, the inputs add no element with a box: the built-ins show', async () => {
  const { root, stop } = await start(false);
  expect(root.querySelector('[data-kit="brand"]')).not.toBeNull();
  expect(root.querySelector('[data-kit="search-btn"]')).not.toBeNull();
  for (const slot of root.querySelectorAll('[data-kit="slot"]')) expect(slot.hasAttribute('data-empty'), slot.getAttribute('data-input') ?? '').toBe(true);
  stop();
});
