# ADR-0045: Grid mail checks DKIM itself, with hickory-resolver for the keys

- Status: accepted
- Date: 2026-11-11
- Source: the owner's round 7 brief ("grid mail, with its ADR line for the DNS resolver"); v1 grid/mail.js and
  grid/dkim.js; ADR-0041 (the grid is the hub). Adds a dependency, so it's recorded (AGENTS.md: a new Rust
  dependency is pinned in the root `Cargo.toml` and justified in an ADR).

## Context

Mail to a box's secret address can start an agent on someone's computer, so the grid has to prove who a message is
from before a box ever sees it. SES (the one inbound provider) can refuse a message but never proves one: its DMARC
PASS can rest on SPF (the envelope's domain), GRAY covers domains with no policy (gmail.com among them), and its
DKIM verdict never says which domain signed. v1 therefore verifies the DKIM signature itself, against the key in the
signer's DNS (`<selector>._domainkey.<domain>` TXT), and only a signature whose `d=` is the From's own domain is
`pass`. Everything else reaches the box as `unproved`, and the box refuses it.

That needs TXT lookups from Rust. The standard library resolves only addresses (`ToSocketAddrs`), and a DKIM key
record (a 2048-bit RSA key is ~400 bytes of base64) can exceed a classic 512-byte UDP answer, so a resolver has to
do EDNS0 and fall back to TCP.

## Decision

- **`hickory-resolver` 0.26** (MIT OR Apache-2.0; default features: the system's resolver configuration and tokio),
  used only by `apps/grid` (`mail/service.rs` `system_txt`). It reads `/etc/resolv.conf`, does EDNS0 and the TCP
  fallback, and caches answers. Each lookup is capped at 5 s.
- The lookup is injected (`dkim::Txt`): `dkim.rs` stays pure and its tests use fake DNS; a dev grid
  (`auth.dev`) may pin `mail.inbound.dkimKeys` instead of asking DNS, as in v1.
- A lookup that answers "no such record" (NXDOMAIN, no TXT) is a result (`unproved`); one that fails (timeout,
  SERVFAIL) for the From's own domain answers SNS with a 503, so it brings the message back.
- No DNSSEC: v1 had none either, and a forged key record still needs the forger to sit on the path between the grid
  and the signer's DNS; the verdict is about who sent the mail, not about keeping it secret.

## Alternatives

- **A hand-rolled DNS client** (one UDP query, parse the TXT answer): fewer dependencies, but EDNS0, truncation and
  the TCP retry, `resolv.conf`, and ID/port randomisation against spoofing are each a place to get wrong in
  security-critical code.
- **Trust SES's verdict:** it proves nothing about the From (see Context).
- **DNS over HTTPS** (`reqwest` is already a dependency): ties the grid to one public resolver and still needs a
  DNS-message parser.

## Consequences

- `cargo deny check` passes (licences MIT/Apache, no bans). Adds hickory-proto and hickory-net transitively.
- Where it reaches (ADR-0040): mail is a channel; it reaches the box's email transport (wisp-email) and, through
  it, the harness. Nothing else uses the resolver.
- Edge cases, each with a test in `apps/grid/src/dkim/tests.rs` or `mail/service_tests.rs`: a signature by another
  domain is `unproved`; no such key is a result; DNS down is a retry; `l=`, a missing `subject` in `h=`, an expired
  `x=`, `i=` outside `d=`, a key in testing mode (`t=y`), a key of another type, headers another parser could read
  another way (a bare LF, no end): refused.
