#!/usr/bin/env node
// The GitHub release body for a version: its CHANGELOG.md section, then how to get it.
//   node scripts/release-notes.mjs 0.37.0 > notes.md
// Exits 1 when CHANGELOG.md has no section for that version, so a bump without notes doesn't ship.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const DL = 'https://github.com/M0xoo/wisp/releases/latest/download';

// The lines under `## [version]`, up to the next `## [`. CRLF in, LF out (Windows checkouts).
export function section(changelog, version) {
  const lines = changelog.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## ['));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim() || null;
}

export function notes(changelog, version) {
  const body = section(changelog, version);
  if (!body) return null;
  return `${body}

## Get wisp ${version}

| | |
|---|---|
| **macOS** (Apple silicon) | [wisp-mac-arm64.dmg](${DL}/wisp-mac-arm64.dmg) |
| **macOS** (Intel) | [wisp-mac-x64.dmg](${DL}/wisp-mac-x64.dmg) |
| **Windows** | [wisp-windows-x64-setup.exe](${DL}/wisp-windows-x64-setup.exe) · [Arm](${DL}/wisp-windows-arm64-setup.exe) |
| **Linux** | [AppImage](${DL}/wisp-linux-x64.AppImage) · [.deb](${DL}/wisp-linux-x64.deb) · Arm: [AppImage](${DL}/wisp-linux-arm64.AppImage), [.deb](${DL}/wisp-linux-arm64.deb) |
| **npm** (Node 20+) | \`npx wisp-agents@${version}\` or \`npm install -g wisp-agents\` |
| **Homebrew** | \`brew install m0xoo/tap/wisp-agents\` |

The desktop app updates itself from these releases. Checksums are in \`SHA256SUMS.txt\`.
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = String(process.argv[2] || '').replace(/^v/, '');
  const changelog = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const out = version && notes(changelog, version);
  if (!out) {
    console.error(`CHANGELOG.md has no notes for ${version || '(no version given)'}: add a "## [${version || 'x.y.z'}] - date" section.`);
    process.exit(1);
  }
  process.stdout.write(out);
}
