// Builds server/router-priors.json, what Auto knows before your first task, from the public
// benchmark results in scripts/priors-sources.json.
//
// Benchmarks don't share a scale, so each one is placed against arms whose chance is already
// known: the anchor (Claude Code's default, Opus 5.5 at medium) first, then whatever a benchmark
// pinned down, until nothing more can be placed. An arm's chance is the average over the
// benchmarks that placed it. Rows about a predecessor (a note says so) count half.
//
//   node scripts/priors.mjs          write server/router-priors.json
//   node scripts/priors.mjs --check  fail if it's out of date with the sources

import fs from 'node:fs';
import { buildPriors } from '../server/priors-build.js';

const src = JSON.parse(fs.readFileSync(new URL('./priors-sources.json', import.meta.url), 'utf8'));
const out = `${JSON.stringify(buildPriors(src), null, 2)}\n`;
const file = new URL('../server/router-priors.json', import.meta.url);
if (process.argv.includes('--check')) {
  const now = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  if (now !== out) {
    console.error('server/router-priors.json is out of date: run node scripts/priors.mjs');
    process.exit(1);
  }
  console.log('router-priors.json is up to date');
} else {
  fs.writeFileSync(file, out);
  const p = JSON.parse(out);
  for (const [k, v] of Object.entries(p.arms)) console.log(`${k.padEnd(52)} ${(v.a / (v.a + v.b)).toFixed(2)}  $${v.usd.toFixed(2)}  ${v.min}m  ${v.from.join(', ')}`);
}
