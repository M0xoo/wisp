# wisp-bench

Measures harness × model pairs on real tasks, graded by hidden tests, through wisp's own adapters
(`server/adapters/*`). Auto's shipped starting point (`server/router-priors.json`) comes from these runs.

## Task sources

| source | what | grader | runs natively? |
|---|---|---|---|
| `swe` | [SWE-bench Verified](https://www.swebench.com) instances from django, sympy and pytest (stratified by difficulty) | FAIL_TO_PASS / PASS_TO_PASS with the hidden test patch, swebench 3.x log parsers | yes: one uv virtualenv per task, no Docker |
| `hb` | [Harness-Bench](https://github.com/Qihoo360/harness-bench) tasks that need only python3/git/sqlite3, no LLM judge | the suite's own hidden oracles (`safe_score_workspace`) | yes: its prepare scripts and oracles run locally |
| `wisp` | merged wisp PRs that came with tests (`wisp-tasks.json`) | the PR's own tests, applied after the agent finishes | yes |

Every task starts from a snapshot with no git history (`git archive` of the parent commit), so an agent
can't look up the real fix. Answer-bearing data (the SWE-bench dataset, the Harness-Bench checkout)
lives in `~/.wisp-bench-private/`, and each job runs in its own random dir under `/tmp/wbj/`. Tool calls
that reach outside the job dir are recorded as `leaks`.

## Per run

1. The agent works in auto mode with wisp's system prompt (no `ask_user`, so nobody to ask).
2. **Gate**: wisp's own check, without the hidden tests. For `swe` that's the pre-existing tests near the
   change plus any tests the agent added; for `wisp` it's the project's test files. A run fails the gate
   when a test that passed before now fails, or a new test fails. `hb` has no gate.
3. **Hidden grade** of that attempt.
4. Gate failed → **one repair round**: the session is resumed with the failures, then gated and graded
   again.

Each run is a line in `out/runs.jsonl`. Strategies (repair, best-of-2, escalate) and an online
learning router are replayed from those same runs by `analyze.py`, so they cost nothing extra.

## Running it

```sh
# once: SWE-bench (python 3.12 venv with swebench==3.0.17 at /tmp/wb/swe3), Harness-Bench grader venv
python bench/swe.py select 30 && cat bench/out/swe-pick.json   # then: python bench/swe.py validate <id>
python bench/hb.py select 24                                   # then: python bench/hb.py validate <id>
node bench/validate-wisp.mjs                                   # F2P/P2P for the wisp PR tasks

node bench/run.mjs --jobs 14            # all validated tasks × all arms; resumable
node bench/run.mjs --arms codex,claude-sonnet --tasks django__django-15499
python3 bench/analyze.py                # -> out/report.md, out/report.json
```

Arms are in `run.mjs` (`ARMS`); add one there to benchmark a new harness or model.

## Pilot (2026-10-18), stopped early

121 runs, 24 tasks (19 SWE-bench, 4 Harness-Bench, 1 wisp), first attempt, hidden tests:

| arm | solved | n | ~$/task |
|---|---|---|---|
| opencode · deepseek-v4.1-flash (free) | 100% | 10 | 0 |
| claude haiku | 86% | 21 | 0.02 |
| claude sonnet | 86% | 21 | 0.14 |
| grok-4.7 | 83% | 12 | 0.98 |
| claude opus | 81% | 21 | 0.34 |
| gemini-3.8-flash | 80% | 5 | ~0.05 |
| codex (default) | 79% | 24 | ~0.13 |
| gemini-4-argon | 71% | 7 | ~0.68 |

Too thin to rank anything: confidence intervals overlap, and the tasks that finished first were the
quick ones. Two findings already hold:

- **Agents say "done" when they failed.** In 19 of the 20 failed runs, the presentation's hero said
  `done` or its tests block said passing. Self-reports can't be the reward, which
  is why Auto weights merges, 👍 / 👎 and rollbacks above the hero.
- **wisp's own gate is useful but not enough.** When the gate passed, the hidden tests passed 83–100%
  of the time, so the gate also passes some broken runs.

The full run (61 tasks × 8 arms) is the next step; its results replace `server/router-priors.json`.

## Auto vs a single harness

`bench/auto.mjs` runs wisp itself (the server in `WISP_SRC`) on each task with `agent: "auto"`: route → agent → check → repair → hand-over or best of two. It grades the run wisp would show you: the best-of-two pick, else the last hand-over, else the first run. `run.mjs --raw` is the baseline: one harness on its own, with no gate and no repair. Runs that hit a usage or rate limit are retried later instead of being counted.

```sh
WISP_SRC=../wisp node bench/auto.mjs --tasks a,b --trials 2 --jobs 2 --out bench/out/auto.jsonl
node bench/run.mjs --raw --arms claude-opus --tasks a,b --trials 2 --jobs 2 --out bench/out/opus.jsonl
```

First comparison (2026-10-19, 8 wisp PRs and 12 Harness-Bench tasks, ×2), against Claude Code on Opus 5.5:
- On the 21 pairs that no quota touched, both solved 8. Auto's reported cost was ~17× lower, mostly because its picks were free or subscription models, and its median time was ~2× longer because of the test checks.
- Claude's session limit, a rate-limited free model and an exhausted Grok balance spoiled the other 19 pairs.
- That run led to three fixes: limits now cool a harness down instead of counting as failures, hand-overs step up a tier, and Balanced/Best stay on stronger tiers until Auto has 20 of your outcomes.
- A rerun with those fixes was stopped early (6 Opus and 2 Auto runs), so it has no result yet.
