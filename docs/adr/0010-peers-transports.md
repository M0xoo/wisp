# ADR-0010: Peers and transports, and one bundle on every device

- Status: accepted
- Date: 2026-11-07
- Source: wisp v2 rewrite plan, draft 9

## Context

v1 had six separate connection paths, and the phone showed each computer's own page in a WebView (plan §7.2).

## Decision

- Every wisp is a **peer** with a stable `peer_id`, and ids carry their origin. A client subscribes to each peer's topics with its own cursor and merges them in one store. Commands go to the peer that owns the id, with the same idempotency key.
- How a peer is reached is a transport plugin (`machines.transport@1`): `ssh` (system OpenSSH), `grid`, `grid-tunnel`. A passive subscription never wakes a box or keeps it up.
- The browser, the Tauri desktop app and the Android app (Capacitor + sshj, Java unchanged) all run **the same web bundle**. The apps ship it inside, so the first paint never waits on a tunnel.

## Consequences

Version skew is handled by the window in ADR-0005. A plugin whose UI the app doesn't ship is served by its peer, content-hashed, at its trust level.
