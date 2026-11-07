// Builds src/priors.json, what Auto knows before your first task, from the public benchmark results
// in tools/priors-sources.json (v1 scripts/priors.mjs).
//
// Benchmarks don't share a scale, so each one is placed against arms whose chance is already known:
// the anchor (Claude Code's default, Opus 5.5 at medium) first, then whatever a benchmark pinned
// down, until nothing more can be placed. Rows about a predecessor (a note says so) count half.
//
//   node plugins/router/host/tools/priors.ts          write src/priors.json
//   node plugins/router/host/tools/priors.ts --check  fail if it's out of date with the sources

import { readFile, writeFile } from 'node:fs/promises';
import { buildPriors } from '../src/priors-build.ts';
import type { PriorSources } from '../src/priors-build.ts';

const src = JSON.parse(await readFile(new URL('./priors-sources.json', import.meta.url), 'utf8')) as PriorSources;
const built = buildPriors(src);
const out = `${JSON.stringify(built, null, 2)}\n`;
const file = new URL('../src/priors.json', import.meta.url);
if (process.argv.includes('--check')) {
  const now = (await readFile(file, 'utf8')).replace(/\r\n/g, '\n');
  if (now !== out) {
    console.error('plugins/router/host/src/priors.json is out of date: run node plugins/router/host/tools/priors.ts');
    process.exitCode = 1;
  } else console.log('priors.json is up to date');
} else {
  await writeFile(file, out);
  for (const [k, v] of Object.entries(built.arms)) console.log(`${k.padEnd(52)} ${(v.a / (v.a + v.b)).toFixed(2)}  $${v.usd.toFixed(2)}  ${v.min}m  ${v.from.join(', ')}`);
}
