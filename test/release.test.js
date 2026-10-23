// The release: notes from CHANGELOG.md, and the desktop build shipping what npm ships.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { section, notes, nightlyNotes } from '../scripts/release-notes.mjs';
import { nightlyVersion } from '../scripts/nightly-version.mjs';
import { newer } from '../server/update.js';

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

test('a nightly is the next patch, stamped with the UTC date and time, and sorts where it should', () => {
  const at = new Date('2026-10-24T03:17:42Z');
  assert.equal(nightlyVersion('0.37.0', at), '0.37.1-nightly.20261024.317');
  assert.equal(nightlyVersion('0.38.0-beta.1', at), '0.38.0-nightly.20261024.317'); // heads for 0.38.0
  assert.equal(nightlyVersion('0.37.0', new Date('2026-10-24T00:05:00Z')), '0.37.1-nightly.20261024.5'); // no leading zero
  assert.throws(() => nightlyVersion('banana'), /not a version/);
  const n = nightlyVersion('0.37.0', at);
  assert.ok(newer(n, '0.37.0') && newer('0.37.1', n));
  assert.ok(newer(nightlyVersion('0.37.0', new Date('2026-10-25T03:17:00Z')), n)); // tomorrow's wins
});

test('nightly notes carry Unreleased, the commit, and the rolling download links', () => {
  const body = nightlyNotes(CHANGELOG, '1.2.1-nightly.20261024.317', 'abcdef1234567890');
  assert.match(body, /\[abcdef1\]\(https:\/\/github\.com\/M0xoo\/wisp\/commit\/abcdef1234567890\)/);
  assert.match(body, /## Since the last release\n\n- next\n/);
  assert.match(body, /## Get wisp 1\.2\.1-nightly\.20261024\.317/);
  assert.match(body, /releases\/download\/nightly\/wisp-mac-arm64\.dmg/);
  assert.doesNotMatch(body, /releases\/latest\/download/);
  assert.match(body, /wisp-agents@nightly/);
  assert.doesNotMatch(body, /brew install/); // the tap only has stable releases
  assert.match(nightlyNotes('# Changelog\n', '1.0.1-nightly.1.1', 'abc'), /Nothing new under Unreleased/);
});

test('the release workflow publishes nightlies from itself, after the nightly tests, on npm\'s nightly tag', () => {
  const wf = read('.github/workflows/release.yml');
  // npm allows one trusted publisher per package: release.yml with environment npm.
  assert.match(wf, /workflow_run:\n\s+workflows: \[nightly\]\n\s+types: \[completed\]\n\s+branches: \[main\]/);
  assert.match(wf, /scripts\/nightly-version\.mjs/);
  assert.match(wf, /tag=nightly/);
  assert.match(wf, /release-notes\.mjs --nightly/);
  assert.match(wf, /--prerelease --latest=false/); // never the release the site and the stable updater see
  assert.match(wf, /main hasn't moved since the last nightly/);
  assert.equal([...wf.matchAll(/environment: npm/g)].length, 1);
  assert.match(read('.github/workflows/nightly.yml'), /^name: nightly$/m); // what workflow_run listens for
});
