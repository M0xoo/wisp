// The files `node tools/new-plugin.ts <name>` writes, one function per file. They follow ARCHITECTURE.md
// (api / host / ui, each a workspace package) and the add-plugin skill. Every generated package passes
// `npm run check`; the one thing left to the author is naming the command in a capability set.

export interface PluginNames {
  name: string; // folder: 'my-prs'
  id: string; // plugin id: 'wisp.my-prs'
  camel: string; // 'myPrs'
  pascal: string; // 'MyPrs'
  tier: 'builtin' | 'exec';
}

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
const SCRIPTS = { test: 'node --test --test-reporter=dot "test/**/*.test.ts"', typecheck: 'tsc -p tsconfig.json' };

export function names(name: string, tier: 'builtin' | 'exec', id?: string): PluginNames {
  const camel = name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return { name, id: id ?? `wisp.${name}`, camel, pascal: camel.charAt(0).toUpperCase() + camel.slice(1), tier };
}

function packageJson(pkgName: string, deps: Record<string, string>, extra: Record<string, unknown> = {}): string {
  return json({ name: pkgName, version: '0.1.0', private: true, type: 'module', exports: { '.': './src/index.ts' }, scripts: SCRIPTS, dependencies: deps, ...extra });
}

const tsconfig = (base: 'tsconfig.base.json' | 'tsconfig.web.json'): string => json({ extends: `../../../${base}`, include: ['src/**/*', 'test/**/*'] });

function apiIndex(n: PluginNames): string {
  return `// @wisp-plugin/${n.name}-api: what other plugins may depend on (ARCHITECTURE.md). Commands, events,
// topics, row types, extension points and services live here; other plugins import only this package.
// Contracts only: types and constants, no node: imports, no side effects.

export const COMMANDS = {
  hello: '${n.name}.hello',
} as const;

export interface HelloArgs {
  name: string;
}

export interface HelloResult {
  greeting: string;
}

/** Validates unknown input for ${n.name}.hello; the host's \`parse\` uses it. */
export function parseHello(args: unknown): HelloArgs {
  const name = typeof args === 'object' && args !== null && 'name' in args ? args.name : undefined;
  if (typeof name !== 'string' || !name) throw Object.assign(new Error('name: a non-empty string'), { code: 'invalid' });
  return { name };
}
`;
}

function apiTest(n: PluginNames): string {
  return `import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMANDS, parseHello } from '../src/index.ts';

test('command ids carry the plugin prefix', () => {
  for (const id of Object.values(COMMANDS)) assert.match(id, /^${n.name.replace(/-/g, '\\-')}\\./);
});

test('parseHello refuses what is not {name: string}', () => {
  assert.deepEqual(parseHello({ name: 'wisp' }), { name: 'wisp' });
  for (const bad of [undefined, null, {}, { name: '' }, { name: 1 }]) assert.throws(() => parseHello(bad), /name/);
});
`;
}

export function manifest(n: PluginNames): string {
  return json({
    wispPlugin: 1,
    id: n.id,
    name: n.pascal,
    version: '0.1.0',
    api: '^1',
    description: `TODO: what ${n.name} does, in one sentence`,
    kind: 'plugin',
    permissions: [],
    server: n.tier === 'builtin' ? { builtin: './src/index.ts' } : { exec: ['node', './src/main.ts'] },
    activation: [`onCommand:${n.name}.hello`],
    contributes: {
      commands: [{ id: `${n.name}.hello`, title: 'Say hello', optimistic: 'none' }],
      events: [],
      topics: [],
      points: [],
    },
  });
}

function hostBuiltin(n: PluginNames): string {
  return `// ${n.id}: the server side. Everything goes through \`ctx\` so it belongs to the plugin's scope and
// switching the plugin off frees it. Writes go through store.tx inside a command; never import another
// plugin's host, only its api.
import type { PluginContext, PluginDef } from '@wisp/kernel';
import { COMMANDS, parseHello, type HelloArgs, type HelloResult } from '@wisp-plugin/${n.name}-api';

const plugin: PluginDef = {
  id: '${n.id}',
  setup(ctx: PluginContext) {
    ctx.command<HelloArgs, HelloResult>({
      id: COMMANDS.hello,
      parse: parseHello,
      run: (args) => ({ greeting: \`hello, \${args.name}\` }),
    });
  },
};

export default plugin;
`;
}

