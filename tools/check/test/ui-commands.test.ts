import assert from 'node:assert/strict';
import test from 'node:test';
import { uiCommands } from '../rules/ui-commands.ts';
import { messages, writeTree } from './helpers.ts';

test('ui-commands: a UI command no manifest lists, one no Rust handles, a topic nobody writes and an unregistered UI all fail', async () => {
  const root = writeTree(
    new Map([
      ['package.json', JSON.stringify({ name: 'fixture', private: true, type: 'module', workspaces: ['packages/*', 'plugins/*/ui', 'apps/*'] })],
      ['plugins/shop/host/wisp-plugin.json', JSON.stringify({ wispPlugin: 1, id: 'wisp.shop', contributes: { commands: [{ id: 'shop.buy', title: 'b' }, { id: 'shop.ghost', title: 'g' }] } })],
      ['plugins/shop/api/src/lib.rs', 'const ID: &str = "shop.buy";\nconst T: &str = "plugin:wisp.shop:cart";'],
      ['plugins/shop/ui/package.json', JSON.stringify({ name: '@wisp-plugin/shop-ui' })],
      ['plugins/shop/ui/src/index.ts', 'export default definePluginUi({ id: "wisp.shop" });'],
      [
        'plugins/shop/ui/src/commands.ts',
        [
          "export const buy = defineCommand<A>({ id: 'shop.buy', owner, optimistic: 'none', pending: 'x' });",
          "export const ghost = defineCommand<A>({",
          "  id: 'shop.ghost',",
          '  owner,',
          '});',
          "export const old = defineCommand<A>({ id: 'session.old', owner, optimistic: 'none', pending: 'x' });",
          "client.watch(home, 'plugin:wisp.shop:cart', s); client.watch(home, 'plugin:wisp.shop:gone', s);",
        ].join('\n'),
      ],
      ['plugins/till/ui/package.json', JSON.stringify({ name: '@wisp-plugin/till-ui' })],
      ['plugins/till/ui/src/model.ts', 'export const x = 1;'],
      ['plugins/menu/ui/package.json', JSON.stringify({ name: '@wisp-plugin/menu-ui' })],
      ['apps/web/src/main.tsx', "import { menuUi } from '@wisp-plugin/menu-ui';"],
    ]),
  );
  const got = await messages(uiCommands, root);
  assert.equal(got.length, 4, got.join('\n'));
  assert.ok(got.some((m) => m.includes('session.old, which no plugin manifest lists')));
  assert.ok(got.some((m) => m.includes('shop.ghost: plugins/shop lists it but its Rust never names it')));
  assert.ok(got.some((m) => m.includes('plugin:wisp.shop:gone, which no server writes')));
  assert.ok(got.some((m) => m.includes('@wisp-plugin/till-ui is registered nowhere')));
});
