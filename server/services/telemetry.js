// What the runner, the router and the retro report to telemetry: fixed values about how a turn
// ran and ended, never the prompt or the result.

import { envDisabled } from '../telemetry.js';

export const runProps = (s, t) => ({ agent: s.agent, model: s.model || 'default', mode: s.mode, effort: s.effort || 'default', followUp: s.turns.indexOf(t) > 0 });

// Auto's choice, as fixed values only: never the prompt.
const routeProps = (s) =>
  s.route ? { routed: true, routeGoal: s.route.goal, routeType: s.route.type, routeSize: s.route.size, routeExplored: !!s.route.explored, routeTrying: !!s.route.trying, routePropensity: s.route.propensity } : {};

export function trackTurns({ runner, telemetry }) {
  runner.on('started', ({ session, turn }) => telemetry.track('turn_started', { ...runProps(session, turn), attachments: turn.attachments.length }));
  runner.on('ended', ({ session, turn, interrupted, errorText }) => {
    const blocks = turn.presentation?.blocks || [];
    const st = turn.stats || {};
    telemetry.track('turn_ended', {
      ...runProps(session, turn),
      ...routeProps(session),
      status: interrupted ? 'interrupted' : turn.status, // done | error | stopped | interrupted
      heroStatus: blocks.find((b) => b.type === 'hero')?.status,
      durationMs: turn.endedAt - turn.startedAt,
      blockCount: blocks.length,
      blockTypes: [...new Set(blocks.map((b) => b.type))],
      presentationFallback: !!turn.presentation?.fallback, // agent ignored or broke the wisp protocol
      changedFiles: turn.changes.length,
      inputTokens: st.inputTokens,
      outputTokens: st.outputTokens,
      costUsd: st.costUsd,
    });
    if (errorText) telemetry.captureError(new Error(errorText), { type: 'AgentError', ...runProps(session, turn) });
  });
  if (!envDisabled()) process.on('uncaughtExceptionMonitor', (err) => telemetry.crashed(err));
}
