// OpenAPI 3.1 description of the public HTTP API, served at GET /api/openapi.json.
// Feed it to any OpenAPI client generator, Postman, or an agent's tool loader.
// Routes under /api/internal are wisp's own plumbing and deliberately left out.

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const id = { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Session id' };
const body = (schema) => ({ required: true, content: { 'application/json': { schema } } });
const err = { 400: json(ref('Error'), 'Bad request'), 404: json(ref('Error'), 'Not found') };
const ok = json({ type: 'object', properties: { ok: { type: 'boolean' } } });

export function openapi({ version, port }) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'wisp',
      version,
      description:
        'Local API of wisp, a launcher and queue for coding agents (Claude Code, Codex, opencode, Cursor, Antigravity). ' +
        'Binds to 127.0.0.1 only. Requests must carry a Host of 127.0.0.1/localhost:<port>; non-GET requests must be ' +
        'application/json (uploads: application/octet-stream) and, if they send an Origin, a local one. ' +
        'The running server advertises { url, port, pid, version } in ~/.wisp/server.json.',
    },
    servers: [{ url: `http://127.0.0.1:${port}/api` }],
    paths: {
      '/health': { get: { summary: 'Liveness, version and pid', responses: { 200: json(ref('Health')) } } },
      '/update': {
        get: { summary: 'Current and latest published version, and how this copy updates (global | npx | git). ?check forces a registry check', responses: { 200: json({ type: 'object' }) } },
        post: { summary: 'Install the latest version and relaunch. 409 while agents run unless { force: true }', responses: { 202: json({ type: 'object' }), 409: json({ type: 'object' }) } },
      },
      '/preferences': {
        get: { summary: 'What wisp learned: { enabled, global: { preferences, lessons }, projects: [{ path, name, preferences, lessons }], history }', responses: { 200: json({ type: 'object' }) } },
        put: {
          summary: 'Replace one learned list',
          requestBody: body({
            type: 'object',
            required: ['scope', 'kind', 'items'],
            properties: {
              scope: { type: 'string', description: '"global" or an absolute project path' },
              kind: { type: 'string', enum: ['preferences', 'lessons'] },
              items: { type: 'array', items: { type: 'string' }, description: 'Deduped and capped at 10 items of 180 characters' },
            },
          }),
          responses: { 200: json({ type: 'object' }), 400: err[400] },
        },
      },
      '/agents': { get: { summary: 'Installed harnesses with their models and thinking levels', responses: { 200: json({ type: 'array', items: ref('Agent') }) } } },
      '/config': {
        get: { summary: 'Launcher defaults, projects, webhooks', responses: { 200: json({ type: 'object' }) } },
        patch: {
          summary: 'Update defaults and/or webhooks',
          requestBody: body({
            type: 'object',
            properties: {
              defaults: { type: 'object', description: 'Merged into the current defaults (agent, mode, model, models, effort, efforts, followUp, terminal, …)' },
              webhooks: { type: 'array', items: { oneOf: [{ type: 'string', format: 'uri' }, ref('Webhook')] }, description: 'Replaces the webhook list' },
            },
          }),
          responses: { 200: json({ type: 'object' }), 400: err[400] },
        },
      },
      '/projects': {
        get: { summary: 'List projects', responses: { 200: json({ type: 'array', items: ref('Project') }) } },
        post: { summary: 'Add a folder as a project', requestBody: body({ type: 'object', required: ['path'], properties: { path: { type: 'string' }, name: { type: 'string' } } }), responses: { 201: json(ref('Project')), 400: err[400] } },
      },
      '/projects/{pid}': {
        parameters: [{ name: 'pid', in: 'path', required: true, schema: { type: 'string' } }],
        patch: { summary: 'Rename or recolor', requestBody: body({ type: 'object', properties: { name: { type: 'string' }, color: { type: 'string' } } }), responses: { 200: json(ref('Project')), 404: err[404] } },
        delete: { summary: 'Remove the project (sessions are kept)', responses: { 200: ok, 404: err[404] } },
      },
      '/sessions': {
        get: {
          summary: 'List sessions, newest first',
          parameters: [
            { name: 'state', in: 'query', schema: { type: 'string' }, description: 'Comma-separated: running,waiting,review,done' },
            { name: 'agent', in: 'query', schema: { type: 'string' } },
            { name: 'project', in: 'query', schema: { type: 'string' }, description: 'Project id or name' },
            { name: 'cwd', in: 'query', schema: { type: 'string' }, description: 'Sessions in this folder or below' },
            { name: 'archived', in: 'query', schema: { type: 'boolean' } },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { 200: json({ type: 'array', items: ref('Summary') }) },
        },
        post: { summary: 'Launch a task', requestBody: body(ref('Launch')), responses: { 201: json(ref('Summary')), 400: err[400] } },
      },
      '/sessions/{id}': {
        parameters: [id],
        get: { summary: 'Full session record: turns, activity, captured edits, presentations', responses: { 200: json({ type: 'object' }), 404: err[404] } },
        patch: {
          summary: 'Rename, mark done/review, mark read, archive',
          requestBody: body({ type: 'object', properties: { title: { type: 'string' }, state: { enum: ['done', 'review'] }, unread: { type: 'boolean' }, archived: { type: 'boolean' } } }),
          responses: { 200: json(ref('Summary')), 404: err[404] },
        },
        delete: { summary: 'Stop and delete', responses: { 200: ok, 404: err[404] } },
      },
      '/sessions/{id}/wait': {
        parameters: [id, { name: 'timeout', in: 'query', schema: { type: 'integer', default: 60, maximum: 290 }, description: 'Seconds' }],
        get: { summary: 'Long-poll until the session needs you (finished or asking)', responses: { 200: json({ allOf: [ref('Summary'), { type: 'object', properties: { timedOut: { type: 'boolean' } } }] }), 404: err[404] } },
      },
      '/sessions/{id}/presentation': {
        parameters: [
          id,
          { name: 'turn', in: 'query', schema: { type: 'string' }, description: 'Turn id or index (negative counts from the end). Default: latest' },
          { name: 'format', in: 'query', schema: { enum: ['json', 'markdown'] } },
        ],
        get: { summary: 'A turn’s presentation as blocks and markdown', responses: { 200: json(ref('Presentation')), 404: err[404] } },
      },
      '/sessions/{id}/reply': {
        parameters: [id],
        post: {
          summary: 'Follow up (answers a pending ask_user question if there is one)',
          requestBody: body({ type: 'object', required: ['text'], properties: { text: { type: 'string' }, attachments: { type: 'array', items: { type: 'string' } }, queue: { type: 'boolean', description: 'Wait for the current run instead of interrupting it' } } }),
          responses: { 200: json({ type: 'object', properties: { answered: { type: 'boolean' }, queued: { type: 'boolean' }, interrupted: { type: 'boolean' }, ahead: { type: 'integer' } } }), 400: err[400] },
        },
      },
      '/sessions/{id}/answer': { parameters: [id], post: { summary: 'Answer the pending ask_user question', requestBody: body({ type: 'object', required: ['text'], properties: { text: { type: 'string' } } }), responses: { 200: ok } } },
      '/sessions/{id}/revert': {
        parameters: [id],
        post: {
          summary: 'Revert (or re-apply) a single file’s changes from a turn',
          requestBody: body({ type: 'object', required: ['file'], properties: { file: { type: 'string' }, turnId: { type: 'string' }, restore: { type: 'boolean' } } }),
          responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' }, turnId: { type: 'string' }, file: { type: 'string' }, reverted: { type: 'boolean' } } }), 400: err[400], 404: err[404] },
        },
      },
      '/sessions/{id}/rollback': {
        parameters: [id],
        post: {
          summary: 'Restore the project working tree to the checkpoint before a turn (or re-apply)',
          requestBody: body({ type: 'object', properties: { turnId: { type: 'string' }, restore: { type: 'boolean' } } }),
          responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' }, turnId: { type: 'string' }, rolledBack: { type: 'boolean' }, files: { type: 'array', items: { type: 'string' } } } }), 400: err[400], 404: err[404] },
        },
      },
      '/sessions/{id}/exec': {
        parameters: [id],
        post: {
          summary: 'Run a shell command from an actionable presentation block in the session’s project folder',
          requestBody: body({ type: 'object', required: ['command'], properties: { command: { type: 'string' }, turnId: { type: 'string' }, key: { type: 'string' } } }),
          responses: { 200: json({ type: 'object', properties: { command: { type: 'string' }, output: { type: 'string' }, exitCode: { type: 'integer' }, durationMs: { type: 'integer' } } }), 400: err[400] },
        },
      },
      '/sessions/{id}/stop': { parameters: [id], post: { summary: 'Stop the run and drop queued follow-ups', responses: { 200: ok } } },
      '/sessions/{id}/queue': { parameters: [id, { name: 'item', in: 'query', required: true, schema: { type: 'string' } }], delete: { summary: 'Cancel a queued follow-up', responses: { 200: ok, 404: err[404] } } },
      '/sessions/{id}/takeover': {
        parameters: [id],
        get: { summary: 'The shell command that resumes this agent session interactively', responses: { 200: json({ type: 'object', properties: { command: { type: 'string' } } }) } },
        post: { summary: 'Stop the run and open the resume command in the user’s terminal', responses: { 200: json({ type: 'object', properties: { command: { type: 'string' } } }) } },
      },
      '/uploads': {
        post: {
          summary: 'Upload an attachment (raw body). Pass the returned id in attachments',
          parameters: [{ name: 'name', in: 'query', schema: { type: 'string' } }, { name: 'type', in: 'query', schema: { type: 'string' }, description: 'MIME type' }],
          requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
          responses: { 201: json({ type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, size: { type: 'integer' }, mime: { type: 'string' } } }) },
        },
      },
      '/events': {
        get: {
          summary: 'Server-sent events: summary, activity, turn, finished, removed, config, preferences, ping',
          responses: { 200: { description: 'text/event-stream', content: { 'text/event-stream': { schema: { type: 'string' } } } } },
        },
      },
    },
    components: {
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'string' } } },
        Health: { type: 'object', properties: { ok: { type: 'boolean' }, name: { const: 'wisp' }, version: { type: 'string' }, apiVersion: { type: 'integer' }, pid: { type: 'integer' }, url: { type: 'string' } } },
        Agent: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, available: { type: 'boolean' }, version: { type: 'string' }, models: { type: 'array', items: { type: 'object' } }, efforts: { type: 'array', items: { type: 'string' } } } },
        Project: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, path: { type: 'string' }, color: { type: 'string' } } },
        Webhook: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' }, events: { type: 'array', items: { enum: ['session.finished', 'session.waiting'] } } } },
        Launch: {
          type: 'object',
          required: ['prompt'],
          properties: {
            prompt: { type: 'string' },
            cwd: { type: 'string', description: 'Project folder (absolute; ~ allowed). Default: the server’s cwd' },
            agent: { enum: ['claude', 'codex', 'opencode', 'cursor', 'antigravity'], default: 'claude' },
            mode: { enum: ['plan', 'edits', 'auto'], default: 'edits' },
            model: { type: 'string' },
            effort: { type: 'string', description: 'Thinking level: low, medium, high, xhigh, max (per harness)' },
            attachments: { type: 'array', items: { type: 'string' }, description: 'Upload ids' },
          },
        },
        Summary: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            agent: { type: 'string' },
            cwd: { type: 'string' },
            project: { type: 'string' },
            projectId: { type: ['string', 'null'] },
            mode: { type: 'string' },
            model: { type: 'string' },
            effort: { type: 'string' },
            state: { enum: ['running', 'waiting', 'review', 'done'] },
            status: { enum: ['running', 'done', 'partial', 'blocked', 'info'] },
            preview: { type: 'string', description: 'The hero summary of the latest turn' },
            live: { type: 'string', description: 'One-line status while running, or the pending question' },
            asks: { type: 'boolean' },
            question: { type: 'string' },
            unread: { type: 'boolean' },
            archived: { type: 'boolean' },
            queued: { type: 'integer' },
            turnCount: { type: 'integer' },
            createdAt: { type: 'integer' },
            updatedAt: { type: 'integer' },
          },
        },
        Presentation: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            turnId: { type: 'string' },
            turnIndex: { type: 'integer' },
            state: { type: 'string' },
            status: { enum: ['running', 'done', 'error', 'stopped'] },
            prompt: { type: 'string' },
            blocks: { type: 'array', items: { type: 'object', required: ['type'], properties: { type: { type: 'string' } } } },
            markdown: { type: 'string' },
            ask: { type: ['object', 'null'], properties: { id: { type: 'string' }, question: { type: 'string' }, context: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } } },
            changes: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, op: { type: 'string' }, edits: { type: 'integer' } } } },
            stats: { type: ['object', 'null'] },
          },
        },
      },
    },
  };
}
