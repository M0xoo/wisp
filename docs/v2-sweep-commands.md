# ui-commands: what the rule still reports (2 findings, 2026-11-10; baseline 79)

Regenerate with `npm run check` (rule `ui-commands`). Every command and topic has a server and every plugin UI but two is registered. The two left wait on backend work (backend-coder's v1-coverage queue): learn's host is a placeholder (no commands, no retros), and issues.list can't resolve a project (nothing contributes `issues.projects`).

- plugins/issues/ui/package.json:1 @wisp-plugin/issues-ui is registered nowhere: give src/index.ts a default definePluginUi(…), or register it in apps/web
- plugins/learn/ui/package.json:1 @wisp-plugin/learn-ui is registered nowhere: give src/index.ts a default definePluginUi(…), or register it in apps/web
