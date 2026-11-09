# ADR-0037: Peers, channels and API keys: what the new hosts decided

- Status: accepted
- Date: 2026-11-09
- Builds on ADR-0003 (plugins), 0010 (machines and peers), 0028 (resource kinds), 0031 (no v1 compat).

## Decision

1. **wisp.machines ships a `loopback` transport** next to `ssh`: a peer wisp on this computer (another
   `WISP_HOME`, another port), reached directly over the same sync link ssh runs over its `-L` forward.
   Only `127.0.0.1`, `localhost` and `::1` are accepted. It is how the two-wisp e2e test runs without an
   ssh server, and it serves a second home on one computer.
2. **wisp.machines keeps its own HTTP client** (the workspace's `reqwest`, no proxy, loopback or the ssh
   forward only): a peer's sync stream is a long-lived streamed response, and the kernel's net service
   answers whole bodies. Every other plugin still goes through the net service.
3. **The channels hub is in memory over the resources.** A `channel` resource is a transport's config
   (its `token` and the `routing` object's settings, `${secret:}` read at apply and at start, never
   stored); one channel per transport; all off by default. A transport's own state (ntfy's poll cursor)
   lives in the hub for the process. Notifications go to a declared channel or a webhook URL.
4. **An API key is a declared capability set's `key`.** The kernel keeps key → `custom:<name>` in memory
   (`Ctx::define_capability_key`, `kernel:caps`); the edge reads `x-wisp-key` and the request speaks with
   that set. An unknown key is refused like a bad token. Keys stay in secrets.

## Why

Each is the smallest thing that makes the kind act end to end with no network in tests; none adds a
dependency (reqwest is already the workspace's).

## Consequences

- A loopback peer is a real peer: it shows on the machines topic like any other.
- A second HTTP client exists in one crate; `tools/check` keeps it there.
- Restarting wisp re-reads channels and keys from the resources and secrets; ntfy resumes from "now".
