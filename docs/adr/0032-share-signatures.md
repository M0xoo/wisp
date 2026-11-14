# ADR-0032: Shared tasks are signed with ed25519 in the wisp binary

- Status: accepted
- Date: 2026-11-08
- Source: ADR-0027 "Sharing in practice": a `.wisp-task` bundle is "signed with the sharer's peer key".
  ADR-0015 kept the grid's crypto crates out of the wisp binary; this changes that for one of them.

## Decision

- `wisp.share` signs every bundle with an ed25519 key using `ed25519-dalek` 2, the crate and version the
  grid already uses. No new crate enters the workspace, but it now ships in the wisp binary too.
- The key is made the first time something is shared: 32 random bytes from `rand`, kept in
  `secrets.json` as `share/key` (0600, never in the store). The public key travels in the bundle
  (`from.key`).
- `wisp open` checks the signature over the bundle's canonical bytes (its JSON without `sig`, keys
  sorted) and shows the key's fingerprint, so a receiver can compare it with the sharer. A bundle changed
  after signing is refused for run and import.
- There is no trust store yet. A key is shown, not vouched for. Grid sign-in will tie keys to people
  (`--to link`, `--to <peer>`).

## Consequences

- `cargo deny` sees nothing new. The binary grows by the crate (about 100 KB).
- Signing only uses our own key; verifying uses public keys. RUSTSEC-2023-0071 concerns `rsa`, not this
  crate, and `rsa` stays in apps/grid.
