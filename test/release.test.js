// The release: notes from CHANGELOG.md, and the desktop build shipping what npm ships.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { section, notes } from '../scripts/release-notes.mjs';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const CHANGELOG = `# Changelog\n\n## [Unreleased]\n\n- next\n\n## [1.2.0] - 2026-10-23\n\n### Added\n\n- **A thing.** It works.\n\n## [1.1.0] - 2026-10-01\n\n- older\n`;

test('release notes are the version\'s CHANGELOG section, CRLF or not', () => {
  for (const text of [CHANGELOG, CHANGELOG.replace(/\n/g, '\r\n')]) {
    assert.equal(section(text, '1.2.0'), '### Added\n\n- **A thing.** It works.');
    assert.equal(section(text, '1.1.0'), '- older');
  }
  assert.equal(section(CHANGELOG, '1.3.0'), null);
  assert.equal(notes(CHANGELOG, '1.3.0'), null);
  const body = notes(CHANGELOG, '1.2.0');
  assert.match(body, /^### Added/);
  assert.match(body, /## Get wisp 1\.2\.0/);
  assert.match(body, /npx wisp-agents@1\.2\.0/);
});

test('the current version has release notes', () => {
  const { version } = JSON.parse(read('package.json'));
  assert.ok(notes(read('CHANGELOG.md'), version), `CHANGELOG.md needs a "## [${version}]" section`);
});

test('the desktop app ships the files npm ships, and the downloads keep their names', () => {
  const config = read('packaging/desktop/electron-builder.yml');
  const files = [...config.matchAll(/^ {2}- ([\w.-]+(?:\/\*\*)?)$/gm)].map((m) => m[1].replace('/**', '/'));
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(files.filter((f) => f !== 'package.json').sort(), [...pkg.files].sort());
  // The site, the release notes and the app's updater link to these names (releases/latest/download/…).
  for (const name of ['wisp-mac-${arch}.${ext}', 'wisp-mac-${arch}.dmg', 'wisp-windows-${arch}-setup.${ext}', 'wisp-linux-${arch}.${ext}']) assert.ok(config.includes(`artifactName: ${name}`), name);
  const linked = [...notes(read('CHANGELOG.md'), pkg.version).matchAll(/download\/(wisp-[\w.-]+)\)/g)].map((m) => m[1]);
  assert.ok(linked.length >= 8);
  for (const f of linked) assert.match(f, /^wisp-(mac-(arm64|x64)\.dmg|windows-(arm64|x64)-setup\.exe|linux-(arm64|x64)\.(AppImage|deb))$/);
});

test('the release workflow builds with that config and publishes last', () => {
  const wf = read('.github/workflows/release.yml');
  assert.match(wf, /--config packaging\/desktop\/electron-builder\.yml/);
  assert.match(wf, /scripts\/release-notes\.mjs/);
  assert.match(wf, /gh release create "\$TAG" --draft/);
  assert.match(wf, /needs: \[plan, release, npm\]/); // the release goes public after npm
});
