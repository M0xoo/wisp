# Contributing to wisp

Thanks for helping. Bug reports, harness adapters, spells and fixes are all welcome.

## Before you start

- **Bugs:** open an [issue](https://github.com/M0xoo/wisp/issues/new/choose) with the version
  (`wisp --version`), your OS, the harness and what you expected to happen.
- **Bigger changes:** open an issue first so we can agree on the shape before you write it.
- **Security issues:** don't open an issue; see [SECURITY.md](SECURITY.md).

## Working on the code

```sh
git clone https://github.com/M0xoo/wisp && cd wisp
npm install
npm run dev:web     # the server with the page, restarts on server changes
npm test            # everything
```

[AGENTS.md](AGENTS.md) explains how the code is laid out and the rules a change has to follow
(it's written for coding agents, and for people). In short:

- No new runtime dependencies. The server is plain Node, the page is vanilla JS with no build step.
- Every piece of UI you add must be reachable from a spell (`web/js/spell-schema.js`).
- New test files go in the `test` script in `package.json`, or `npm test` skips them.
- User-facing changes get a line under *Unreleased* in [CHANGELOG.md](CHANGELOG.md).

## Pull requests

`main` is protected: work on a branch and open a PR. CI runs the suite on Linux; label it `ci:full`
when it touches process launching, paths, shells or terminals. Keep a PR to one change, and say
how you tested it.

By contributing you agree your work is released under the [MIT licence](LICENSE).
