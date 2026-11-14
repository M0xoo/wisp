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

## Edge cases (added 2026-11-09)

Each one is a test named after it (v1's rules from `docs/v1-edge-cases.md`, "Machines and the grid client").
- `device_sign_in_follows_rfc_8628`: a code is pending until approved, polling faster than its interval answers
  `slow_down` (and the client adds 5 s), an approved code gives one device token once, a used or expired code is
  refused, and the token is kept in secrets, never in a row.
- `a_denied_sign_in_stops`: declined in the browser, the client stops polling and says so.
- `the_tunnel_redials_1_2_5_15_30`: a dropped tunnel redials after 1, 2, 5, 15, then every 30 s, and the count
  resets once it is up; `a_tunnel_401_or_404_is_gone`: those answers stop the redials (the device or computer is gone).
- `a_tunnel_request_looks_local`: hop-by-hop headers stripped, Host set to this computer's loopback, Origin
  dropped, and a random `x-wisp-tunnel` mark added that only this process knows (compared in constant time).
- `a_new_tunnel_for_the_same_computer_wins`: a computer that redials replaces its old tunnel on the grid.
- `previews_pass_only_when_the_setting_is_on`: a `p<port>--` request reaches a port on the computer only while
  "Show local pages in previews" is on there; otherwise 403 with why.
- `a_box_never_gets_a_laptop_token`: a box's credential is refused on a computer and on the tunnel route at
  the grid, and `wisp computer on` refuses to run on a box (`WISP_BOX`).
- `a_passive_request_never_wakes_a_box`: a passive request (`x-wisp-passive`, the sync stream of a watching
  peer) to a stopped box answers 503 asleep and leaves it stopped; `a_real_request_wakes_a_sleeping_box`: a
  command starts it and is answered once it is up.
