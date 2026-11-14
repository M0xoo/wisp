# Backend round 1: the v1 sync ports (#760, #761, #763 rest, #764)

Second coder (backend). Status per item; compile/clippy results at the end.

## #760: a quiet crew job keeps its scheduled follow-ups

v2 had `wisp_crew_core::filing::file_turn` but nobody contributed `runtime.outcome@1`, so a crew job's
crew block never decided where it landed (a quiet check-in landed in Review, unread).

- `plugins/crew/core/src/filing.rs`: `Filing::keeping(scheduled)`: a quiet job with something scheduled is
  filed under Done (`filed`), not archived. wisp.later lets what an archived task scheduled lapse.
- `plugins/crew/host/src/lib.rs`: `Filed` contributes `runtime.outcome@1`: reads the job's `ext["wisp.crew"]`,
  its turn's crew block, `file_turn(job, idx+1, block).keeping(scheduled(s))`. `scheduled` reads wisp.later's
  mirror `ext["wisp.later"]` by key (`later` non-empty or a `reminder`).
- `plugins/crew/host/Cargo.toml`: + `wisp-later-api` (workspace dep, already in the root Cargo.toml).
- Tests: `wisp_crew_core::filing::tests::a_quiet_check_in_keeps_its_scheduled_follow_up` (ok),
  `wisp_crew::tests::a_quiet_check_in_keeps_its_scheduled_follow_up` (ok).
- Side effect, intended (v1 behaviour): quiet crew jobs with nothing scheduled are now archived, For later
  ones parked, delegated ones filed: the outcome point finally has its contributor.

## #761: desktop target=_blank links

v2 has no `apps/desktop` yet (queue item 8). The Tauri shell that item 8 moves is `desktop/src-tauri`, so the
fix lands there, as v1's:
- `desktop/src-tauri/src/main.rs`: `tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build()`.
- `test/desktop-tauri.test.js`: `a click on a target=_blank link leaves through the shell, not the opener
  plugin’s IPC` (ran alone with node --test: pass). The real-click TAURI-06 half waits for apps/desktop.

## #763 rest

- **Probation without a score** (`plugins/router/core`): `known_to_priors` counts a tier row
  (`priors.tiers`), so `claude:fable` is a candidate; `Router::sync` marks ready on the first look only a
  harness's default and scored models, so Fable starts on probation (`Life::New`): Auto runs it only when nothing
  else fits. Test `keys::fable_tests::auto_offers_a_tier_only_model_on_probation` (ok; also checks that
  blocking `claude:fable` keeps Auto off it).
- **Compact pricing for claude-fable-5-2**: v2 had no cold-cache / Compact now at all (v1-features F-page-14
  missing). Ported v1 web/js/cold-cache.js as `plugins/runtime/core/src/cold.rs` (sans-IO): `cold_cache`,
  `compact_offer`, `main_model`, `bare_model`, `PRICES` with `claude-fable-5-2` at $8 / $0.20 / $40.
  Tests: `compact_prices_claude_fable_5_2` (7.68 cold re-read of 480k, as v1's compact.test.js),
  `the_cache_goes_cold_after_its_ttl_and_grace`, `compact_is_offered_until_the_ttl_not_the_grace`,
  `a_later_turn_that_worked_without_a_number_is_not_guessed` (all ok).
  - `TurnStats` (+`context_tokens`, `cache_ttl_ms`, additive, optional): the Claude parser already put
    `contextTokens`/`cacheTtlMs` in `HarnessStats.extra`; `land::turn_stats` and the v1 importer now keep them.
  - **v1 bug fixed in passing:** `turn_stats` read `extra.models` only as an object, but Claude reports a list
    of `{model, input, …}`: every Claude turn lost its per-model tokens. It now keys the list by model.
  - New read command `runtime.cold {id} → {cache, compact}` (api `ColdArgs/ColdCache/CompactOffer/ColdOut`,
    registered in `reads`, manifest entry, so it is an MCP tool too).
  - **For the UI coder:** the reply box's cold line and Compact now button (v1 `coldLine`, `compactNote`,
    `compactTip`, `limitColdLine`) read `runtime.cold`; they're screens, not built here.
- **Bare `fable` vendor id**: v1's is `web/js/vendors.js` (the vendor mark beside a model). v2 has no vendor
  mapping in Rust or TS yet: it's a UI piece. **For the UI coder:** the regex is
  `/claude|anthropic|(?:^|[/:\s_-])(?:opus|sonnet|haiku|fable)(?:$|[/:\s._-]|\d)/i` → anthropic.

## #764: the launcher's pick goes with that one crew job

v2 crew had `WaitingJob.run` but never read it, and `crew.assign` took no run at all.
- `plugins/crew/core/src/run.rs` (new, sans-IO): `job_run(m, run, picked, harness_ok)` (v1 `#jobRun`):
  a harness change only when `picked` (wisp's own prompt box), never from a channel; an unknown harness is
  refused; Auto takes no model or level; mode ∈ plan/edits/auto; level `[\w-]{1,20}`; model ≤ 120 chars.
  `job_body(m, run)` (v1 `#bodyFor`): another harness leaves the member's model and level behind.
- `wisp-crew-api`: `RunPick.agent` (additive); `AssignArgs.run` + `AssignArgs.picked` (v1 `crewRun`).
- `plugins/crew/host/src/jobs.rs`: `crew.assign` checks the run (harnesses from `runtime.profiles`), `start`
  builds the task from `job_body`, and a queued job keeps its run (`WaitingJob.run`) through the drain.
  `start`/`assign` now take a `WaitingJob` (clippy's 7-arg limit).
- Tests: `run::tests::a_launcher_pick_overrides_the_member_for_that_job_only`,
  `run::tests::a_channel_cant_change_a_members_harness` (both ok).
- **For the UI coder:** the launcher, when the prompt goes to one crew member, shows that member's harness,
  model and level in the picker, and sends a change as `crew.assign {id, prompt, run: {agent, model, effort},
  picked: true}`.

## Checks run

- `cargo clippy -p wisp-crew-core -p wisp-crew -p wisp-crew-api -p wisp-router-core -p wisp-runtime-core
  -p wisp-runtime -p wisp-runtime-api --all-targets -- -D warnings`: clean.
- Named tests above, each run alone: all pass.
- Bindings regenerated: `cargo test -p wisp-crew-api -p wisp-runtime-api export_bindings` (54 + 124 ok):
  `crew/RunPick.ts`, `crew/AssignArgs.ts`, `runtime/TurnStats.ts`, new `runtime/Cold*.ts`, `CompactOffer.ts`.

## Files

crew: `core/src/{filing,run,lib}.rs`, `api/src/{rows,commands}.rs`, `host/src/{lib,jobs}.rs`, `host/Cargo.toml`;
router: `core/src/{keys,router}.rs`; runtime: `api/src/model.rs`, `api/src/commands/{mod,more}.rs`,
`core/src/{cold,land,import,lib}.rs`, `host/src/{plugin,ops}.rs`, `host/wisp-plugin.json`;
`desktop/src-tauri/src/main.rs`, `test/desktop-tauri.test.js`; bindings under `plugins/{crew,runtime}/api/bindings/`.
