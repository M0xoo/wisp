#!/usr/bin/env node
// The GitHub release body for a version: its CHANGELOG.md section, then how to get it.
//   node scripts/release-notes.mjs 0.37.0 > notes.md
// Exits 1 when CHANGELOG.md has no section for that version, so a bump without notes doesn't ship.
// A nightly (the rolling `nightly` release) gets what's under Unreleased, and the commit it built:
//   node scripts/release-notes.mjs --nightly 0.37.1-nightly.20261024.317 <sha> > notes.md

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = 'https://github.com/M0xoo/wisp';
const DL = `${REPO}/releases/latest/download`;
const NIGHTLY = `${REPO}/releases/download/nightly`;

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

${table(version, DL, `\`npx wisp-agents@${version}\` or \`npm install -g wisp-agents\``)}| **Homebrew** | \`brew install m0xoo/tap/wisp-agents\` |

The desktop app updates itself from these releases. Checksums are in \`SHA256SUMS.txt\`.
`;
}

// Nightlies are untested beyond CI: say so, say what's in them, and link the rolling downloads.
export function nightlyNotes(changelog, version, sha) {
  const body = section(changelog, 'Unreleased') || 'Nothing new under Unreleased in CHANGELOG.md yet.';
  return `A build of \`main\` at [${String(sha).slice(0, 7)}](${REPO}/commit/${sha}), made every night once the full test suite passes there. It may break: for everyday use, take the [latest release](${REPO}/releases/latest).

## Since the last release

${body}

${table(version, NIGHTLY, `\`npx wisp-agents@nightly\` or \`npm install -g wisp-agents@nightly\``)}
To keep getting these, set **Settings → General → Updates** to *Nightly*. Checksums are in \`SHA256SUMS.txt\`.
`;
}

function table(version, dl, npm) {
  return `## Get wisp ${version}

| | |
|---|---|
| **macOS** (Apple silicon) | [wisp-mac-arm64.dmg](${dl}/wisp-mac-arm64.dmg) |
| **macOS** (Intel) | [wisp-mac-x64.dmg](${dl}/wisp-mac-x64.dmg) |
| **Windows** | [wisp-windows-x64-setup.exe](${dl}/wisp-windows-x64-setup.exe) · [Arm](${dl}/wisp-windows-arm64-setup.exe) |
| **Linux** | [AppImage](${dl}/wisp-linux-x64.AppImage) · [.deb](${dl}/wisp-linux-x64.deb) · Arm: [AppImage](${dl}/wisp-linux-arm64.AppImage), [.deb](${dl}/wisp-linux-arm64.deb) |
| **npm** (Node 20+) | ${npm} |
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--nightly') {
  const changelog = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  process.stdout.write(nightlyNotes(changelog, process.argv[3], process.argv[4] || 'main'));
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = String(process.argv[2] || '').replace(/^v/, '');
  const changelog = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const out = version && notes(changelog, version);
  if (!out) {
    console.error(`CHANGELOG.md has no notes for ${version || '(no version given)'}: add a "## [${version || 'x.y.z'}] - date" section.`);
    process.exit(1);
  }
  process.stdout.write(out);
}
