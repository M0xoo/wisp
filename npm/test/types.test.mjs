// client.d.ts must keep type-checking a realistic usage under strict settings. Uses the repo's
// TypeScript when it is installed; the published package itself never needs it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TSC = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url));
const USAGE = fileURLToPath(new URL('./fixtures/client-usage.ts', import.meta.url));

test('client.d.ts type-checks under tsc --strict', { skip: fs.existsSync(TSC) ? false : 'typescript is not installed (npm install)' }, () => {
  const flags = ['--strict', '--noEmit', '--exactOptionalPropertyTypes', '--noUncheckedIndexedAccess', '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--lib', 'es2022', '--types', 'node'];
  const r = spawnSync(process.execPath, [TSC, ...flags, USAGE], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
