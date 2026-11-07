---
name: release
description: Use when cutting a wisp v2 release - bumping the version of the published package and letting release.yml publish npm, the desktop app, the GitHub release and the Homebrew tap.
---

# Release

1. The published package is `apps/server` (`wisp-agents`). Releasing is merging a PR that bumps its
   `version`, plus the strings that carry it: `apps/server/package.json`, `package-lock.json`, `README.md`,
   `docs/index.html`, `docs/install.sh`, `scripts/guides.mjs`.
2. Move CHANGELOG's *Unreleased* into `## [x.y.z] - YYYY-MM-DD`: `scripts/release-notes.mjs` drafts the GitHub
   release from that section.
3. `.agents/bin/monoflow verify --all` and `npm run check` pass before the PR is opened.
4. After the merge, `release.yml` sees a version npm doesn't have. It builds the bundle (`npm run build`),
   the desktop app and the wisp-native binaries, publishes npm and the `@wisp/native-*` packages, then
   publishes the release. Bump the Homebrew tap only after npm has the version.
5. A version with `-` (`2.0.0-beta.1`) is a beta: npm `next`, a prerelease, no Homebrew.
