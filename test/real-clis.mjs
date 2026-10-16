#!/usr/bin/env node
// Smoke test against the REAL harness CLIs installed on this machine (npm run test:real).
// No accounts needed: it checks that wisp can find and start each CLI on this OS (npm .cmd
// shims on Windows, PowerShell installers, …), that the CLI receives our arguments, and that
// whatever comes back (usually "not logged in" in CI) arrives as exactly one result.
//
//   WISP_REAL_REQUIRE=claude,codex   fail if these aren't detected (default: none required)
//   WISP_REAL_TIMEOUT=90000          per-agent run timeout in ms

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const { adapters } = await import('../server/adapters/index.js');
const { systemPrompt } = await import('../server/protocol.js');

const required = (process.env.WISP_REAL_REQUIRE || '').split(',').filter(Boolean);
const timeout = Number(process.env.WISP_REAL_TIMEOUT) || 90_000;
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-real-'));
execFileSync('git', ['init', '-q'], { cwd });
fs.writeFileSync(path.join(cwd, 'README.md'), '# scratch\n');

let failed = false;
const rows = [];
for (const a of Object.values(adapters)) {
  const found = await a.detect();
  if (!found.available) {
    rows.push([a.id, 'not installed', found.error?.split('\n')[0] || '']);
    if (required.includes(a.id)) failed = true;
    continue;
  }
  const events = [];
  const handle = a.run({
    prompt: 'Reply with the single word: pong',
    cwd,
    mode: 'plan',
    model: '',
    resumeId: null,
    attachments: [],
    mcpServers: {},
    systemPrompt: systemPrompt({ askTool: a.askTool }),
    onEvent: (e) => events.push(e),
  });
  const timer = setTimeout(() => handle.stop(), timeout);
  await handle.done;
  clearTimeout(timer);

  const results = events.filter((e) => e.type === 'result');
  const r = results[0];
  const startFailure = r?.text?.startsWith('Could not start');
  const ok = results.length === 1 && !startFailure;
  if (!ok) failed = true;
  const outcome = !r ? 'NO RESULT' : r.stopped ? 'timed out (stopped)' : r.isError ? 'ran, returned an error' : 'ran, succeeded';
  rows.push([a.id, `${found.version} · ${(found.models || a.models).length} models`, `${ok ? 'OK' : 'FAIL'}: ${outcome}${r?.text ? ` — ${r.text.replace(/\s+/g, ' ').slice(0, 140)}` : ''}`]);
}

for (const [id, version, outcome] of rows) console.log(`${id.padEnd(9)} ${version.padEnd(42)} ${outcome}`);
if (failed) {
  console.error('\nreal-CLI smoke test failed');
  process.exit(1);
}
