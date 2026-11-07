# wisp v2: brief for every agent building it

You are building part of **wisp v2** in this folder (a git worktree on branch
`wisp/we-are-going-to-work-on-wisp-v2-8fb64e`). The owner's words: *wisp v2 = wisp v1 with the new
architecture*, in one PR, so that after it merges only what v2 needs is left. They expect it to be the best
codebase ever made. Take nothing below as optional.

## Read first

1. `AGENTS.md` (the working rules) and `ARCHITECTURE.md` (the map).
2. The plan: `/Users/mokh/.wisp/stuff/63a85cccbd35-r9-wisp-rewrite-plan.md`. Your brief names the sections.
3. `packages/kernel/src/contract.ts` (the plugin contract) and `packages/protocol/src/index.ts` (the wire).
   Don't change either without saying why in your report; other agents build against them. Adding is fine.
4. v1 is still in the folder (`server/`, `web/`, `grid/`, `test/`, …) as the parity reference. Read it for
   behaviour and edge cases. Don't edit it unless your brief says so: it is deleted at the end.

## Decisions already made (don't reopen them)

- TypeScript strict, Node ≥ 22.18 running `.ts` directly (erasable syntax only, `.ts` import extensions).
- Server API stays TypeScript on Node. Rust only in `native/` (wisp-native: PTY and process trees).
- Store: `node:sqlite`. Sync: SSE `/api/events?topics&cursor` + `POST /api/cmd` with idempotency keys.
- UI: Solid 1.9 + Zag.js, the kit `@wisp/ui` is the only place with CSS (feature CSS is banned).
- Client state: `alien-signals` core, framework-independent (`@wisp/client`).
- Spells are gone: they are plugins (`wispPlugin: 1` manifests); `wispSpell` files are converted on import.
- Monorepo: npm workspaces, handled by **monoflow**.

## monoflow is mandatory

- `.agents/bin/monoflow graph impact <file>` before you change any contract or `api/` package.
- `.agents/bin/monoflow verify --package=<your package>` after each change; `--affected` when you touched
  more than one. **This is the gate.** Don't report done until it passes.
- **Never run `monoflow checkpoint revert`, `monoflow commit`, `monoflow outer` or `monoflow ship` here.** This worktree is
  shared: `checkpoint revert` runs `git read-tree -u --reset`, which deleted other agents' new files four
  times, and `commit` starts a background loop that did the same. Use `graph`, `verify` and `checkpoint save` only.
- Every package you create needs `test` and `typecheck` scripts in its `package.json` and its own
  `tsconfig.json` (copy `packages/protocol`'s), so monoflow verifies it.
- Don't use `monoflow start`, `ship`, `commit` or `push`. Don't run git commit/push, stash or reset. The lead commits.

## Working with the others

- **Never delete files you didn't create, and never run `git clean`, `git stash`, `git checkout -- .`,
  `git reset` or `rm -rf` outside your own directories.** Someone deleted another agent's untracked file
  once already. The lead commits progress often; pull nothing, push nothing.

- Several agents work in this folder at once. **Touch only the directories in your brief.** If you need a
  change elsewhere, write it in your report.
- Dependencies are installed. If you really need a new one, add it to your package's `package.json`, run
  `npm install --no-audit --no-fund` at the root (retry once if npm says the lock is busy), and justify it
  in your report: every dependency needs an ADR.
- Never run the whole v1 suite (`npm run test:v1`): the machine is shared.

## Quality bar

- No `any`, no non-null `!` without a comment saying why, no `// @ts-ignore`.
- Files ≤ 400 lines, functions ≤ 60 lines, unless there's a written reason.
- Comments say *why*, briefly. Names say what. Match the code around you.
- Tests sit next to the code, need no network, and cover the edge cases v1 learned the hard way (read v1's
  tests for your area: `test/*.test.js`).
- Your report: what you built (files), its public API, how many tests and the monoflow verify output, and
  what is left or what you need from another package.

## Performance is a priority

The owner: *we are creating the fastest dev tool possible*. Read AGENTS.md → Performance and ADR-0011.
Hot paths come with a bench (spikes/<area>/) and numbers in your report; no sync I/O on request or
runner paths; lazy activation; prepared statements; coalesced writes; fine-grained UI updates.

## UI: nothing wraps that shouldn't (owner's priority)

Read design/layout.md and ADR-0012 before writing any UI. Control text never wraps; bars are one line and
collapse to icons then More by declared priority; only `Wrap` groups wrap. Check at 320–1440 px.
