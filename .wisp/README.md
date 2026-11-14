# .wisp

This repo's agent setup and history (wisp, ADR-0033/0034):

- `*.wisp.yml`: the formula (agents, crew, workflows, rules).
- `tasks/`: one file per task that built this code (`<id>.task.yml`, `<id>.report.md`), and `history/<id>.jsonl.zst`, its transcript, scrubbed.
- `lock.yml`: the modules' pinned versions.

`wisp log`, `wisp blame <file>:<line>`, `wisp tasks --touching <path>`, `wisp resume <id>`.
