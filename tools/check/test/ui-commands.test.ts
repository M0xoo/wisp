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
      ['plugins/shop/host/src/lib.rs', 's.command_named("shop.buy", handler);'],
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

test('ui-commands: a command its api declares but no host registers fails (terminal.apps, round 15); one the host registers by type passes', async () => {
  const root = writeTree(
    new Map([
      ['package.json', JSON.stringify({ name: 'fixture', private: true, type: 'module', workspaces: ['plugins/*/ui'] })],
      ['plugins/term/host/wisp-plugin.json', JSON.stringify({ wispPlugin: 1, id: 'wisp.term', contributes: { commands: [{ id: 'term.apps', title: 'a', uiOnly: 'Settings' }, { id: 'term.open', title: 'o' }, { id: 'term.view', title: 'v' }] } })],
      ['plugins/term/api/src/lib.rs', 'command!(Apps = "term.apps", "term:read": AppsArgs => Apps);\ncommand!(Open = "term.open", "term:open": OpenArgs => Info);\nimpl Command for View {\n    const ID: &\'static str = "term.view";\n}'],
      ['plugins/term/host/src/lib.rs', 'on!(s, slot, c::Open, |r, ctx, call, a| Ok(r.open(&a)));\ns.command::<api::View, _, _>(handler);'],
      ['plugins/term/ui/package.json', JSON.stringify({ name: '@wisp-plugin/term-ui' })],
      ['plugins/term/ui/src/index.ts', 'export default definePluginUi({ id: "wisp.term" });'],
      ['plugins/term/ui/src/commands.ts', ["defineCommand<A>({ id: 'term.apps', owner });", "defineCommand<A>({ id: 'term.open', owner });", "defineCommand<A>({ id: 'term.view', owner });"].join('\n')],
    ]),
  );
  const got = await messages(uiCommands, root);
  assert.equal(got.length, 1, got.join('\n'));
  assert.ok(got[0]?.includes('term.apps: plugins/term declares it but nothing registers a handler (its host never names Apps)'));
});

