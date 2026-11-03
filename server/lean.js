// Lean Claude Code runs (Settings → Agents, defaults.leanRuns): CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
// so no telemetry, error reporting or update checks: 5 connections at start instead of 12 and about
// a second sooner (many at once can run a box out of NAT ports, anthropics/claude-code#106875).
// It also turns GrowthBook off, and with it the claude.ai connectors, org memory (Team plans),
// /ultrareview, /advisor, push notifications and every server-rolled feature (measured on 2.1.317,
// Moris check-in 16 (a)). ENABLE_CLAUDEAI_MCP_SERVERS doesn't bring the connectors back.
// So by default ('on') it's only for wisp's own side runs, which answer with JSON or a note and
// need none of that: judges, the scout, review by another harness, the retro (quick.js, preferences.js).
// 'all' makes every Claude run lean, 'off' none. A task's own `lean` ('on' | 'off',
// PATCH /sessions/:id) wins for that task's runs.
export const LEAN_ENV = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
export const LEAN_VALUES = ['off', 'on', 'all'];

// Set once at boot (server/index.js); nothing (tests) reads as the default, on.
let read = () => null;
export const useConfig = (fn) => (read = fn);
const mode = (defaults) => (LEAN_VALUES.includes(defaults?.leanRuns) ? defaults.leanRuns : 'on');

// A side run wisp makes for itself: lean unless the setting is off.
export const leanOn = (defaults = read()?.defaults) => mode(defaults) !== 'off';

// A task's run (yours, a crew job, a delegated task, a subagent, a schedule or trigger): lean only
// when the task asked for it or the setting is 'all'.
export function leanTask(s, defaults = read()?.defaults) {
  if (s.lean === 'on' || s.lean === 'off') return s.lean === 'on';
  return mode(defaults) === 'all';
}
