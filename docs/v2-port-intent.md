# Port the intent, not the bugs

The owner, 2026-11-08: *"v1 has bugs. Whenever something is ported, check for bugs, don't just port from v1.
Take the intent of the feature from v1, but it may be buggy in v1, so fix it in v2."*

## The rule

v1 is the reference for **what a feature is for and how it should look and behave** (parity: ADR-0016,
`docs/v1-edge-cases*.md`). It is **not** the reference for its defects. When a port meets v1 behaviour that
looks wrong, the port fixes it and says so.

## How every port does it

1. **Write down the intent first**, in one line per behaviour, in the plugin's README ("a Stop keeps queued
   follow-ups", "a question survives a restart"). Port against the intent, using v1's code as evidence.
2. **Look for v1's bugs in that area before porting:**
   - v1's known bugs: open issues and PRs (`gh issue list`, `gh pr list`), CHANGELOG *Fixed* entries that
     were patched around rather than fixed, flaky tests (AGENTS.md: "flaky means fixed"), `TODO`/`FIXME`/
     `XXX` comments in the v1 files;
   - the classes of bug v1 had (plan §4.6.1: two owners of state, races, late async answers, missing
     feedback, wrapping UI), which v2's architecture removes by construction: check the port really does;
   - anything the verifier or the lead finds while comparing v1 and v2 side by side or in a live run.
3. **When v1 is wrong, v2 does the intended thing**, with a test that would have failed on v1, and a line in
   `docs/v1-bugs-fixed.md` (area, what v1 did, what v2 does, the test). If it changes something a user sees,
   it also goes in `design/v1-reference/allowed.md`, so the parity gate accepts it.
4. **When it's unclear** whether v1's behaviour is a bug or a choice, keep v1's behaviour and list it under
   *Questions* in `docs/v1-bugs-fixed.md` for the owner. Never change behaviour silently.
5. The verifier checks each port for this: intent written, bugs looked for, fixes tested and listed.
