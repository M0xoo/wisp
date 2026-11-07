// The secret scan run on anything shared off this computer (a crew member's .crew.json, a gist).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, scanAll, scanSecrets } from '../server/secret-scan.js';

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

// Built here, not written out: a realistic token in a file stops the push.
const discordToken = (id = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTA') => [id, 'GaBc1D', 'a1B2c3'.repeat(6)].join('.');

test('a Discord bot token, old and new, is one; what it’s taken out of stays', () => {
  for (const id of ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTA', 'OTg3NjU0MzIxMDk4NzY1NDMyMQ', 'Nzg5MDEyMzQ1Njc4OTAxMjM0NQ']) {
    assert.deepEqual(scanSecrets(`bot: ${discordToken(id)} works`), [{ line: 1, what: 'a Discord bot token' }]);
  }
  const { text, hits } = redactSecrets(`DISCORD_TOKEN=${discordToken()}\nnext line`);
  assert.equal(hits, 1);
  assert.equal(text, 'DISCORD_TOKEN=[redacted: a Discord bot token]\nnext line');
});

test('a JWT stays a JWT, and dotted names aren’t tokens', () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = [b64({ alg: 'HS256', typ: 'JWT' }), b64({ sub: '1234567890', name: 'Someone', iat: 1516239022 }), 'x'.repeat(43)].join('.');
  assert.deepEqual(scanSecrets(jwt), [{ line: 1, what: 'a JSON Web Token' }]);
  const dotted = [
    'my_very_long_python_package_name.models.AnotherVeryLongClassNameForTests',
    'some-really-long-kebab-case-name.config.another-really-long-kebab-case-name',
    'test/channel-discord.test.js and server/channels/discord.js',
    'com.example.application.service.impl.UserServiceImplementationFactory',
    'www.a-very-long-subdomain-name-for-testing.github.another-very-long-name-for-it.io',
    'See section 1.2.3 of the 2026.11.07 notes.',
  ].join('\n');
  assert.deepEqual(scanSecrets(dotted), []);
});

test('scanAll names where each hit is', () => {
  const hits = scanAll({ 'Scout · brief': 'ok', 'Scout · notebook': 'line one\nkey AKIA' + 'C'.repeat(16) });
  assert.deepEqual(hits, [{ where: 'Scout · notebook', line: 2, what: 'an AWS access key' }]);
});
