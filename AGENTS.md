# AGENTS.md

How to work on wisp v2. `README.md` says what wisp does, `ARCHITECTURE.md` maps the code, and
`docs/adr/` records why each decision was made. This file holds the rules a change has to follow. The
step-by-step how-tos are in `.claude/skills/` (any agent can read them, not only Claude).

## Before you change anything

- **Read `ARCHITECTURE.md`**, and the ADR for the area you are touching.
- **Ask the graph:** run `.agents/bin/monoflow graph impact <file>` before you change a contract (an `api/`
  package, `@wisp/protocol`, `@wisp/kernel`). It lists every package your change reaches.
- **A decision that changes the architecture** (a new package kind, a new dependency, a new kind of
  state, a new wire message, a rule in `tools/check` turned off) gets a new ADR in `docs/adr/`, in the
  same PR. Use the `record-decision` skill. An ADR is never edited after it merges; a later ADR supersedes it.

## Commands

```sh
npm install                      # once; workspaces link every package
npm run check                    # structure rules (layers, cycles, CSS, state, manifests, OpenAPI, sizes)
npm run typecheck                # tsc strict, server and web
npm test                         # every package's tests (node --test; vitest for UI packages)
npm run verify                   # all three, as PR CI runs them
.agents/bin/monoflow verify --affected   # only what your change reaches (inner loop)
node --test packages/store/test/store.test.ts   # one file
npm run dev                      # server + web with reload
```

## Language and runtime

- **TypeScript everywhere**: `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`.
  No `any`: use `unknown` and narrow it. Only erasable syntax (`erasableSyntaxOnly`): no `enum`, no
  `namespace`, no parameter properties. Node ≥ 22.18 runs `.ts` directly, so the server and tests have
  no build step. Import relative files with their `.ts` extension.
- The published package (`apps/server` → `wisp-agents`) is bundled by `tools/bundle.ts` into plain JS
  with **zero runtime dependencies**. A new dependency needs an ADR.
- IDs are branded types. Errors cross the wire as one shape: `{code, message, retry}`.

## Plugins (ADR-0003)

- **Everything is a plugin.** The kernel knows no feature: there is no `if (harness === 'claude')`
  outside `plugins/claude`.
- **A plugin talks to others only through their `api` package**: commands (do something), events
  (something happened), interceptors (refuse or change something), extension points (provide an
  implementation), topics (watch data), services (a long-lived handle). It never imports another
  plugin's `host` or `ui`.
- **Built-ins get no private API.** Whatever a built-in plugin can do, a user's plugin can do through
  the same manifest and API. If a built-in needs more, add an extension point, and then everyone has it.
- **Every registration belongs to a scope.** Timers, subscriptions, child processes and watchers go
  through `ctx.scope`, so switching a plugin off frees everything it made.
- **Default deny.** A new command, route or MCP tool is unreachable until a capability set names it
  (`plugins/*/host/wisp-plugin.json` permissions, `packages/kernel/src/capabilities.ts`).
- **Interceptors read and decide; they never write.** Follow-up work goes in the verdict's `then`.

## Data (ADR-0004, ADR-0005)

- **One write path:** a command runs in one store transaction and every row it writes is recorded in
  `change`. Nothing writes files or rows behind the store's back.
- **Plugins own their tables**, under their own prefix, with their own forward-only migrations.
- Secrets stay in `~/.wisp/secrets.json` (0600), never in the database.
- Clients never poll. They subscribe to topics and resume from their cursor.

## UI (ADR-0006, ADR-0007)

- **Kit components only.** App and plugin UI code has no CSS: no `class`, no `style` (except CSS custom
  properties such as `--sb-w`), no `.css` files. A kit change may land in the same PR as the feature
  that needs it.
- **State has one home:** server data in the entity store (written only by sync and command patches),
  derived values as selectors, what's open in navigation (`navigate(intent)`), flows as machines,
  drafts in the drafts store, settings in the settings store. Everything else is a local signal.
- **Writes are commands**: an idempotency key and a declared optimistic patch (or `optimistic: 'none'`).
  The UI updates at once and rolls back with a toast on `reject`.
- **Nothing jumps:** keyed lists move rows in place, entry animations run once per mount, and a list
  over 200 rows uses `VirtualList`.
- **Nothing wraps that shouldn't** (`design/layout.md`, ADR-0012): control text (buttons, pills, chips,
  tabs, row titles, bar labels) never wraps; bars are one line and collapse items to their icon, then into
  More, by declared priority; only `Wrap` groups may wrap. `qa/layout.mjs` checks it at 320–1440 px.
- Every user-facing string goes through `t('key')`. Every element a plugin may restyle has a `data-part`.
- A UI change follows `design/` and ends with `design/checklist.md`: seen in real Chrome at desktop
  and phone widths, in light and dark.

## Performance is a feature (ADR-0011)

wisp aims to be the fastest dev tool there is. Speed is checked like correctness:

- **Budgets fail CI** (`tools/budgets.ts`, plan §8): initial JS ≤ 120 KB br, initial CSS ≤ 30 KB br, server
  cold start → first response ≤ 150 ms, idle RSS ≤ 120 MB with 5k sessions, list query ≤ 5 ms on 5k
  sessions, append ≥ 20k events/s, write amplification ≤ 15× payload, p99 patch latency ≤ 150 ms (one
  heavy user: 5k sessions, 10 running, 4 clients), tap → frame ≤ 50 ms p95 and 0 long tasks while
  streaming on a 4×-throttled CPU. A miss blocks the merge, or needs a new ADR that changes the budget.
- **Measure, don't guess:** a change to a hot path (store writes, the sync outbox, harness parsing, the
  list, the transcript) comes with its bench run (`spikes/*/`) before and after, in the PR.
- **Nothing on the hot path blocks:** no sync I/O in request handlers or the runner (`*Sync` calls are
  refused by `tools/check` outside startup and tests), no full-list work per event, no JSON
  re-serialisation of whole sessions.
- **Lazy by default:** plugins activate on their first event, UI extensions load with `import()`, and only
  open or running sessions stay in memory.
- **The UI does the least work:** fine-grained signals (one row repaints), keyed lists that move nodes,
  `VirtualList` past 200 rows, no layout reads after writes in one frame, no `:has()` on large boxes.

## Tests

- Tests sit next to the code (`<package>/test/*.test.ts`). They need no network and no real harness.
- Pure code (deciders, reducers, machines, parsers, the sync merge) gets property or model-based tests.
- Anything an agent, a peer or a released client reads (wisp blocks, MCP tools, protocol shapes) has
  goldens under `test/goldens/`. Changing one is a deliberate act in the PR.
- A test that fails only some of the time is flaky: fix it, never retry it.

## Git and CI

- `main` is protected. Work on a branch, open a PR. Commit by file name, never `git add -A`.
- PR CI: `npm run verify` on Linux, Node 22 and 24. Label a PR `ci:full` to run every OS. monoflow
  reports the affected set; it does not skip anything until gate G14 passes (ADR-0001).
- User-facing changes get a `CHANGELOG.md` entry under *Unreleased*.
- Releasing is merging the version bump in `apps/server/package.json` (see the `release` skill).
