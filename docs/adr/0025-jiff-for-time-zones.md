# ADR-0025: `jiff` resolves IANA time zones (host crates only)

- Status: accepted
- Date: 2026-11-08
- Source: the lead's decision on later's times (docs/v1-bugs-fixed.md): store UTC, format in the client's
  IANA time zone sent with settings, falling back to the server's zone.

## Decision

- **`jiff` 0.2** (MIT / Unlicense, no unsafe in the API we use) is the workspace's time-zone library. It
  reads the system's zoneinfo on Unix and bundles the IANA database on Windows (`tzdb-bundle-platform`).
- Only **host** crates use it, to turn a zone name and an instant into an offset. `core` crates stay sans-IO
  and keep taking a minute offset (`tz: i32`), as `wisp-later-core` does.
- A zone name that doesn't resolve falls back to the server's own zone, then to UTC.

## Consequences

Times written for the user (reminders, the agent's "scheduled for") follow their zone and its daylight
saving, with no hand-written offset tables. One more dependency, checked by `cargo deny`.
