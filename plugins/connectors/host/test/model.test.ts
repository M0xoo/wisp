// The pure part of v1's test/connectors.test.js: command lines, the checks on a body, Codex's TOML.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexServers } from '../src/harness-config.ts';
import { normalizeConnector, splitCommand, type Bad } from '../src/model.ts';

test('a command line is split like a shell would', () => {
  assert.deepEqual(splitCommand(`npx -y @x/server --root '/a b' "c d" ''`), ['npx', '-y', '@x/server', '--root', '/a b', 'c d', '']);
});

test('names, transports and secrets are checked, with reasons', () => {
  const ok = normalizeConnector({ name: 'My GitHub', command: 'npx -y @x/github', env: { GITHUB_TOKEN: 'ghp_x' } }, []);
  assert.equal(ok.connector.name, 'my_github');
  assert.equal(ok.connector.command, 'npx');
  assert.deepEqual(ok.connector.args, ['-y', '@x/github']);
  assert.deepEqual(ok.connector.env, ['GITHUB_TOKEN']);
  assert.deepEqual(ok.sets, [['env:GITHUB_TOKEN', 'ghp_x']]);
  assert.ok(!JSON.stringify(ok.connector).includes('ghp_x'), 'the value is not in the connector');
  const refuse = (body: unknown, re: RegExp, list: Parameters<typeof normalizeConnector>[1] = []): void =>
    assert.throws(() => normalizeConnector(body, list), (e: Bad) => e.status === 400 && re.test(e.message));
  refuse({ name: '', command: 'x' }, /name/);
  refuse({ name: 'wisp', command: 'x' }, /wisp/);
  refuse({ name: 'gh', command: 'x' }, /already/, [{ id: 'a', name: 'gh', transport: 'local', env: [], headers: [], enabled: true, addedAt: 0 }]);
  refuse({ name: 'x', transport: 'local' }, /command/);
  refuse({ name: 'x', transport: 'remote', url: 'ftp://h' }, /https/);
  refuse({ name: 'x', transport: 'carrier-pigeon' }, /local or remote/);
  refuse({ name: 'x', command: `npx srv --token ghp_${'a'.repeat(36)}` }, /GitHub token.*env var/);
  refuse({ name: 'x', url: 'https://u:secretpw@h.example/mcp' }, /password in a URL.*header/);
  refuse({ name: 'x', command: 'y', env: { 'BAD KEY': '1' } }, /Env var name/);
  refuse({ name: 'x', command: 'y', env: [{ key: 'A', value: '1' }, { key: 'A', value: '2' }] }, /there twice/);
  // Editing: an empty value keeps the saved one; a key left out is gone.
  const was = { ...ok.connector };
  const edit = normalizeConnector({ env: { GITHUB_TOKEN: '', OTHER: 'v' } }, [was], was);
  assert.deepEqual(edit.sets, [['env:OTHER', 'v']]);
  assert.deepEqual(edit.connector.env, ['GITHUB_TOKEN', 'OTHER']);
  // A sign-in belongs to the server it was for: another URL drops it.
  const remote = normalizeConnector({ name: 'r', url: 'https://a.example/mcp' }, []).connector;
  remote.oauth = { issuer: 'https://a.example', authorize: '', token: '', register: null, scopes: [], resource: '' };
  assert.ok(normalizeConnector({ url: 'https://a.example/mcp' }, [remote], remote).connector.oauth);
  assert.equal(normalizeConnector({ url: 'https://b.example/mcp' }, [remote], remote).connector.oauth, undefined);
});

test('Codex’s config.toml servers are read', () => {
  const s = codexServers(`model = "o3"
[mcp_servers.docs]
command = "npx"
args = ["-y", "mcp-docs", 'x y']
env = { "API_KEY" = "k1", OTHER = 'k2' }

[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
bearer_token = "tok"
[mcp_servers.linear.http_headers]
X-Team = "eng"
[profiles.x]
command = "nope"
`);
  assert.deepEqual(s['docs'], { command: 'npx', args: ['-y', 'mcp-docs', 'x y'], env: { API_KEY: 'k1', OTHER: 'k2' } });
  assert.equal(s['linear']?.['url'], 'https://mcp.linear.app/mcp');
  assert.deepEqual(s['linear']?.['http_headers'], { 'X-Team': 'eng' });
  assert.equal(Object.keys(s).length, 2);
});
