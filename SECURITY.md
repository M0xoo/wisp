# Security

wisp runs coding agents on your code, and wisp Cloud runs them on our server, so we take reports
seriously.

## Reporting a vulnerability

Report it privately, not in a public issue:

- **GitHub:** [Report a vulnerability](https://github.com/M0xoo/wisp/security/advisories/new) (private advisory).
- **Email:** [hello@trywisp.dev](mailto:hello@trywisp.dev), with "security" in the subject.

Include what you found, how to reproduce it, and the version (`wisp --version`) or, for wisp Cloud,
the time it happened. We reply within three working days, keep you posted while we fix it, and
credit you in the release notes if you'd like.

## What's in scope

- wisp itself: the local server, the page, the CLI, the desktop app and the Android app.
- wisp Grid and the hosted wisp Cloud at `grid.trywisp.dev`: sign-in, the edge, the tunnel and
  the isolation between users' boxes.
- The install script at `https://trywisp.dev/install.sh` and the release downloads.

Spells are meant to be sandboxed (no network, no page, no wisp API): a way out of that sandbox is in
scope too.

## Supported versions

Fixes land in the latest release. Update with `npm install -g wisp-agents@latest`, or let the app
update itself.