function hostExecRpc(n: PluginNames): string {
  return `// ${n.id} runs as a subprocess (the exec tier): newline-delimited JSON-RPC 2.0 on stdin/stdout.
// \`handle\` is pure so it is tested without a process; src/main.ts wires it to stdio.
// The method names follow the kernel's exec host: 'setup' lists the commands, 'command' runs one.
import { COMMANDS, parseHello } from '@wisp-plugin/${n.name}-api';

export interface Request {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export type Response =
  | { jsonrpc: '2.0'; id: number | string; result: unknown }
  | { jsonrpc: '2.0'; id: number | string; error: { code: number; message: string; data?: { code: string } } };

const fail = (id: number | string, code: string, message: string): Response => ({ jsonrpc: '2.0', id, error: { code: -32000, message, data: { code } } });

export function handle(req: Request): Response {
  if (req.method === 'setup') return { jsonrpc: '2.0', id: req.id, result: { id: '${n.id}', commands: Object.values(COMMANDS) } };
  if (req.method !== 'command') return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: \`no method \${req.method}\` } };
  const p = typeof req.params === 'object' && req.params !== null ? (req.params as { id?: unknown; args?: unknown }) : {};
  if (p.id !== COMMANDS.hello) return fail(req.id, 'not_found', \`no command \${String(p.id)}\`);
  try {
    const args = parseHello(p.args);
    return { jsonrpc: '2.0', id: req.id, result: { greeting: \`hello, \${args.name}\` } };
  } catch (e) {
    return fail(req.id, 'invalid', e instanceof Error ? e.message : String(e));
  }
}
`;
}

function hostExecMain(): string {
  return `import { createInterface } from 'node:readline';
import { handle, type Request } from './index.ts';

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line) as Request;
  process.stdout.write(\`\${JSON.stringify(handle(req))}\\n\`);
});
`;
}

function hostTest(n: PluginNames): string {
  const shared = `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
`;
  const manifestRead = `const manifest = JSON.parse(readFileSync(new URL('../wisp-plugin.json', import.meta.url), 'utf8')) as { id: string; contributes: { commands: { id: string }[] } };
const declared = manifest.contributes.commands.map((c) => c.id).sort();
`;
  if (n.tier === 'exec') {
    return `${shared}import { handle } from '../src/index.ts';

${manifestRead}
test('setup lists exactly the commands the manifest declares', () => {
  const res = handle({ jsonrpc: '2.0', id: 1, method: 'setup' });
  assert.ok('result' in res);
  assert.deepEqual([...(res.result as { commands: string[] }).commands].sort(), declared);
});

test('${n.name}.hello answers, and refuses bad input with invalid', () => {
  assert.deepEqual(handle({ jsonrpc: '2.0', id: 2, method: 'command', params: { id: '${n.name}.hello', args: { name: 'wisp' } } }), { jsonrpc: '2.0', id: 2, result: { greeting: 'hello, wisp' } });
  const bad = handle({ jsonrpc: '2.0', id: 3, method: 'command', params: { id: '${n.name}.hello', args: {} } });
  assert.ok('error' in bad && bad.error.data?.code === 'invalid');
});
`;
  }
  return `${shared}import type { CallContext, CommandDef, PluginContext } from '@wisp/kernel';
import plugin from '../src/index.ts';

${manifestRead}
// A recording context until @wisp/testkit's plugin harness covers it (deactivate leaks nothing, a
// missing permission is refused): swap to it then.
function record(): { ctx: PluginContext; commands: Map<string, CommandDef<unknown, unknown>> } {
  const commands = new Map<string, CommandDef<unknown, unknown>>();
  const ctx = { command: (def: CommandDef<unknown, unknown>) => void commands.set(def.id, def) } as unknown as PluginContext;
  return { ctx, commands };
}

test('the plugin id is the manifest id', () => {
  assert.equal(plugin.id, manifest.id);
});

test('setup registers exactly the commands the manifest declares', async () => {
  const { ctx, commands } = record();
  await plugin.setup(ctx);
  assert.deepEqual([...commands.keys()].sort(), declared);
});

test('${n.name}.hello parses its input and answers', async () => {
  const { ctx, commands } = record();
  await plugin.setup(ctx);
  const hello = commands.get('${n.name}.hello');
  assert.ok(hello?.parse);
  assert.throws(() => hello.parse?.({}), /name/);
  assert.deepEqual(await hello.run(hello.parse({ name: 'wisp' }), ctx as unknown as CallContext), { greeting: 'hello, wisp' });
});
`;
}

