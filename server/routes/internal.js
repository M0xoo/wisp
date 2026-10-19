// Bridge for the MCP servers running inside an agent process (ask_user, approve, delegate, wisp_stats,
// wisp_sessions, wisp_session). Every call
// carries the per-run token wisp handed the agent; nothing else may use these.

import { adapters } from '../adapters/index.js';
import { plainMentions } from '../mentions.js';
import { blocksToMarkdown, sessionToMarkdown } from '../render.js';
import { summarize } from '../runner.js';
import { delegationReport } from '../subagents.js';
import { toolStats, toolStatsText } from '../usage.js';
import { clip } from '../util.js';

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

  // A live approval (the harness's permission prompt): { decision } at once, or an { id } to poll
  // like ask_user, whose answer carries the decision.
  r.route(
    'POST',
    '/internal/approve',
    guarded(async (c) => {
      const body = await c.body();
      const s = store.get(body.session);
      if (!s) return c.send(404, { error: 'no such session' });
      const out = runner.requestApproval(s, body);
      if (out.id) telemetry.track('approval', { agent: s.agent });
      c.send(200, out);
    }),
    opts,
  );

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
  // wisp_sessions: the user's other tasks (not the asker, its subagents or the tour), newest first.
  r.route(
    'GET',
    '/internal/sessions/:id',
    guarded((c) => {
      const s = lead(c);
      if (!s) return c.send(404, { error: 'no such session' });
      const q = Object.fromEntries(c.query);
      let project = q.project || '';
      if (project === 'current') project = store.projectFor(s.cwd)?.id || String(s.cwd || '').split(/[\\/]/).pop();
      const states = q.state ? q.state.split(',').map((x) => x.trim()) : null;
      const words = String(q.query || '').toLowerCase().split(/\s+/).filter(Boolean);
      const all = store
        .all()
        .filter((x) => x.id !== s.id && !x.parentId && x.agent !== 'wisp' && x.id !== s.parentId)
        .map((x) => summarize(x, store))
        .filter((x) => (q.archived === 'true' || !x.archived) && (!states || states.includes(x.state)))
        .filter((x) => !project || x.projectId === project || x.project === project)
        .filter((x) => words.every((w) => `${x.title} ${x.preview}`.toLowerCase().includes(w)))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const list = all.slice(0, Math.min(Math.max(Number(q.limit) || 20, 1), 100));
      telemetry.track('wisp_sessions', { agent: s.agent });
      const text = list.length
        ? `${all.length} task${all.length === 1 ? '' : 's'}${all.length > list.length ? `, the newest ${list.length}` : ''}. Read one with wisp_session.\n\n${list.map(sessionLine).join('\n')}`
        : 'No tasks match.';
      c.send(200, { text });
    }),
    opts,
  );

  // wisp_session: one task's requests and a turn's report (?of=<id>&turn=<1-based>).
  r.route(
    'GET',
    '/internal/session/:id',
    guarded((c) => {
      const s = lead(c);
      if (!s) return c.send(404, { error: 'no such session' });
      const id = String(c.query.get('of') || '').trim().replace(/^wisp:/, '');
      const x = store.get(id);
      telemetry.track('wisp_session', { agent: s.agent });
      if (!x) return c.send(200, { text: `No wisp task \`${id}\` on this computer. It may have been deleted, or it ran on another machine. List tasks with wisp_sessions.` });
      c.send(200, { text: sessionText(x, store, c.query.get('turn')) });
    }),
    opts,
  );
}

const age = (t) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

const sessionLine = (x) =>
  `- \`${x.id}\` **${x.title}** — ${x.archived ? 'archived, ' : ''}${x.state}, ${x.agent}${x.model ? ` (${x.model})` : ''}, ${x.project}, ${age(x.updatedAt)}${x.state === 'running' && x.live ? `: ${x.live}` : x.preview ? `: ${clip(x.preview, 160)}` : ''}`;

export function sessionText(x, store, turnArg) {
  const sum = summarize(x, store);
  const n = Number(turnArg);
  const turn = turnArg === null || turnArg === undefined || turnArg === '' || !n ? x.turns.at(-1) : x.turns[n - 1];
  const head = [
    `# ${x.title}`,
    `Task \`${x.id}\` · ${sum.archived ? 'archived · ' : ''}${x.state} · ${x.agent}${x.model ? ` (${x.model})` : ''} · project ${sum.project} · updated ${age(x.updatedAt)}`,
    `Folder: \`${x.worktree?.path || x.cwd}\`${x.worktree ? ` (worktree, branch \`${x.worktree.branch}\`)` : ''}${x.pr ? ` · PR #${x.pr.number} (${String(x.pr.state).toLowerCase()}): ${x.pr.url}` : ''}`,
  ];
  const asks = x.turns.map((t, i) => `${i + 1}. ${clip(plainMentions(t.prompt).replace(/\s+/g, ' '), 300)}${t.status === 'running' ? ' _(running)_' : t.status === 'error' ? ' _(failed)_' : t.status === 'stopped' ? ' _(stopped)_' : ''}`);
  if (!turn) return [...head, '', `Turn ${turnArg} doesn't exist; this task has ${x.turns.length}.`, '', '## Requests', ...asks].join('\n');
  const i = x.turns.indexOf(turn);
  const report = turn === x.turns.at(-1) ? sessionToMarkdown(x) : blocksToMarkdown(turn.presentation?.blocks, turn);
  const files = (turn.changes || []).filter((ch) => !ch.reverted).map((ch) => `\`${ch.file}\``);
  return [
    ...head,
    '',
    `## Requests (${x.turns.length})`,
    ...asks,
    '',
    `## Report for turn ${i + 1}${x.turns.length > 1 ? ` of ${x.turns.length} (pass turn to read another)` : ''}`,
    '',
    report || '_No report yet._',
    ...(files.length ? ['', `Files edited in this turn: ${files.join(', ')}`] : []),
  ].join('\n');
}
