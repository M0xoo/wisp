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
        post: { summary: 'Launch a task. With `compare`, the response is the first session plus `group`: every session started', requestBody: body(ref('Launch')), responses: { 201: json(ref('Summary')), 400: err[400] } },
      },
      '/sessions/{id}': {
        parameters: [id],
        get: { summary: 'Full session record: turns, activity, captured edits, presentations', responses: { 200: json({ type: 'object' }), 404: err[404] } },
        patch: {
          summary: 'Rename, mark done/review, mark read, archive',
          requestBody: body({ type: 'object', properties: { title: { type: 'string' }, state: { enum: ['done', 'review'] }, unread: { type: 'boolean' }, archived: { type: 'boolean' }, discardWorktree: { type: 'boolean', description: 'Remove the worktree and its uncommitted changes (a compare run you did not keep)' } } }),
          responses: { 200: json(ref('Summary')), 404: err[404] },
        },
        delete: { summary: 'Stop and delete. Its worktree is removed; its branch too unless it has commits', responses: { 200: ok, 404: err[404] } },
      },
      '/sessions/{id}/ship': {
        parameters: [id],
        get: { summary: 'What would ship: { branch, base, remote, dirty, ahead, pr, title, body } (drafted from the latest presentation)', responses: { 200: json({ type: 'object' }), 400: err[400] } },
        post: {
          summary: 'Commit uncommitted changes in the worktree, push its branch, open (or update) the pull request with gh',
          requestBody: body({ type: 'object', properties: { title: { type: 'string', description: 'Commit message and PR title' }, body: { type: 'string' }, draft: { type: 'boolean' } } }),
          responses: { 200: json(ref('PullRequest')), 400: err[400], 409: json(ref('Error'), 'Still running') },
        },
      },
      '/sessions/{id}/pr': { parameters: [id], post: { summary: 'Refresh the PR status (checks, review, state) now; it is also polled every minute', responses: { 200: json(ref('PullRequest')), 404: err[404] } } },
      '/sessions/{id}/merge': {
        parameters: [id],
        post: { summary: 'Mark the PR ready if draft, squash-merge it with --match-head-commit, fast-forward the local base branch, remove the worktree', responses: { 200: json({ type: 'object', properties: { pr: ref('PullRequest'), sync: { type: 'object', properties: { ok: { type: 'boolean' }, text: { type: 'string' } } } } }), 400: err[400] } },
      },
      '/recipes': {
        get: { summary: 'Saved recipes, with the {params} found in each prompt', responses: { 200: json({ type: 'array', items: ref('Recipe') }) } },
        post: { summary: 'Save a recipe', requestBody: body(ref('Recipe')), responses: { 201: json(ref('Recipe')), 400: err[400] } },
      },
      '/recipes/{key}': {
        parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' }, description: 'Recipe id or name' }],
        get: { summary: 'One recipe', responses: { 200: json(ref('Recipe')), 404: err[404] } },
        patch: { summary: 'Edit a recipe', requestBody: body(ref('Recipe')), responses: { 200: json(ref('Recipe')), 400: err[400] } },
        delete: { summary: 'Delete a recipe', responses: { 200: ok } },
      },
      '/recipes/{key}/run': {
        parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
        post: {
          summary: 'Run a recipe: fill its {params} and launch',
          requestBody: body({ type: 'object', properties: { params: { type: 'object', additionalProperties: { type: 'string' } }, words: { type: 'array', items: { type: 'string' }, description: 'Positional values, in the order the params appear' }, cwd: { type: 'string', description: 'Used when the recipe has no project of its own' }, agent: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, mode: { enum: ['plan', 'edits', 'auto'] } } }),
          responses: { 201: json(ref('Summary')), 400: err[400], 404: err[404] },
        },
      },
      '/triggers': {
        get: { summary: 'Schedules and GitHub watchers, with nextAt and the last run', responses: { 200: json({ type: 'array', items: ref('Trigger') }) } },
        post: { summary: 'Add a trigger', requestBody: body(ref('Trigger')), responses: { 201: json(ref('Trigger')), 400: err[400] } },
      },
      '/triggers/{tid}': {
        parameters: [{ name: 'tid', in: 'path', required: true, schema: { type: 'string' } }],
        patch: { summary: 'Edit, enable or disable a trigger', requestBody: body(ref('Trigger')), responses: { 200: json(ref('Trigger')), 400: err[400] } },
        delete: { summary: 'Delete a trigger', responses: { 200: ok } },
      },
      '/triggers/{tid}/run': { parameters: [{ name: 'tid', in: 'path', required: true, schema: { type: 'string' } }], post: { summary: 'Fire a schedule now, or poll a watcher now (firing for anything new)', responses: { 200: json({ type: 'object', properties: { started: { type: 'array', items: ref('Summary') }, trigger: ref('Trigger') } }) } } },
      '/remote': {
        get: { summary: 'Phone channels (ntfy, Telegram) with secrets masked, and their status', responses: { 200: json({ type: 'object' }) } },
        put: {
          summary: 'Configure phone channels. A masked token (••••1234) means unchanged',
          requestBody: body({ type: 'object', properties: { events: { type: 'array', items: { enum: ['waiting', 'finished'] } }, ntfy: { type: 'object', properties: { enabled: { type: 'boolean' }, server: { type: 'string' }, topic: { type: 'string' }, token: { type: 'string' } } }, telegram: { type: 'object', properties: { enabled: { type: 'boolean' }, token: { type: 'string' }, unlink: { type: 'boolean' } } } } }),
          responses: { 200: json({ type: 'object' }), 400: err[400] },
        },
      },
      '/remote/test': { post: { summary: 'Send a test message to the enabled channels', responses: { 200: json({ type: 'object' }), 400: err[400] } } },
      '/usage': {
        get: {
          summary: 'Spend and outcomes: totals, per day, per project, per harness · model',
          parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', default: 30, maximum: 365 } }],
          responses: { 200: json({ type: 'object' }) },
        },
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
            worktree: { type: 'boolean', description: 'Run in a fresh git worktree + branch. Default: on in git repos (Settings), off in plan mode' },
            compare: { type: 'array', maxItems: 3, items: { type: 'object', properties: { agent: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' } } }, description: 'Also run the same task on these, each in its own worktree' },
          },
        },
        PullRequest: {
          type: 'object',
          properties: {
            number: { type: 'integer' },
            url: { type: 'string' },
            state: { enum: ['OPEN', 'CLOSED', 'MERGED'] },
            draft: { type: 'boolean' },
            review: { type: 'string', description: 'APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ""' },
            checks: { type: 'object', properties: { pass: { type: 'integer' }, fail: { type: 'integer' }, pending: { type: 'integer' } } },
            head: { type: 'string' },
            base: { type: 'string' },
          },
        },
        Recipe: {
          type: 'object',
          required: ['name', 'prompt'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            prompt: { type: 'string', description: '{name} placeholders become parameters' },
            params: { type: 'array', items: { type: 'string' }, readOnly: true },
            cwd: { type: 'string', description: 'Project path, or empty for any project' },
            agent: { type: 'string' },
            model: { type: 'string' },
            effort: { type: 'string' },
            mode: { enum: ['', 'plan', 'edits', 'auto'] },
          },
        },
        Trigger: {
          type: 'object',
          required: ['kind', 'cwd'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            kind: { enum: ['schedule', 'ci', 'issues'] },
            enabled: { type: 'boolean' },
            cwd: { type: 'string' },
            prompt: { type: 'string', description: 'Template; ci gets {id} {name} {branch} {sha} {url}, issues get {number} {title} {body} {url} {author}' },
            recipeId: { type: 'string', description: 'Run this recipe instead of prompt' },
            params: { type: 'object' },
            cron: { type: 'string', description: 'schedule: 5-field cron, local time' },
            branch: { type: 'string', description: 'ci: only failures on this branch' },
            label: { type: 'string', description: 'issues: the label to watch' },
            every: { type: 'integer', description: 'ci/issues: minutes between polls' },
            agent: { type: 'string' },
            model: { type: 'string' },
            effort: { type: 'string' },
            mode: { enum: ['plan', 'edits', 'auto'] },
            nextAt: { type: ['integer', 'null'], readOnly: true },
            lastRunAt: { type: ['integer', 'null'], readOnly: true },
            lastSessionId: { type: ['string', 'null'], readOnly: true },
            lastError: { type: 'string', readOnly: true },
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
            branch: { type: 'string', description: 'Worktree branch, if it has one' },
            pr: { type: ['object', 'null'], description: 'Its pull request, once shipped' },
            groupId: { type: ['string', 'null'], description: 'Shared by sessions launched together with compare' },
            origin: { type: ['object', 'null'], description: '{ kind: recipe | trigger, id, name } when not launched by hand' },
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
