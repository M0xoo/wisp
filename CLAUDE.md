@AGENTS.md

Claude Code reads this file. The rules are in AGENTS.md (shared by every agent), the map is in
ARCHITECTURE.md, the decisions are in docs/adr/, and the how-tos are in .claude/skills/. Use monoflow
(`.agents/bin/monoflow graph impact` before changing a contract, `verify --affected` after every change):
it is the gate.
