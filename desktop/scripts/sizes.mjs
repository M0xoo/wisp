// What the Tauri artefacts in a folder weigh against the latest release's Electron ones, as markdown.
//   node desktop/scripts/sizes.mjs [dist/tauri]        (needs gh)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || 'dist/tauri';
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
const { tagName, assets } = JSON.parse(execFileSync('gh', ['release', 'view', '--repo', 'M0xoo/wisp', '--json', 'tagName,assets'], { encoding: 'utf8' }));
const rows = fs.readdirSync(dir).filter((f) => f.startsWith('wisp-')).sort();
console.log(`| Download | Tauri | Electron (${tagName}) | Tauri is |\n|---|---|---|---|`);
for (const f of rows) {
  const size = fs.statSync(path.join(dir, f)).size;
  const old = assets.find((a) => a.name === f)?.size;
  console.log(`| ${f} | ${mb(size)} | ${old ? mb(old) : 'none'} | ${old ? `${Math.round((size / old) * 100)}%` : ''} |`);
}
