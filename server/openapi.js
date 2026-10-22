// OpenAPI 3.1 description of the public HTTP API, served at GET /api/openapi.json.
// Feed it to any OpenAPI client generator, Postman, or an agent's tool loader.
// Routes under /api/internal are wisp's own plumbing and deliberately left out.

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const id = { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Session id' };
const body = (schema) => ({ required: true, content: { 'application/json': { schema } } });
const spellId = { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Spell id' };
const err = { 400: json(ref('Error'), 'Bad request'), 404: json(ref('Error'), 'Not found') };
const ok = json({ type: 'object', properties: { ok: { type: 'boolean' } } });

export function openapi({ version, port }) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'wisp',
      version,
      description:
        'Local API of wisp, a launcher and queue for coding agents (Claude Code, Codex, opencode, Cursor, Antigravity, Grok, Copilot). ' +
        'Binds to 127.0.0.1 only. Requests must carry a Host of 127.0.0.1/localhost:<port>; non-GET requests must be ' +
        'application/json (uploads: application/octet-stream) and, if they send an Origin, a local one. ' +
        'The running server advertises { url, port, pid, version } in ~/.wisp/server.json. ' +
        'Behind a reverse proxy (wisp Grid), WISP_TRUSTED_PROXY_SECRET turns on trusted-proxy mode: requests carrying it in ' +
        'x-wisp-proxy-secret may use any Host, and a non-GET Origin must match WISP_PUBLIC_URL.',
    },
    servers: [{ url: `http://127.0.0.1:${port}/api` }],
    paths: {
      '/health': { get: { summary: 'Liveness, version and pid', responses: { 200: json(ref('Health')) } } },
      '/status': { get: { summary: 'Whether anything is going on: turns running (live), side questions (sides), open pages (clients), lastActivityAt, and nextWakeAt (the next scheduled trigger). Used to stop an idle wisp', responses: { 200: json({ type: 'object', properties: { live: { type: 'integer' }, sides: { type: 'integer' }, clients: { type: 'integer' }, lastActivityAt: { type: ['integer', 'null'] }, nextWakeAt: { type: ['integer', 'null'] }, version: { type: 'string' } } }) } } },
      '/update': {
        get: { summary: 'Current and latest published version, and how this copy updates (global | npx | brew | git; a git clone never offers one). ?check forces a registry check', responses: { 200: json({ type: 'object' }) } },
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
      '/agents': { get: { summary: 'Installed harnesses with their models and thinking levels (?fresh=1 detects again)', responses: { 200: json({ type: 'array', items: ref('Agent') }) } } },
      '/router': {
        get: { summary: 'Auto: the goal, settings, every harness · model with its learned chance of success and cost, and recent routes', responses: { 200: json({ type: 'object' }) } },
        patch: { summary: 'Auto settings', requestBody: body({ type: 'object', properties: { goal: { enum: ['cheap', 'balanced', 'best'] }, explore: { type: 'boolean', description: 'Let Auto try new models on a few tasks' }, allowed: { type: 'array', items: { type: 'string' }, description: 'Harness ids Auto may pick; empty or null = all' }, check: { type: 'boolean', description: 'Run the project tests after an Auto run; only new failures count' }, repairs: { type: 'integer', minimum: 0, maximum: 2, description: 'Times failing tests go back to the same agent' }, escalate: { type: 'boolean', description: 'Still failing: run the task again on a stronger pick, in its own worktree' }, best2: { type: 'boolean', description: 'Goal Best: two picks side by side, the better one marked' }, scout: { enum: ['off', 'big', 'all'], description: 'A cheap model looks at the repo first' } } }), responses: { 200: json({ type: 'object' }) } },
      },
      '/router/reset': { post: { summary: 'Forget what Auto learned here (the shipped starting point stays)', responses: { 200: json({ type: 'object' }) } } },
      '/agents/{aid}/login': {
        parameters: [{ name: 'aid', in: 'path', required: true, schema: { type: 'string', enum: ['claude', 'codex', 'cursor', 'grok', 'gh'] } }],
        get: { summary: 'Whether this harness is signed in, and the sign-in in progress: state (idle | running | waiting | done | failed | cancelled), url to open, code to enter there, needsInput when it waits for a code pasted back', responses: { 200: json({ type: 'object' }) } },
        post: { summary: 'Start the harness’s own login (claude auth login, codex login --device-auth, …). Its login stays where the CLI keeps it', responses: { 200: json({ type: 'object' }), 400: err[400] } },
        delete: { summary: 'Cancel the sign-in in progress', responses: { 200: json({ type: 'object' }) } },
      },
      '/agents/{aid}/login/input': { parameters: [{ name: 'aid', in: 'path', required: true, schema: { type: 'string' } }], post: { summary: 'Paste back the code the sign-in page showed', requestBody: body({ type: 'object', required: ['code'], properties: { code: { type: 'string' } } }), responses: { 200: json({ type: 'object' }), 409: json(ref('Error')) } } },
      '/agents/{aid}/logout': { parameters: [{ name: 'aid', in: 'path', required: true, schema: { type: 'string' } }], post: { summary: 'Sign the harness out (its own logout)', responses: { 200: json({ type: 'object' }) } } },
      '/agents/install': {
        post: {
          summary: 'Install a harness into ~/.wisp/tools with npm (only opencode: its free models need no account), then detect again',
          requestBody: body({ type: 'object', required: ['id'], properties: { id: { type: 'string', enum: ['opencode'] } } }),
          responses: { 200: json({ type: 'array', items: ref('Agent') }), 400: err[400] },
        },
      },
      '/agents/recheck': { post: { summary: 'Detect harnesses and models again, here and on every online machine', responses: { 200: json({ type: 'array', items: ref('Agent') }) } } },
      '/feedback': {
        post: {
          summary: 'Send feedback to the wisp team: thumbs on a turn and/or a note. Sent even with usage stats off; WISP_FEEDBACK=0 turns it off',
          requestBody: body({
            type: 'object',
            properties: {
              rating: { type: ['string', 'null'], enum: ['up', 'down', null], description: 'With turnId: kept on that turn; null takes it back' },
              text: { type: 'string', maxLength: 4000 },
              sessionId: { type: 'string', description: 'Adds that run\'s harness, model and status (never the prompt or result)' },
              turnId: { type: 'string' },
              source: { type: 'string', description: 'turn | command | dialog' },
            },
          }),
          responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' }, sent: { type: 'boolean', description: 'false: kept in ~/.wisp/feedback-outbox.json and retried' }, available: { type: 'boolean' } } }), 400: err[400] },
        },
      },
      '/telemetry/event': {
        post: {
          summary: 'Count a click on the page in the anonymous usage stats (a fixed list of events and values; anything else is ignored). Nothing is sent with usage stats off',
          requestBody: body({ type: 'object', required: ['event'], properties: { event: { type: 'string', enum: ['getapp_opened', 'getapp_clicked', 'getapp_hidden'] }, props: { type: 'object' } } }),
          responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' }, tracked: { type: 'boolean' } } }) },
        },
      },
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
        post: {
          summary: 'Add a folder as a project, or clone a repo URL and add the clone',
          requestBody: body({
            type: 'object',
            properties: {
              path: { type: 'string', description: 'A folder, or a repo URL (https://github.com/o/r, git@host:o/r.git, o/r)' },
              repo: { type: 'string', description: 'A repo URL to clone into defaults.cloneDir (default ~/code), then add' },
              name: { type: 'string' },
              machine: { type: 'string', description: 'Add (or clone) it on this machine' },
            },
          }),
          responses: { 201: json(ref('Project')), 400: err[400] },
        },
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
      '/sessions/{id}/fix-conflicts': { parameters: [id], post: { summary: 'Fix the PR\'s merge conflicts now (the PR row\'s Fix conflicts button): a follow-up merges the base in, then wisp pushes to the PR', responses: { 200: json({ type: 'object' }), 400: err[400] } } },
      '/sessions/{id}/merge': {
        parameters: [id],
        post: { summary: 'Mark the PR ready if draft, squash-merge it with --match-head-commit, fast-forward the local base branch, remove the worktree', responses: { 200: json({ type: 'object', properties: { pr: ref('PullRequest'), sync: { type: 'object', properties: { ok: { type: 'boolean' }, text: { type: 'string' } } } } }), 400: err[400] } },
      },
      '/teams': {
        get: { summary: 'Saved subagent presets: a team the lead can delegate to', responses: { 200: json({ type: 'array', items: ref('Team') }) } },
        post: { summary: 'Save a subagent preset', requestBody: body(ref('Team')), responses: { 201: json(ref('Team')), 400: err[400] } },
      },
      '/teams/{tid}': {
        parameters: [{ name: 'tid', in: 'path', required: true, schema: { type: 'string' } }],
        get: { summary: 'One subagent preset', responses: { 200: json(ref('Team')), 404: err[404] } },
        patch: { summary: 'Edit a subagent preset', requestBody: body(ref('Team')), responses: { 200: json(ref('Team')), 400: err[400], 404: err[404] } },
        delete: { summary: 'Delete a subagent preset', responses: { 200: ok, 404: err[404] } },
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
          requestBody: body({ type: 'object', properties: { events: { type: 'array', items: { enum: ['waiting', 'finished'] } }, ntfy: { type: 'object', properties: { enabled: { type: 'boolean' }, server: { type: 'string' }, topic: { type: 'string' }, token: { type: 'string' } } }, telegram: { type: 'object', properties: { enabled: { type: 'boolean' }, token: { type: 'string' }, unlink: { type: 'boolean' }, allowStart: { type: 'boolean', description: '/new in the linked chat starts tasks' }, project: { type: 'string', description: 'Project id /new uses without @name; empty = last used' } } } } }),
          responses: { 200: json({ type: 'object' }), 400: err[400] },
        },
      },
      '/machines': {
        get: { summary: 'Machines (other computers over SSH) with connection state, steps, hints and their wisp version and harnesses', responses: { 200: json({ type: 'array', items: { type: 'object' } }) } },
        post: {
          summary: 'Add a machine and connect (unless connect: false). wisp starts itself there over SSH and tunnels back',
          requestBody: body({ type: 'object', required: ['target'], properties: { target: { type: 'string', description: 'user@host, a host, or a Host from ~/.ssh/config' }, name: { type: 'string' }, port: { type: 'integer', default: 4477, description: 'wisp port on the machine' }, command: { type: 'string', description: 'Start command; default npx -y wisp-agents@<this version>' }, autoConnect: { type: 'boolean', default: true }, connect: { type: 'boolean', default: true } } }),
          responses: { 201: json({ type: 'object' }), 400: err[400] },
        },
      },
      '/cloud/signin': { post: { summary: 'Sign in to a wisp Grid (device flow): returns the code to approve in the browser and where; the cloud computer joins Machines once approved', requestBody: body({ type: 'object', required: ['url'], properties: { url: { type: 'string', description: 'The grid, e.g. wisp.example.com' } } }), responses: { 201: json(ref('CloudSignin')), 400: err[400] } } },
      '/cloud/signin/{sid}': { parameters: [{ name: 'sid', in: 'path', required: true, schema: { type: 'string' } }], get: { summary: 'Where a grid sign-in is: waiting, done, denied, expired, failed or cancelled', responses: { 200: json(ref('CloudSignin')), 404: err[404] } }, delete: { summary: 'Cancel a grid sign-in', responses: { 200: json(ref('CloudSignin')), 404: err[404] } } },
      '/machines/discover': { get: { summary: 'Hosts this computer can reach: ~/.ssh/config, Tailscale peers, ~/.ssh/known_hosts', responses: { 200: json({ type: 'array', items: { type: 'object' } }) } } },
      '/machines/reachable': { get: { summary: 'Whether other devices can reach this computer over SSH: SSH server, Tailscale, authorized keys, and the user@host to connect with', responses: { 200: json({ type: 'object', properties: { os: { type: 'string' }, user: { type: 'string' }, target: { type: 'string' }, supported: { type: 'boolean' }, keys: { type: 'integer' }, ssh: { type: 'object' }, tailscale: { type: 'object' } } }) } } },
      '/machines/ssh-hosts': { get: { summary: 'Hosts from ~/.ssh/config, for suggestions', responses: { 200: json({ type: 'array', items: { type: 'object' } }) } } },
      '/machines/{mid}': { parameters: [{ name: 'mid', in: 'path', required: true, schema: { type: 'string' } }], patch: { summary: 'Edit a machine (host, port or command changes reconnect)', responses: { 200: json({ type: 'object' }) } }, delete: { summary: 'Remove a machine and its projects here (nothing on the machine is touched)', responses: { 200: json({ type: 'object' }) } } },
      '/machines/{mid}/let-in': { parameters: [{ name: 'mid', in: 'path', required: true, schema: { type: 'string' } }], post: { summary: 'Sign in with the password once to add this computer\'s SSH key on the machine, then connect. The password is not stored', requestBody: body({ type: 'object', required: ['password'], properties: { password: { type: 'string' } } }), responses: { 200: json({ type: 'object' }) } } },
      '/machines/{mid}/connect': { parameters: [{ name: 'mid', in: 'path', required: true, schema: { type: 'string' } }], post: { summary: 'Connect: SSH in, start wisp there if needed, open the tunnel', responses: { 200: json({ type: 'object' }) } } },
      '/machines/{mid}/disconnect': { parameters: [{ name: 'mid', in: 'path', required: true, schema: { type: 'string' } }], post: { summary: 'Close the tunnel; wisp and its agents keep running there', responses: { 200: json({ type: 'object' }) } } },
      '/machines/{mid}/stop': { parameters: [{ name: 'mid', in: 'path', required: true, schema: { type: 'string' } }], post: { summary: 'Stop wisp on the machine (its agents too); restart: true starts this version in its place', requestBody: body({ type: 'object', properties: { restart: { type: 'boolean' } } }), responses: { 200: json({ type: 'object' }) } } },
      '/machines/{mid}/agents/{aid}/login': {
        parameters: [{ name: 'mid', in: 'path', required: true, schema: { type: 'string' } }, { name: 'aid', in: 'path', required: true, schema: { type: 'string' } }],
        get: { summary: 'A harness’s sign-in on the machine (as GET /agents/{aid}/login there)', responses: { 200: json({ type: 'object' }) } },
        post: { summary: 'Start the harness’s own login on the machine', responses: { 200: json({ type: 'object' }) } },
        delete: { summary: 'Cancel the sign-in on the machine', responses: { 200: json({ type: 'object' }) } },
      },
      '/machines/{mid}/agents/{aid}/login/input': { parameters: [{ name: 'mid', in: 'path', required: true, schema: { type: 'string' } }, { name: 'aid', in: 'path', required: true, schema: { type: 'string' } }], post: { summary: 'Paste back the code, on the machine', requestBody: body({ type: 'object', required: ['code'], properties: { code: { type: 'string' } } }), responses: { 200: json({ type: 'object' }) } } },
      '/machines/{mid}/agents/{aid}/logout': { parameters: [{ name: 'mid', in: 'path', required: true, schema: { type: 'string' } }, { name: 'aid', in: 'path', required: true, schema: { type: 'string' } }], post: { summary: 'Sign the harness out on the machine', responses: { 200: json({ type: 'object' }) } } },
      '/machines/{mid}/fs': { parameters: [{ name: 'mid', in: 'path', required: true, schema: { type: 'string' } }, { name: 'q', in: 'query', schema: { type: 'string' } }], get: { summary: 'Folder suggestions on the machine', responses: { 200: json({ type: 'array', items: { type: 'string' } }) } } },
      '/machines/{mid}/discover': { parameters: [{ name: 'mid', in: 'path', required: true, schema: { type: 'string' } }], get: { summary: 'Git repos found on the machine that are not projects yet', responses: { 200: json({ type: 'array', items: { type: 'object' } }) } } },
      '/remote/test': { post: { summary: 'Send a test message to the enabled channels', responses: { 200: json({ type: 'object' }), 400: err[400] } } },
      '/usage': {
        get: {
          summary: 'Spend and outcomes: totals, per day, per project, per harness · model',
          parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', default: 30, maximum: 365 } }],
          responses: { 200: json({ type: 'object' }) },
        },
      },
      '/usage/tools': {
        get: {
          summary: 'Tool calls by kind, harness, project and day, with turns, cost and success rate (what wisp_stats tells agents)',
          parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', default: 30, maximum: 365 } }, { name: 'agent', in: 'query', schema: { type: 'string' } }, { name: 'project', in: 'query', schema: { type: 'string' }, description: 'Project id or name' }],
          responses: { 200: json({ type: 'object' }) },
        },
      },
      '/spells': {
        get: { summary: 'Every spell: its JSON, on or off, where it came from, a plain-words summary and its kind (safe | acts | reads | runs); broken files; safe mode', responses: { 200: json({ type: 'object' }) } },
        post: {
          summary: 'Install or update a spell from { spell }, { text } (pasted JSON) or { url } (https or gist:<id>). It stays off unless enable: true',
          requestBody: body({ type: 'object', properties: { spell: { type: 'object' }, text: { type: 'string' }, url: { type: 'string' }, enable: { type: 'boolean' } } }),
          responses: { 200: json({ type: 'object' }), 201: json({ type: 'object' }), 400: err[400], 409: json({ type: 'object' }) },
        },
      },
      '/spells/check': {
        post: {
          summary: 'Validate a spell without installing it: { ok, spell, summary, kind, warnings, installed } or { ok: false, problems }',
          requestBody: body({ type: 'object', properties: { spell: { type: 'object' }, text: { type: 'string' }, url: { type: 'string' } } }),
          responses: { 200: json({ type: 'object' }), 400: err[400] },
        },
      },
      '/spells/try-data': { post: { summary: "Fetch a data source of a spell that isn't installed (Try it); the spell is validated first", requestBody: body({ type: 'object', required: ['spell', 'name'], properties: { spell: { type: 'object' }, name: { type: 'string' }, session: { type: 'string' } } }), responses: { 200: json({ type: 'object', properties: { value: {} } }), 400: err[400], 404: err[404] } } },
      '/spells/off': { post: { summary: 'Turn every spell off', responses: { 200: json({ type: 'object' }) } } },
      '/spells/{id}': {
        parameters: [spellId],
        get: { summary: 'One spell', responses: { 200: json({ type: 'object' }), 404: err[404] } },
        patch: { summary: 'Turn a spell on or off. 409 when its block types or slash commands clash with one that is on', requestBody: body({ type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } }), responses: { 200: json({ type: 'object' }), 404: err[404], 409: json({ type: 'object' }) } },
        delete: { summary: 'Remove a spell', responses: { 200: json({ type: 'object' }), 404: err[404] } },
      },
      '/spells/{id}/export': { parameters: [spellId], get: { summary: 'The spell file to share (.spell.json)', responses: { 200: json({ type: 'object' }), 404: err[404] } } },
      '/spells/{id}/data/{name}': {
        parameters: [spellId, { name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        post: { summary: "Fetch one of a spell's data sources. session: the card's task, for per-task sources; fresh skips the cache", requestBody: body({ type: 'object', properties: { session: { type: 'string' }, fresh: { type: 'boolean' } } }), responses: { 200: json({ type: 'object', properties: { value: {} } }), 404: err[404] } },
      },
      '/open': { post: { summary: 'Open http(s) links in the default browser (at most 20)', requestBody: body({ type: 'object', required: ['urls'], properties: { urls: { type: 'array', items: { type: 'string' } } } }), responses: { 200: json({ type: 'object' }), 400: err[400] } } },
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
          summary: 'Follow up (answers a pending ask_user question if there is one). Text starting with /btw is a side question instead (see /btw)',
          requestBody: body({ type: 'object', required: ['text'], properties: { text: { type: 'string' }, attachments: { type: 'array', items: { type: 'string' } }, queue: { type: 'boolean', description: 'Wait for the current run instead of interrupting it' }, mode: { enum: ['plan', 'edits', 'auto'], description: 'Switch the session to this mode from this follow-up on' }, agent: { type: 'string', description: 'Switch to this harness from this follow-up on; it is handed the turns it has not seen' }, model: { type: 'string', description: 'Switch model (empty: the harness default)' }, effort: { type: 'string', description: 'Switch thinking level (empty: the default)' } } }),
          responses: { 200: json({ type: 'object', properties: { answered: { type: 'boolean' }, queued: { type: 'boolean' }, interrupted: { type: 'boolean' }, ahead: { type: 'integer' }, btw: ref('Btw') } }), 400: err[400] },
        },
      },
      '/sessions/{id}/btw': {
        parameters: [id],
        post: {
          summary: 'Ask a side question without interrupting: a read-only run of its own answers it (on a fork of the agent’s conversation where the harness can fork) and the answer lands on the latest turn’s btw list',
          requestBody: body({ type: 'object', required: ['text'], properties: { text: { type: 'string', description: 'The question; a leading /btw is dropped' }, attachments: { type: 'array', items: { type: 'string' } } } }),
          responses: { 200: json(ref('Btw')), 400: err[400], 404: err[404], 429: err[400] },
        },
        delete: { summary: 'Dismiss a side question (stops its run if it is still answering)', parameters: [{ name: 'item', in: 'query', required: true, schema: { type: 'string' } }], responses: { 200: ok, 404: err[404] } },
      },
      '/sessions/{id}/answer': { parameters: [id], post: { summary: 'Answer the pending ask_user question (or approval: Allow, Always allow in this task, Deny, or what to do instead)', requestBody: body({ type: 'object', required: ['text'], properties: { text: { type: 'string' } } }), responses: { 200: ok } } },
      '/sessions/{id}/approve': { parameters: [id], post: { summary: 'Allow and retry (or deny) what a finished turn’s permissions blocked', requestBody: body({ type: 'object', properties: { turnId: { type: 'string' }, allow: { type: 'boolean', description: 'Default true' } } }), responses: { 200: ok } } },
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
      '/uploads/{uid}': {
        parameters: [{ name: 'uid', in: 'path', required: true, schema: { type: 'string' }, description: 'Upload id (<id>@<machine> for one on a machine)' }],
        get: { summary: 'The uploaded file, with its MIME type', responses: { 200: { description: 'The file' }, 404: err[404] } },
      },
      '/events': {
        get: {
          summary: 'Server-sent events: summary, activity, turn, finished, removed, config, preferences, agents, ping',
          responses: { 200: { description: 'text/event-stream', content: { 'text/event-stream': { schema: { type: 'string' } } } } },
        },
      },
    },
    components: {
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'string' } } },
        CloudSignin: { type: 'object', properties: { id: { type: 'string' }, grid: { type: 'string' }, state: { enum: ['waiting', 'done', 'denied', 'expired', 'failed', 'cancelled'] }, userCode: { type: 'string' }, verifyUrl: { type: 'string' }, expiresAt: { type: 'integer' }, error: { type: 'string' }, machineId: { type: ['string', 'null'] }, user: { type: ['object', 'null'] } } },
        Health: { type: 'object', properties: { ok: { type: 'boolean' }, name: { const: 'wisp' }, version: { type: 'string' }, apiVersion: { type: 'integer' }, pid: { type: 'integer' }, url: { type: 'string' } } },
        Agent: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, available: { type: 'boolean' }, version: { type: 'string' }, models: { type: 'array', items: { type: 'object' } }, efforts: { type: 'array', items: { type: 'string' } }, setup: { type: 'object', description: 'Only while not found: how to get it on that OS', properties: { tip: { type: 'string' }, command: { type: 'string' }, url: { type: 'string' } } } } },
        Project: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, path: { type: 'string' }, color: { type: 'string' } } },
        Webhook: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' }, events: { type: 'array', items: { enum: ['session.finished', 'session.waiting'] } } } },
        Launch: {
          type: 'object',
          required: ['prompt'],
          properties: {
            prompt: { type: 'string' },
            cwd: { type: 'string', description: 'Project folder (absolute; ~ allowed). Default: the server’s cwd' },
            also: { type: 'array', maxItems: 8, items: { type: 'string' }, description: 'More folders the same task works in (absolute; ~ allowed). The agent gets each; git repos get their own worktree, and Ship it opens a PR in each' },
            scratch: { type: 'boolean', description: 'No project folder: run in an empty scratch directory (no worktree). Overrides cwd' },
            kind: { type: 'string', enum: ['spell'], description: 'spell: Cast a spell. The agent writes a spell that changes wisp (an empty scratch folder, Edits mode, this computer); its report ends with a spell block to keep' },
            agent: { enum: ['auto', 'claude', 'codex', 'opencode', 'cursor', 'antigravity', 'grok', 'copilot'], default: 'auto', description: 'auto: wisp picks the harness and model from what worked before; model is then the goal (cheap, balanced, best)' },
            important: { type: 'boolean', description: 'With agent auto: no exploring, take the pick with the best record' },
            mode: { enum: ['plan', 'edits', 'auto'], default: 'auto' },
            model: { type: 'string' },
            effort: { type: 'string', description: 'Thinking level: low, medium, high, xhigh, max (per harness)' },
            attachments: { type: 'array', items: { type: 'string' }, description: 'Upload ids' },
            worktree: { type: 'boolean', description: 'Run in a fresh git worktree + branch. Default: on in git repos (Settings), off in plan mode' },
            subagents: { type: 'array', maxItems: 6, items: { type: 'object', required: ['agent'], properties: { name: { type: 'string' }, agent: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, use: { type: 'string', description: 'When the lead should pick this one' }, count: { type: 'integer', minimum: 1, maximum: 5, description: 'Identical copies that take tasks in parallel (name#1, name#2, …); 12 in all' } } }, description: 'A team the lead can delegate to through the injected `delegate` tool. Each runs as a child session in the lead’s folder' },
            preset: { type: 'string', description: 'Id of a saved team (`/teams`), used when `subagents` is absent' },
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
            conflict: { type: 'boolean', description: 'GitHub cannot merge it into its base: merge conflicts' },
            head: { type: 'string' },
            base: { type: 'string' },
          },
        },
        Team: {
          type: 'object',
          required: ['name', 'members'],
          properties: {
            id: { type: 'string', readOnly: true },
            name: { type: 'string' },
            members: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, agent: { type: 'string', description: 'Harness id, or auto' }, model: { type: 'string' }, effort: { type: 'string' }, use: { type: 'string', description: 'What the lead should use it for' }, count: { type: 'integer', minimum: 1 } } } },
            updatedAt: { type: 'integer', readOnly: true },
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
            shipping: { type: ['object', 'null'], description: "{ step: start | commit | push | pr, update } while Ship it runs" },
            conflictFix: { type: ['object', 'null'], description: "{ step: fixing | pushing | done | failed, why } while wisp fixes the PR's merge conflicts: after Fix conflicts, or on its own with defaults.fixConflicts: 'on'" },
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
        Btw: {
          type: 'object',
          description: 'A side question (/btw). It sits on turns[].btw of the turn it was asked during; GET the session or wait for its turn event to see the answer',
          properties: {
            id: { type: 'string' },
            question: { type: 'string' },
            status: { enum: ['running', 'done', 'error'] },
            answer: { type: 'string', description: 'Markdown, once done' },
            error: { type: 'string' },
            forked: { type: 'boolean', description: 'Answered on a copy of the agent’s conversation (else from wisp’s record of the task)' },
            agent: { type: 'string' },
            model: { type: 'string' },
            askedAt: { type: 'integer' },
            answeredAt: { type: 'integer' },
          },
        },
      },
    },
  };
}
