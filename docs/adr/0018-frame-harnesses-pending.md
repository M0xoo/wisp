# ADR-0018: The app frame's screens, harnesses from their plugins, and `pending` on commands

- Status: accepted
- Date: 2026-11-08
- Source: the v1-parity work (design/foundation.md) and verify round 1 (docs/v2-verify-log.md #22–#24).

## Decision

1. **Harnesses describe themselves.** A plugin's UI may declare `harnesses` (`PluginUiDef.harnesses`,
   `HarnessUiDef { id, name, logo?, default?, order? }` in `packages/shell/src/contract.ts`, additive). The
   shell reads them through `ShellContext.harnesses()` for the agent pickers, a task's row and head and the
   reply box, and runs a new task on the first registered default. It names no agent itself (ADR-0003):
   `plugins/claude/ui` and `plugins/codex/ui` register Claude Code and Codex with their marks (data: URLs in
   the plugin's own code). An agent no plugin describes is shown by its id, with no mark.
2. **`optimistic: 'none'` needs `pending`.** `CommandDef` (`packages/client/src/commands.ts`) is now a union:
   an optimistic patch, or `optimistic: 'none'` with `pending`, which names the control that shows the
   command in flight. `'none'` alone is a type error (`packages/client/test/commands.test.ts`), as
   design/feedback.md requires. Every existing `'none'` command now names its control.
3. **The frame's screens are the shell's fallbacks.** Home, the open task and the list are drawn by the
   shell (`packages/shell/src/frame/{HomeView,TaskView,Sidebar}.tsx`, from kit pieces in
   `packages/ui/src/app/`) as the fallback of the areas `shell.screen:home`, `shell.screen:task` and
   `shell.sidebar:list`. A plugin that attaches there replaces them, as before. Until `shell-home`,
   `shell-task` and `shell-list` render these areas themselves (they aren't wired today), the shell's
   fallbacks are what users see and what the parity gate checks. Moving them into those plugins means
   moving these files, not drawing them again.
4. **Extension inputs stay live in the new frame.** `shell.topbar:*`, `shell.row:*` and `shell.task:head` render
   their extensions (`frame/slots.tsx`). An input with nothing attached has no box, so the frame is v1's pixel
   for pixel until a plugin adds something (`apps/web/test/slots.test.tsx`).

## Consequences

- Adding a harness's look is a plugin's UI package, not a shell edit.
- A command whose result can't be shown before the peer answers must say which control waits, and
  `qa/feedback.mjs` checks that the control does.
- The `shell-*` plugins and the shell's fallbacks overlap until the fallbacks move into them; a later ADR records
  that move.
