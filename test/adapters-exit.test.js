// A harness CLI that exits without reading its prompt (bad flag, crash on start) must end the
// turn with an error result, not take wisp down with an unhandled EPIPE on its stdin.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers.js';

const dir = tmp('exit-bin');
const bin = path.join(dir, 'quits');
fs.writeFileSync(bin, `#!${process.execPath}\nprocess.stderr.write('bad flag');\nprocess.exit(3);\n`);
fs.chmodSync(bin, 0o755);
for (const k of ['CLAUDE', 'CODEX', 'OPENCODE', 'CURSOR', 'ANTIGRAVITY', 'GROK', 'COPILOT']) process.env[`WISP_${k}_BIN`] = bin;
const { adapters } = await import('../server/adapters/index.js');

for (const id of Object.keys(adapters)) {
  test(`${id}: a CLI that quits before reading a large prompt ends the turn with its stderr`, { skip: process.platform === 'win32' }, async () => {
    const events = [];
    const run = adapters[id].run({ prompt: 'x'.repeat(4 * 1024 * 1024), cwd: dir, mode: 'edits', systemPrompt: 'p', onEvent: (e) => events.push(e) });
    await run.done;
    const results = events.filter((e) => e.type === 'result');
    assert.equal(results.length, 1);
    assert.equal(results[0].isError, true);
    assert.match(results[0].text, /bad flag|exited with/);
  });
}
