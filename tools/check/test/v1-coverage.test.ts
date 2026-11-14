import assert from 'node:assert/strict';
import test from 'node:test';
import { v1Coverage } from '../rules/v1-coverage.ts';
import { messages, writeTree } from './helpers.ts';

const row = (kind: string, item: string, ...refs: string[]): string => `| ${kind} | \`${item}\` | ${refs.map((r) => `\`${r}\``).join(', ')} |`;

test('v1-coverage: an unmapped v1 item, a reference to nothing, an event nobody emits and a stale row fail; todo rows warn', async () => {
  const root = writeTree(
    new Map([
      ['docs/v1-routes.txt', 'GET /crew\nPOST /crew\nDELETE /crew/:id\nGET /later\nGET /health\n'],
      ['docs/v1-surface.txt', '# header\nmcp wisp_crew\ncli ls\nsetting theme\nsetting view\ntelemetry ship\ntelemetry merge\n'],
      ['plugins/crew/host/wisp-plugin.json', JSON.stringify({ wispPlugin: 1, id: 'wisp.crew', contributes: { commands: [{ id: 'crew.list', title: 'l' }] } })],
      ['plugins/crew/host/src/lib.rs', 'const R: (&str, &str) = ("GET", "/health");\nconst E: &str = "ship";\n#[cfg(test)]\nmod tests { const X: &str = "merge"; }\n'],
      ['plugins/mcp/core/defs/agent.json', JSON.stringify([{ name: 'wisp_crew' }])],
      ['crates/wisp/src/args.rs', 'pub const COMMANDS: [&str; 1] = ["ls"];\n'],
      ['plugins/telemetry/api/src/catalogue.json', JSON.stringify([{ name: 'ship' }, { name: 'merge' }])],
      [
        'docs/v2-coverage.md',
        [
          '| kind | v1 | v2 |',
          '|---|---|---|',
          row('route', 'GET /crew', 'cmd:crew.list'),
          row('route', 'POST /crew', 'cmd:crew.create'),
          row('route', 'GET /later', 'todo:later list'),
          row('route', 'GET /health', 'route:/health'),
          row('route', 'GET /gone', 'cmd:crew.list'),
          row('mcp', 'wisp_crew', 'mcp:wisp_crew'),
          row('cli', 'ls', 'cli:ls'),
          row('setting', 'theme', 'ui:settings store (light, dark)'),
          row('telemetry', 'ship', 'telemetry:ship'),
          row('telemetry', 'merge', 'telemetry:merge'),
        ].join('\n'),
      ],
      ['docs/v1-dropped.md', ['| kind | v1 | why |', '|---|---|---|', '| setting | `view` | gone in v1 already |'].join('\n')],
    ]),
  );
  const got = await messages(v1Coverage, root);
  const has = (s: string): boolean => got.some((m) => m.includes(s));
  assert.ok(has("v1's DELETE /crew/:id maps to nothing"), got.join('\n'));
  assert.ok(has('POST /crew: command crew.create is in no plugin manifest'));
  assert.ok(has('GET /gone is no v1 item'));
  assert.ok(has('telemetry event merge is in the catalogue but no plugin emits it'), 'a name only a test says is no emit');
  assert.ok(has('warn:v1-coverage 1 v1 items are still work'));
  assert.equal(got.length, 5, got.join('\n'));
});
