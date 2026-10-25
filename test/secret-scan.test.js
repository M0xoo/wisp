// The secret scan run on anything shared off this computer (a crew member's .crew.json, a gist).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanAll, scanSecrets } from '../server/secret-scan.js';

test('finds keys and tokens by line, and says what they look like, never the secret', () => {
  const text = [
    'Watch CI on main.',
    'Use the token ghp_' + 'a'.repeat(36) + ' for gh.',
    'AWS: AKIA' + 'B'.repeat(16),
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'export ANTHROPIC_API_KEY=sk-ant-' + 'x'.repeat(40),
    'db: postgres://me:hunter22@db.local/app',
    'SLACK_BOT_TOKEN = "xoxb-' + '1'.repeat(24) + '"',
    'stripe sk_live_' + 'Z'.repeat(24),
    'api_key: "' + 'q'.repeat(32) + '"',
  ].join('\n');
  const hits = scanSecrets(text);
  assert.deepEqual(
    hits.map((h) => [h.line, h.what]),
    [
      [2, 'a GitHub token'],
      [3, 'an AWS access key'],
      [4, 'a private key'],
      [5, 'an Anthropic API key'],
      [6, 'a password in a URL'],
      [7, 'a Slack token'],
      [8, 'a Stripe key'],
      [9, 'a secret value'],
    ],
  );
  assert.ok(!JSON.stringify(hits).includes('hunter22'), 'the secret itself is never repeated');
});

test('leaves ordinary briefs, placeholders and env var names alone', () => {
  const text = [
    'Read the token from $GITHUB_TOKEN, never paste it.',
    'api_key: <your key here>',
    'password = ${DB_PASSWORD}',
    'TOKEN=your-token-goes-here-please',
    'Run `gh run list --limit 20` and look at the failed ones.',
    'The commit a1b2c3d4e5f6a7b8c9d0 fixed it.',
    'https://github.com/acme/repo/pull/42',
  ].join('\n');
  assert.deepEqual(scanSecrets(text), []);
  assert.deepEqual(scanSecrets(''), []);
  assert.deepEqual(scanSecrets(undefined), []);
});

test('scanAll names where each hit is', () => {
  const hits = scanAll({ 'Scout · brief': 'ok', 'Scout · notebook': 'line one\nkey AKIA' + 'C'.repeat(16) });
  assert.deepEqual(hits, [{ where: 'Scout · notebook', line: 2, what: 'an AWS access key' }]);
});
