# wisp.share

Sharing a task (ADR-0027 "Sharing in practice", ADR-0032). v1 shared a task only as a grid page.
Sharing scrubbed secrets but nothing else, and the receiver could only read it.

## Intent

- One file, `.wisp-task`, at the level the sharer picks:
  - `spec`: the ask and the formula it ran with;
  - `report`: plus its answers and the files it changed;
  - `full`: plus every turn with its steps.
  The bundle is signed and carries the wisp version and the harnesses it needs.
- Before anything leaves, `wisp share` shows exactly what goes and every redaction (wisp-share-core):
  - secrets by their shapes;
  - the values of the sharer's secret-looking environment variables;
  - the project folder as `<project>` and home as `~`;
  - other tasks' titles and crew names the sharer didn't choose.
  It sends nothing without `--yes` or a yes at the prompt.
- `--to file` (the default) or `--to gist` (secret, via `gh`).
- `wisp open <file|url|gist:<id>>` says who signed it (the key's fingerprint) and what's missing here. It
  refuses a bundle changed after signing. Then you pick:
  - `--run`: on your code, names resolved in your formula;
  - `--their-setup`: with the shared snapshot's agent;
  - `--compare`: both;
  - `--import` (`full` only): a read-only task you can fork.
  Everything made from a share links `sharedFrom` it.

## Not yet

- `--to link`: wisp Grid's share pages, with expiry, password and revoke.
- `--to <person or computer>`: over the peer protocol.
- Both need the grid client, which this build doesn't have.
- Team sharing from a formula (`share:`), and a trust store for signers' keys.