function uiExtensions(n: PluginNames): string {
  return `// The UI extensions this plugin attaches, by id. Each one is also declared in
// ../host/wisp-plugin.json under contributes.ui once the shell input it attaches to exists.
export const EXTENSIONS = {
  hello: '${n.name}.hello',
} as const;
`;
}

function uiComponent(n: PluginNames): string {
  return `// Kit components only: no class, no style (CSS custom properties aside), no .css. Every string goes
// through t(), every element a plugin may restyle has a data-part.
import type { JSX } from 'solid-js';
import { Text } from '@wisp/ui';
import { EXTENSIONS } from './extensions.ts';

export function ${n.pascal}Hello(props: { readonly t: (key: string) => string }): JSX.Element {
  return <Text part={EXTENSIONS.hello}>{props.t('${n.name}.hello')}</Text>;
}
`;
}

function uiTest(): string {
  return `import { describe, expect, it } from 'vitest';
import { EXTENSIONS } from '../src/extensions.ts';

describe('extensions', () => {
  it('carry the plugin prefix', () => {
    for (const id of Object.values(EXTENSIONS)) expect(id).toMatch(/^[a-z][a-z0-9-]*\\./);
  });
});
`;
}

function readme(n: PluginNames): string {
  return `# ${n.id}

TODO: what this plugin owns (its domain: tables, commands, topics) and why it is a plugin of its own.

| Package | Name | What |
|---|---|---|
| \`api/\` | \`@wisp-plugin/${n.name}-api\` | the contract other plugins may import: commands, events, topics, points, services |
| \`host/\` | \`@wisp-plugin/${n.name}\` | the server side (${n.tier === 'builtin' ? 'in-process' : 'a subprocess over JSON-RPC'}); \`wisp-plugin.json\` lives here |
| \`ui/\` | \`@wisp-plugin/${n.name}-ui\` | UI extensions, kit components only |

## Next steps

1. Name \`${n.name}.hello\` (or \`${n.name}:*\`) in the capability sets that may run it:
   \`packages/kernel/src/capabilities.ts\`. Until then \`npm run check\` fails (default deny).
2. Write the real contract in \`api/src/index.ts\`, then the host against it.
3. Add the plugin to the groups that ship it (\`apps/server/src/groups.ts\`).
4. \`npm install\` (links the new workspaces), then \`.agents/bin/monoflow verify --affected\` and \`npm run check\`.
`;
}

/** Every file of the scaffold, by path relative to the repo root. */
export function scaffold(n: PluginNames): Map<string, string> {
  const base = `plugins/${n.name}`;
  const api = `@wisp-plugin/${n.name}-api`;
  const files = new Map<string, string>([
    [`${base}/README.md`, readme(n)],
    [`${base}/api/package.json`, packageJson(api, { '@wisp/kernel': '*' })],
    [`${base}/api/tsconfig.json`, tsconfig('tsconfig.base.json')],
    [`${base}/api/src/index.ts`, apiIndex(n)],
    [`${base}/api/test/contract.test.ts`, apiTest(n)],
    [`${base}/host/package.json`, packageJson(`@wisp-plugin/${n.name}`, { '@wisp/kernel': '*', [api]: '*' }, { exports: { '.': './src/index.ts', './wisp-plugin.json': './wisp-plugin.json' } })],
    [`${base}/host/tsconfig.json`, tsconfig('tsconfig.base.json')],
    [`${base}/host/wisp-plugin.json`, manifest(n)],
    [`${base}/host/src/index.ts`, n.tier === 'builtin' ? hostBuiltin(n) : hostExecRpc(n)],
    [`${base}/host/test/plugin.test.ts`, hostTest(n)],
    [`${base}/ui/package.json`, packageJson(`@wisp-plugin/${n.name}-ui`, { '@wisp/ui': '*', [api]: '*', 'solid-js': '^1.9.18' }, { scripts: { test: 'vitest run --passWithNoTests', typecheck: 'tsc -p tsconfig.json' }, devDependencies: { vitest: '^4.1.0' } })],
    [`${base}/ui/tsconfig.json`, tsconfig('tsconfig.web.json')],
    [`${base}/ui/src/index.ts`, `export { EXTENSIONS } from './extensions.ts';\nexport { ${n.pascal}Hello } from './Hello.tsx';\n`],
    [`${base}/ui/src/extensions.ts`, uiExtensions(n)],
    [`${base}/ui/src/Hello.tsx`, uiComponent(n)],
    [`${base}/ui/test/extensions.test.ts`, uiTest()],
  ]);
  if (n.tier === 'exec') files.set(`${base}/host/src/main.ts`, hostExecMain());
  return files;
}
