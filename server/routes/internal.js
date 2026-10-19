// Bridge for the MCP servers running inside an agent process (ask_user, delegate, wisp_stats). Every call
// carries the per-run token wisp handed the agent; nothing else may use these.

import { adapters } from '../adapters/index.js';
import { delegationReport } from '../subagents.js';
import { toolStats, toolStatsText } from '../usage.js';

export function register(r, app) {
  const { store, runner, telemetry } = app;
  // The token check, then the handler; a wrong token is a 403 whatever the route.
  const guarded = (fn) => (c) => (c.req.headers['x-wisp-token'] !== app.token ? c.send(403, { error: 'bad token' }) : fn(c));
  const opts = { doc: false };
  const lead = (c) => store.get(c.params.id);

  r.route(
    'POST',
    '/internal/ask',
    guarded(async (c) => {
      const body = await c.body();
      const s = store.get(body.session);
      if (!s) return c.send(404, { error: 'no such session' });
      telemetry.track('ask_user', { agent: s.agent });
      c.send(200, { id: runner.ask(s, body) });
    }),
    opts,
  );
  r.route('GET', '/internal/ask/:id', guarded((c) => c.send(200, runner.pollAnswer(c.params.id))), opts);

  // delegate: POST starts tasks on the lead's subagents; GET reports on them (done once all finished).
  r.route(
    'POST',
    '/internal/delegate/:id',
    guarded(async (c) => {
      const s = lead(c);
      if (!s) return c.send(404, { error: 'no such session' });
      const body = await c.body();
      const delegations = runner.delegate(s, body.tasks);
      telemetry.track('delegate', { agent: s.agent, tasks: delegations.length, harnesses: [...new Set(delegations.filter((d) => d.agent).map((d) => d.agent))] });
      c.send(200, { delegations });
    }),
    opts,
  );
  r.route(
    'GET',
    '/internal/delegate/:id',
    guarded((c) => {
      const s = lead(c);
      if (!s) return c.send(404, { error: 'no such session' });
      const ids = (c.query.get('ids') || '').split(',').filter(Boolean);
      const list = runner.delegations(s, ids);
      if (!list.length) return c.send(200, { done: true, text: 'No delegated tasks to report on.' });
      const running = ({ d, child }) => child?.turns.find((t) => t.id === d.turnId)?.status === 'running';
      c.send(200, { done: !list.some(running), text: list.map(({ d, child }) => delegationReport(d, child, adapters)).join('\n\n---\n\n') });
    }),
    opts,
  );

  // wisp_stats: read-only tool counts, spend and success across sessions. project=current is the
  // asking session's project.
  r.route(
    'GET',
    '/internal/stats/:id',
    guarded((c) => {
      const s = lead(c);
      if (!s) return c.send(404, { error: 'no such session' });
      const projectFor = (x) => store.projectFor(x.cwd);
      let project = c.query.get('project') || '';
      if (project === 'current') project = projectFor(s)?.id || String(s.cwd || '').split(/[\\/]/).pop();
      const stats = toolStats(store.all(), { days: Number(c.query.get('days')) || 30, project: projectFor, filter: { agent: c.query.get('agent') || '', project } });
      telemetry.track('wisp_stats', { agent: s.agent });
      c.send(200, { stats, text: toolStatsText(stats) });
    }),
    opts,
  );
}
