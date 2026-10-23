#!/usr/bin/env node
// The version of tonight's build of main: the next patch after package.json's release (or the
// release a prerelease leads to), then nightly.<date>.<time> in UTC, so it sorts after every
// release and beta before it, before the release it leads to, and after last night's.
//   node scripts/nightly-version.mjs            # 0.37.1-nightly.20261024.317
//   node scripts/nightly-version.mjs 0.38.0-beta.1   # 0.38.0-nightly.…

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function nightlyVersion(version, now = new Date()) {
  const [core, pre] = String(version).replace(/^v/, '').split('+')[0].split(/-(.*)/);
  const v = core.split('.').map(Number);
  if (v.length !== 3 || v.some((n) => !Number.isInteger(n) || n < 0)) throw new Error(`not a version: ${version}`);
  if (!pre) v[2]++;
  const iso = now.toISOString();
  const day = iso.slice(0, 10).replace(/-/g, '');
  const time = Number(iso.slice(11, 13) + iso.slice(14, 16)); // a number: no leading zero in semver
  return `${v.join('.')}-nightly.${day}.${time}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2] || JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  console.log(nightlyVersion(version));
}
