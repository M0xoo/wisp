// Issues to start a task from (server/issues.js): New task's Issue button and ⌘K.
//
//   GET /issues   ?project=<id>&q=&source=github|linear|jira  open issues, newest first; a problem comes
//                 back as { error, fix } beside an empty list, for the picker to show

import { mcpCall } from '../connectors.js';
import { listIssues } from '../issues.js';

export function register(r, app) {
  const { store, secrets, runner } = app;
  // A signed-in Linear or Jira server, called through the proxy as a turn would (its token stays here).
  const mcp = (x, fn) => mcpCall(x, store.home, runner.bridge, fn);
  r.route('GET', '/issues', async (c) => {
    const source = c.query.get('source') || 'github';
    if (!['github', 'linear', 'jira'].includes(source)) return c.send(400, { error: 'source is github, linear or jira' });
    const id = c.query.get('project') || '';
    const project = id ? store.config.projects.find((p) => p.id === id) : null;
    if (id && !project && id !== 'none') return c.send(404, { error: 'No such project' });
    const dir = project ? store.pathAt(project, null) : null;
    c.send(200, await listIssues({ source, project, dir, q: c.query.get('q') || '', connectors: store.config.connectors || [], secrets, mcp }));
  });
}
