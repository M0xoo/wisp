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
        get: { summary: 'Current and latest published version on the update channel (defaults.updateChannel: stable | beta | nightly), and how this copy updates (global | npx | brew | app | git; a git clone never offers one). ?check forces a registry check', responses: { 200: json({ type: 'object' }) } },
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
        parameters: [{ name: 'aid', in: 'path', required: true, schema: { type: 'string', enum: ['claude', 'codex', 'cursor', 'grok', 'gh'] } }, { name: 'account', in: 'query', schema: { type: 'string' }, description: 'One of the harness’s extra accounts; none: the CLI’s own' }],
        get: { summary: 'Whether this harness is signed in, and the sign-in in progress: state (idle | running | waiting | done | failed | cancelled), url to open, code to enter there, needsInput when it waits for a code pasted back', responses: { 200: json({ type: 'object' }) } },
        post: { summary: 'Start the harness’s own login (claude auth login, codex login --device-auth, …). Its login stays where the CLI keeps it', responses: { 200: json({ type: 'object' }), 400: err[400] } },
        delete: { summary: 'Cancel the sign-in in progress', responses: { 200: json({ type: 'object' }) } },
      },
      '/agents/{aid}/login/input': { parameters: [{ name: 'aid', in: 'path', required: true, schema: { type: 'string' } }], post: { summary: 'Paste back the code the sign-in page showed', requestBody: body({ type: 'object', required: ['code'], properties: { code: { type: 'string' } } }), responses: { 200: json({ type: 'object' }), 409: json(ref('Error')) } } },
      '/agents/{aid}/logout': { parameters: [{ name: 'aid', in: 'path', required: true, schema: { type: 'string' } }], post: { summary: 'Sign the harness out (its own logout)', responses: { 200: json({ type: 'object' }) } } },
      '/agents/{aid}/accounts': {
        parameters: [{ name: 'aid', in: 'path', required: true, schema: { type: 'string', enum: ['claude', 'codex'] } }],
        get: { summary: 'The harness’s accounts (several subscriptions), in your order: id, label, email, plan, kind (personal | work), default, state (ready | limit | signedOut), until. wisp never switches accounts at a limit; the turn asks (turn.limit)', responses: { 200: json({ type: 'object' }) } },
        post: { summary: 'Add an account: a login folder of its own, linked to the CLI’s for everything but the login. Its sign-in starts at once (login)', requestBody: body({ type: 'object', properties: { label: { type: 'string' }, kind: { type: 'string', enum: ['personal', 'work'], description: 'None: guessed from its plan once signed in' } } }), responses: { 200: json({ type: 'object' }), 400: err[400] } },
      },
      '/agents/{aid}/accounts/{acc}': {
        parameters: [{ name: 'aid', in: 'path', required: true, schema: { type: 'string' } }, { name: 'acc', in: 'path', required: true, schema: { type: 'string' } }],
        patch: { summary: 'Rename an account, set its kind, or move it up or down your order', requestBody: body({ type: 'object', properties: { label: { type: 'string' }, kind: { type: 'string', enum: ['personal', 'work'] }, move: { type: 'string', enum: ['up', 'down'] } } }), responses: { 200: json({ type: 'object' }), 404: err[404] } },
        delete: { summary: 'Sign an extra account out and remove it (not the CLI’s own)', responses: { 200: json({ type: 'object' }), 400: err[400] } },
      },
      '/agents/{aid}/keys': {
        parameters: [{ name: 'aid', in: 'path', required: true, schema: { type: 'string', enum: ['opencode'] } }],
        get: { summary: 'Which providers of a harness that signs in with an API key have one (opencode: Zen, Go). Never the key', responses: { 200: json({ type: 'object' }), 400: err[400] } },
        post: { summary: 'Save a provider’s API key where the harness keeps it (opencode: auth.json), then detect its models again', requestBody: body({ type: 'object', required: ['provider', 'key'], properties: { provider: { type: 'string', enum: ['opencode', 'opencode-go'] }, key: { type: 'string' } } }), responses: { 200: json({ type: 'object' }), 400: err[400] } },
      },
      '/agents/{aid}/keys/{provider}': { parameters: [{ name: 'aid', in: 'path', required: true, schema: { type: 'string' } }, { name: 'provider', in: 'path', required: true, schema: { type: 'string', enum: ['opencode', 'opencode-go'] } }], delete: { summary: 'Remove a provider’s API key', responses: { 200: json({ type: 'object' }), 400: err[400] } } },
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
          requestBody: body({ type: 'object', properties: { title: { type: 'string' }, state: { enum: ['done', 'review'] }, unread: { type: 'boolean' }, archived: { type: 'boolean' }, forLater: { type: ['boolean', 'number'], description: 'Save a finished task for later (true, or the time it was saved, to put it back in its place) or unsave it (false)' }, discardWorktree: { type: 'boolean', description: 'Remove the worktree and its uncommitted changes (a compare run you did not keep)' } } }),
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
      '/connectors': {
        get: { summary: 'Your connectors (MCP servers every task gets, whatever the harness): id, name, transport (local | remote), command and args or url, env and headers as { key, set } (never their values), enabled, test (the last check: ok, tools, count or error), testing, own (harnesses whose own config already has a server by that name: they keep theirs). Also found: servers in Claude Code, Codex, Copilot, OpenCode and Cursor configs that aren’t connectors yet, and reach: the harnesses connectors go to. Plan mode gets none', responses: { 200: json({ type: 'object' }) } },
        post: { summary: 'Add a connector. Its env values (local) or headers (remote) are kept in secrets.json; a token in the command or URL is refused. It is checked at once in the background', requestBody: body({ type: 'object', required: ['name'], properties: { name: { type: 'string', description: 'Lowercase letters, digits and _; not wisp' }, transport: { enum: ['local', 'remote'] }, command: { type: 'string', description: 'The command line (split shell-style), or the program when args is given' }, args: { type: 'array', items: { type: 'string' } }, url: { type: 'string', description: 'Streamable HTTP endpoint (or an older SSE one ending in /sse)' }, env: { type: 'object', additionalProperties: { type: ['string', 'null'] }, description: 'KEY: value. Empty or null keeps a saved value' }, headers: { type: 'object', additionalProperties: { type: ['string', 'null'] } }, enabled: { type: 'boolean' } } }), responses: { 201: json({ type: 'object' }), 400: err[400] } },
      },
      '/connectors/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Connector id' }],
        patch: { summary: 'Change a connector (same fields as POST). env / headers list every key it keeps; one left out is deleted', requestBody: body({ type: 'object' }), responses: { 200: json({ type: 'object' }), 400: err[400], 404: err[404] } },
        delete: { summary: 'Remove a connector and its secrets', responses: { 200: json({ type: 'object' }), 404: err[404] } },
      },
      '/connectors/{id}/test': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], post: { summary: 'Start it the way an agent would and list its tools; the outcome is kept as test', responses: { 200: json({ type: 'object' }), 404: err[404] } } },
      '/connectors/{id}/signin': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        post: { summary: 'Sign in to a remote connector with OAuth (MCP authorization: discovery, dynamic client registration, PKCE). Returns { url } to open in a browser; it comes back to origin + /api/connectors/oauth/callback, and the tokens stay in secrets.json, refreshed by wisp', requestBody: body({ type: 'object', required: ['origin'], properties: { origin: { type: 'string', description: 'This wisp’s address as the browser sees it' } } }), responses: { 200: json({ type: 'object', properties: { url: { type: 'string' } } }), 400: err[400], 404: err[404] } },
        delete: { summary: 'Sign out: forget its tokens', responses: { 200: json({ type: 'object' }), 404: err[404] } },
      },
      '/connectors/import': { post: { summary: 'Add servers found in the harnesses’ own configs (names from found); their secrets are read on the server. dismiss hides names from found. skipped lists the ones refused, with why', requestBody: body({ type: 'object', properties: { names: { type: 'array', items: { type: 'string' } }, dismiss: { type: 'array', items: { type: 'string' } } } }), responses: { 200: json({ type: 'object' }) } } },
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
      '/later': {
        get: { summary: 'Tasks and reminders scheduled for later (they start when due)', responses: { 200: json({ type: 'array', items: { type: 'object' } }) } },
        post: { summary: 'Schedule a task ({ kind: "task", at | in, prompt, cwd, agent, … as POST /sessions }) or a reminder ({ kind: "reminder", at | in, text })', requestBody: body({ type: 'object' }), responses: { 201: json({ type: 'object' }), 400: err[400] } },
      },
      '/later/{lid}': {
        parameters: [{ name: 'lid', in: 'path', required: true, schema: { type: 'string' } }],
        patch: { summary: 'Change when it runs ({ at | in }), its text or prompt, or start it now ({ now: true })', requestBody: body({ type: 'object' }), responses: { 200: json({ type: 'object' }), 400: err[400], 404: err[404] } },
        delete: { summary: 'Cancel a scheduled task or reminder', responses: { 200: ok, 404: err[404] } },
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
      '/crew': {
        get: { summary: 'Your crew: long-lived agents with a name, role, avatar, brief, schedule and memory (notebook, log). Their work runs as tasks (jobs, `crew` on a session summary); running counts jobs now, nextAt is the next check-in', responses: { 200: json({ type: 'array', items: ref('CrewMember') }) } },
        post: { summary: 'Add a crew member. checkin: true starts its first check-in at once', requestBody: body(ref('CrewMember')), responses: { 201: json(ref('CrewMember')), 400: err[400] } },
      },
      '/crew-kit': {
        get: {
          summary: 'Skills (SKILL.md folders in ~/.claude/skills, ~/.agents/skills, …) and instructions files (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, …) on this computer, to add to a crew member’s kit. cwd: a project’s too',
          parameters: [{ name: 'cwd', in: 'query', schema: { type: 'string' } }],
          responses: { 200: json({ type: 'object', properties: { skills: { type: 'array', items: { type: 'object' } }, rules: { type: 'array', items: { type: 'object' } } } }) },
        },
      },
      '/crew/{cid}': {
        parameters: [{ name: 'cid', in: 'path', required: true, schema: { type: 'string' }, description: 'Crew member id or name' }],
        get: { summary: 'A crew member, with its latest jobs (jobList)', responses: { 200: json(ref('CrewMember')), 404: err[404] } },
        patch: { summary: 'Edit a crew member: who it is, its brief, schedule, limits, notebook, paused. queue: the ids of waiting jobs to keep', requestBody: body(ref('CrewMember')), responses: { 200: json(ref('CrewMember')), 400: err[400] } },
        delete: { summary: 'Remove a crew member. Its jobs stay as tasks; triggers sending it work are turned off', responses: { 200: ok } },
      },
      '/crew/{cid}/jobs': {
        parameters: [{ name: 'cid', in: 'path', required: true, schema: { type: 'string' } }],
        post: { summary: 'Hand a crew member a job. Past its parallel limit it waits in the member’s queue ({ queued })', requestBody: body({ type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' }, attachments: { type: 'array', items: { type: 'string' } }, kit: { type: 'boolean', description: 'They build their own kit: study the job and the project, then propose skills and instructions files (offers) for you to pick from. prompt is the goal' } } }), responses: { 201: json({ type: 'object', properties: { session: ref('Summary'), queued: { type: 'integer' }, member: ref('CrewMember') } }), 400: err[400] } },
      },
      '/crew/{cid}/detach': {
        parameters: [{ name: 'cid', in: 'path', required: true, schema: { type: 'string' } }],
        post: { summary: 'Make a member a spell brought yours (Make it mine): the spell no longer changes them, and everything about them can be edited', responses: { 200: json(ref('CrewMember')), 400: err[400], 404: err[404] } },
      },
      '/crew/export': {
        post: {
          summary: 'Share crew members: their .crew.json file ({ wispCrew: 1, members: [blueprint] }: who they are, never their folder, machine or log), notes on what stays here, and with gist: true a secret gist of it. 422 with hits when the secret scan finds a key or token in a brief, notebook or kit file',
          requestBody: body({ type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string' }, description: 'Member ids, names or handles' }, kit: { type: 'boolean', description: 'Their skills and instructions files (default true)' }, notebook: { type: 'boolean', description: 'Their notebook (default false)' }, team: { type: 'boolean', description: 'The crew members they delegate to, too' }, gist: { type: 'boolean', description: 'Post it to a secret gist with gh' } } }),
          responses: { 200: json({ type: 'object', properties: { bundle: { type: 'object' }, notes: { type: 'array', items: { type: 'string' } }, file: { type: 'string' }, gist: { type: 'object', properties: { url: { type: 'string' }, ref: { type: 'string' } } } } }), 404: err[404], 422: json({ type: 'object', properties: { error: { type: 'string' }, hits: { type: 'array', items: { type: 'object' } } } }, 'A secret in what would be shared') },
        },
      },
      '/crew/import': {
        post: {
          summary: 'Add members someone shared: { text } (a .crew.json file or JSON), { url } (https or gist:<id>) or { bundle }. dryRun: the review (members with the name they get, harness, notes, needsProject), nothing added. choices: { [key]: { name, cwd, skip } }. They join paused, with the triggers that send them work; a CI watcher needs a cwd. A spell answers { spell }',
          requestBody: body({ type: 'object', properties: { text: { type: 'string' }, url: { type: 'string' }, bundle: { type: 'object' }, dryRun: { type: 'boolean' }, choices: { type: 'object' } } }),
          responses: { 200: json({ type: 'object', properties: { members: { type: 'array', items: { type: 'object' } }, room: { type: 'integer' }, spell: { type: 'object' } } }), 201: json({ type: 'object', properties: { members: { type: 'array', items: ref('CrewMember') } } }), 400: err[400] },
        },
      },
      '/crew/{cid}/checkin': {
        parameters: [{ name: 'cid', in: 'path', required: true, schema: { type: 'string' } }],
        post: { summary: 'Start a check-in now (409 while one runs)', responses: { 201: json({ type: 'object', properties: { session: ref('Summary'), queued: { type: 'integer' }, member: ref('CrewMember') } }), 409: json(ref('Error'), 'Already checking in') } },
      },
      '/sessions/{id}/crew-reply': {
        parameters: [id],
        post: { summary: 'Reply to a crew member’s answer on this task (one of its btw entries with `crew`): the member’s job carries on, and its answer lands right under your reply (entry.thread names the first one)', requestBody: body({ type: 'object', required: ['entry', 'text'], properties: { entry: { type: 'string' }, text: { type: 'string' } } }), responses: { 201: json(ref('Btw')), 400: err[400], 404: err[404] } },
      },
      '/sessions/{id}/crew': {
        parameters: [id],
        post: { summary: 'Turn a task into a crew member: its folder, harness and model become the member’s, its first prompt the brief (unless given), and the task its first job. A task on a machine makes a member on that machine', requestBody: body(ref('CrewMember')), responses: { 201: json(ref('CrewMember')), 400: err[400], 409: json(ref('Error'), 'Already a crew member’s') } },
      },
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
      '/cloud/signin': { post: { summary: 'Sign in to a wisp Grid (device flow): returns the code to approve in the browser and where; the cloud computer joins Machines once approved', requestBody: body({ type: 'object', required: ['url'], properties: { url: { type: 'string', description: 'The grid, e.g. wisp.example.com' }, addComputer: { type: 'boolean', description: 'Once signed in, also add this computer to the grid (see /computer)' } } }), responses: { 201: json(ref('CloudSignin')), 400: err[400] } } },
      '/computer': {
        get: { summary: 'This computer on your wisp Grid: { on, state (off | connecting | online | retrying), error, name, url, grid, account }. Also looks up your other computers there again (they join Machines)', responses: { 200: json({ type: 'object' }) } },
        post: { summary: 'Add this computer to the grid you are signed in to ({ on: true }: your phone and other computers reach it through the grid) or take it off ({ on: false })', requestBody: body({ type: 'object', properties: { on: { type: 'boolean' } } }), responses: { 200: json({ type: 'object' }), 409: json(ref('Error'), 'Not signed in to a grid') } },
      },
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
      '/machines/{mid}/agents/{aid}/accounts': {
        parameters: [{ name: 'mid', in: 'path', required: true, schema: { type: 'string' } }, { name: 'aid', in: 'path', required: true, schema: { type: 'string' } }],
        get: { summary: 'The harness’s accounts on the machine (as GET /agents/{aid}/accounts there)', responses: { 200: json({ type: 'object' }) } },
        post: { summary: 'Add an account on the machine; its sign-in starts there', requestBody: body({ type: 'object', properties: { label: { type: 'string' } } }), responses: { 200: json({ type: 'object' }) } },
      },
      '/machines/{mid}/agents/{aid}/accounts/{acc}': {
        parameters: [{ name: 'mid', in: 'path', required: true, schema: { type: 'string' } }, { name: 'aid', in: 'path', required: true, schema: { type: 'string' } }, { name: 'acc', in: 'path', required: true, schema: { type: 'string' } }],
        patch: { summary: 'Rename or reorder an account on the machine', requestBody: body({ type: 'object', properties: { label: { type: 'string' }, move: { type: 'string', enum: ['up', 'down'] } } }), responses: { 200: json({ type: 'object' }) } },
        delete: { summary: 'Sign out and remove an account on the machine', responses: { 200: json({ type: 'object' }) } },
      },
      '/machines/{mid}/agents/{aid}/keys': {
        parameters: [{ name: 'mid', in: 'path', required: true, schema: { type: 'string' } }, { name: 'aid', in: 'path', required: true, schema: { type: 'string' } }],
        get: { summary: 'Which providers have an API key on the machine (as GET /agents/{aid}/keys there)', responses: { 200: json({ type: 'object' }) } },
        post: { summary: 'Save a provider’s API key on the machine', requestBody: body({ type: 'object', required: ['provider', 'key'], properties: { provider: { type: 'string', enum: ['opencode', 'opencode-go'] }, key: { type: 'string' } } }), responses: { 200: json({ type: 'object' }) } },
      },
      '/machines/{mid}/agents/{aid}/keys/{provider}': { parameters: [{ name: 'mid', in: 'path', required: true, schema: { type: 'string' } }, { name: 'aid', in: 'path', required: true, schema: { type: 'string' } }, { name: 'provider', in: 'path', required: true, schema: { type: 'string', enum: ['opencode', 'opencode-go'] } }], delete: { summary: 'Remove a provider’s API key on the machine', responses: { 200: json({ type: 'object' }) } } },
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
        delete: { summary: 'Remove a spell. Crew members it brought stay on as yours, unless crew=remove', parameters: [{ name: 'crew', in: 'query', schema: { enum: ['keep', 'remove'] } }], responses: { 200: json({ type: 'object' }), 404: err[404] } },
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
          summary: 'Follow up (answers a pending ask_user question if there is one). Text starting with /btw is a side question instead (see /btw). Text starting with @Name (a crew member) goes to that member, whose answer lands on the latest turn’s btw list ({ crew: [entry] }); a member named later in the text joins the task’s delegates',
          requestBody: body({ type: 'object', required: ['text'], properties: { text: { type: 'string' }, attachments: { type: 'array', items: { type: 'string' } }, queue: { type: 'boolean', description: 'Wait for the current run instead of interrupting it' }, mode: { enum: ['plan', 'edits', 'auto'], description: 'Switch the session to this mode from this follow-up on' }, agent: { type: 'string', description: 'Switch to this harness from this follow-up on; it is handed the turns it has not seen' }, model: { type: 'string', description: 'Switch model (empty: the harness default)' }, effort: { type: 'string', description: 'Switch thinking level (empty: the default)' }, account: { type: 'string', description: 'Switch to another of the harness’s accounts (`/agents/{aid}/accounts`) from this follow-up on' }, subagents: { type: 'array', maxItems: 6, items: { type: 'object', required: ['agent'] }, description: 'Give the lead this team from this follow-up on (same shape as a launch’s `subagents`; [] removes it). Members it already used keep their conversation' }, preset: { type: 'string', description: 'Id of a saved team (`/teams`), used when `subagents` is absent' } } }),
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
      '/sessions/{id}/goal': {
        parameters: [id],
        put: { summary: 'Set or replace the task’s goal: it keeps going until wisp’s check finds the condition holds, can’t hold, or it runs out of rounds. An idle task is checked at once and goes after it', requestBody: body({ type: 'object', required: ['text'], properties: { text: { type: 'string', description: 'What has to be true, like “all tests pass”' }, max: { type: 'integer', minimum: 1, maximum: 20, description: 'Rounds before it stops (default: the goalRounds setting)' } } }), responses: { 200: json({ type: 'object' }), 400: err[400], 409: err[400] } },
        patch: { summary: 'Pause the goal (the task lands after its round) or resume it (a paused goal, or one out of rounds, with a fresh budget)', requestBody: body({ type: 'object', required: ['action'], properties: { action: { enum: ['pause', 'resume'] } } }), responses: { 200: json({ type: 'object' }), 400: err[400], 404: err[404] } },
        delete: { summary: 'Drop the goal', responses: { 200: ok, 404: err[404] } },
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
      '/sessions/{id}/fork': {
        parameters: [id],
        post: {
          summary: 'Fork the task from one of its turns: a new task with the conversation up to there and a copy of the work, on its own branch',
          requestBody: body({ type: 'object', required: ['prompt'], properties: { prompt: { type: 'string', description: 'The fork’s first request' }, turnId: { type: 'string', description: 'The turn to fork from (default: the latest finished one)' }, agent: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, mode: { type: 'string', enum: ['plan', 'edits', 'auto'] }, attachments: { type: 'array', items: { type: 'string' } } } }),
          responses: { 201: json(ref('Summary')), 400: err[400], 404: err[404], 409: json(ref('Error'), 'Nothing to fork there yet') },
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
      '/sessions/{id}/app-state': {
        parameters: [id],
        post: {
          summary: 'Keep what an app block saved (wisp.save) on its turn, so it reopens as it was left',
          requestBody: body({ type: 'object', required: ['turnId', 'key'], properties: { turnId: { type: 'string' }, key: { type: 'string', description: 'app:<index in the presentation>' }, state: { description: 'any JSON, up to 32 KB' } } }),
          responses: { 200: ok, 400: err[400], 404: err[404] },
        },
      },
      '/sessions/{id}/stop': { parameters: [id], post: { summary: 'Stop the run and drop queued follow-ups', responses: { 200: ok } } },
      '/sessions/{id}/reveal': {
        parameters: [id],
        post: {
          summary: 'Show a picture, video or doc from a reply in Finder / Explorer (where the agent saved it, or wisp\'s copy). Refused with 409 and the path through a trusted proxy',
          requestBody: body({ type: 'object', required: ['path'], properties: { path: { type: 'string', description: 'The block\'s path' } } }),
          responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' }, path: { type: 'string' } } }), 404: err[404], 409: json(ref('Error'), 'Through a trusted proxy') },
        },
      },
      '/sessions/{id}/later': {
        parameters: [id],
        post: { summary: 'Schedule a follow-up (or, with remind, a reminder) on the task: { at | in (minutes), text, remind?, attachments? }', requestBody: body({ type: 'object', properties: { at: { type: ['integer', 'string'] }, in: { type: 'number' }, text: { type: 'string' }, remind: { type: 'boolean' }, attachments: { type: 'array', items: { type: 'string' }, description: 'Upload ids, sent with the follow-up when it goes' } }, required: ['text'] }), responses: { 201: json({ type: 'object' }), 400: err[400] } },
        patch: { summary: 'Change a scheduled follow-up ({ item, at | in, text }), send it now ({ item, now: true }) or snooze a reminder that came due ({ item: "reminder", at | in })', requestBody: body({ type: 'object', properties: { item: { type: 'string' }, at: { type: ['integer', 'string'] }, in: { type: 'number' }, text: { type: 'string' }, now: { type: 'boolean' } }, required: ['item'] }), responses: { 200: json({ type: 'object' }), 400: err[400], 404: err[404] } },
        delete: { summary: 'Cancel a scheduled follow-up', parameters: [{ name: 'item', in: 'query', required: true, schema: { type: 'string' } }], responses: { 200: ok, 404: err[404] } },
      },
      '/sessions/{id}/queue': { parameters: [id, { name: 'item', in: 'query', required: true, schema: { type: 'string' } }], delete: { summary: 'Cancel a queued follow-up', responses: { 200: ok, 404: err[404] } } },
      '/sessions/{id}/takeover': {
        parameters: [id],
        get: { summary: 'The shell command that resumes this agent session interactively', responses: { 200: json({ type: 'object', properties: { command: { type: 'string' } } }) } },
        post: {
          summary: 'Stop the run and open the resume command in the user’s terminal, or in the page (inline: then stream it from /term)',
          requestBody: body({ type: 'object', properties: { inline: { type: 'boolean', description: 'Open it in the page, whatever the terminal setting' }, cols: { type: 'integer' }, rows: { type: 'integer' } } }),
          responses: { 200: json({ type: 'object', properties: { command: { type: 'string' }, inline: { type: 'boolean' } } }) },
        },
      },
      '/sessions/{id}/term': {
        parameters: [id],
        get: { summary: 'Server-sent events from the session’s terminal in the page: hello, data (output, a JSON string), exit ({ code }), gone', responses: { 200: { description: 'text/event-stream', content: { 'text/event-stream': { schema: { type: 'string' } } } } } },
        post: {
          summary: 'Type into the terminal (data) or resize it (cols, rows)',
          requestBody: body({ type: 'object', properties: { data: { type: 'string' }, cols: { type: 'integer' }, rows: { type: 'integer' } } }),
          responses: { 200: ok, 404: err[404] },
        },
        delete: { summary: 'Close the terminal (ends what runs in it)', responses: { 200: ok } },
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
        Agent: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, available: { type: 'boolean' }, version: { type: 'string' }, models: { type: 'array', items: { type: 'object' } }, efforts: { type: 'array', items: { type: 'string' } }, hasKey: { type: ['boolean', 'null'], description: 'opencode only: signed in to a provider or has an API key in the environment (false: its free models alone)' }, setup: { type: 'object', description: 'Only while not found: how to get it on that OS', properties: { tip: { type: 'string' }, command: { type: 'string' }, url: { type: 'string' } } }, budget: { type: 'array', description: 'How much of each account’s usage windows is gone, as its CLI last reported (Claude, Codex). hitAt: when it runs out at this pace, if before the reset', items: { type: 'object', properties: { account: { type: 'string', description: 'default: the CLI’s own' }, at: { type: 'integer' }, windows: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', description: 'five_hour, seven_day, …' }, label: { type: 'string' }, used: { type: 'number', minimum: 0, maximum: 1 }, resetsAt: { type: ['integer', 'null'] }, hitAt: { type: ['integer', 'null'] } } } } } } } } },
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
            account: { type: 'string', description: 'Which of the harness’s accounts to run on (`/agents/{aid}/accounts`); none: your last pick (skipping one already at its usage limit)' },
            attachments: { type: 'array', items: { type: 'string' }, description: 'Upload ids' },
            worktree: { type: 'boolean', description: 'Run in a fresh git worktree + branch. Default: on in git repos (Settings), off in plan mode' },
            subagents: { type: 'array', maxItems: 6, items: { type: 'object', required: ['agent'], properties: { name: { type: 'string' }, agent: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, use: { type: 'string', description: 'When the lead should pick this one' }, count: { type: 'integer', minimum: 1, maximum: 5, description: 'Identical copies that take tasks in parallel (name#1, name#2, …); 12 in all' }, machine: { type: 'string', description: 'Where it runs: empty (with the lead), `here` (this computer) or a machine id. One on another place works on a copy of the lead’s work there; its changes come back as a patch' } } }, description: 'A team the lead can delegate to through the injected `delegate` tool. Each runs as a child session in the lead’s folder' },
            preset: { type: 'string', description: 'Id of a saved team (`/teams`), used when `subagents` is absent' },
            goal: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, max: { type: 'integer', minimum: 1, maximum: 20 } }, description: 'Keep going until this holds: after each turn wisp checks it and sends the task back with what is missing. A prompt that is just `/goal <condition>` does the same' },
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
            members: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, agent: { type: 'string', description: 'Harness id, or auto' }, model: { type: 'string' }, effort: { type: 'string' }, use: { type: 'string', description: 'What the lead should use it for' }, count: { type: 'integer', minimum: 1 }, machine: { type: 'string', description: 'Empty (with the lead), `here` or a machine id' } } } },
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
        CrewMember: {
          type: 'object',
          required: ['name'],
          properties: {
            id: { type: 'string', readOnly: true },
            name: { type: 'string', description: 'Up to 24 characters; @Name in a prompt reaches them' },
            role: { type: 'string' },
            avatar: { type: 'string', description: 'An emoji; empty shows the initial' },
            color: { enum: ['violet', 'teal', 'amber', 'rose', 'sky', 'lime', 'orange', 'indigo'] },
            brief: { type: 'string', description: 'Their standing job, in every job’s prompt' },
            cwd: { type: 'string', description: 'The folder their jobs run in (on their machine, if they have one); empty = no project' },
            machine: { type: 'string', description: 'A machine id: their jobs run there as its tasks; their memory, schedule and queue stay here. Empty = this computer' },
            agent: { type: 'string', description: 'Harness id, or auto' },
            model: { type: 'string' },
            effort: { type: 'string' },
            mode: { enum: ['plan', 'edits', 'auto'] },
            cron: { type: 'string', description: 'When they check in, in words ("8am every weekday") or 5-field cron, local time; stored as cron. Empty = only when asked' },
            parallel: { type: 'integer', minimum: 1, maximum: 5, description: 'Jobs at once; more wait in the queue' },
            paused: { type: 'boolean', description: 'No check-ins, triggers or delegations start; your own jobs still do' },
            notebook: { type: 'string', description: 'Their memory, kept by them (a hidden crew block ends each job) and editable by you' },
            kit: {
              type: 'array',
              description: 'Their skills and instructions files. rules (an AGENTS.md) are in every job’s prompt; a skill’s name and description are, and the job reads its SKILL.md when it fits. on: false keeps one without using it',
              items: { type: 'object', required: ['kind', 'name', 'body'], properties: { id: { type: 'string' }, kind: { enum: ['rules', 'skill'] }, name: { type: 'string' }, description: { type: 'string' }, body: { type: 'string' }, path: { type: 'string', description: 'A skill’s folder on this computer (its scripts and references)' }, on: { type: 'boolean' } } },
            },
            log: { type: 'array', readOnly: true, items: { type: 'object' }, description: 'One line per finished job, newest first' },
            queue: { type: 'array', items: { type: 'object' }, description: 'Jobs waiting for room' },
            wakeAt: { type: ['integer', 'null'], description: 'A check-in they asked for; null clears it' },
            offers: {
              type: 'array',
              description: 'Skills and instructions files their jobs proposed for their kit (newest first): { id, job, at, files, state: open | taken | dismissed, names }. PATCH offers: [{ id, state, names }] settles them (send the kit with the files you add)',
              items: { type: 'object' },
            },
            running: { type: 'integer', readOnly: true },
            nextAt: { type: ['integer', 'null'], readOnly: true },
            checkin: { type: 'boolean', writeOnly: true, description: 'POST /crew: start a first check-in' },
            on: { type: 'array', items: { enum: ['finished', 'done', 'ci', 'issues'] }, description: 'What else starts their jobs: the kinds of the triggers that are on and send them work. Sent (finished, done, ci), it makes or removes those triggers' },
            spell: { type: 'object', readOnly: true, description: 'A member a spell brought: { id, key, name, def }. The spell owns def (name, role, avatar, brief, schedule, on, mode, kit, delegates); changing those is refused (409) until POST /crew/{cid}/detach' },
            changed: { type: 'object', readOnly: true, description: 'Their spell changed what they do (from: the old definition, null for a member it just added): they are paused, and resume only with accept: true' },
            accept: { type: 'boolean', writeOnly: true, description: 'PATCH with paused: false: you saw what their spell changed' },
          },
        },
        Trigger: {
          type: 'object',
          required: ['kind', 'cwd'],
          properties: {
            id: { type: 'string' },
            crew: { type: 'string', description: 'A crew member id: the work goes to them as a job (cwd may then be empty for a schedule or a task watcher)' },
            name: { type: 'string' },
            kind: { enum: ['schedule', 'ci', 'issues', 'finished', 'done'], description: 'finished: a task finished a turn; done: a task was marked done' },
            enabled: { type: 'boolean' },
            cwd: { type: 'string', description: 'finished/done: only tasks in this project; empty = the crew member’s project, or any' },
            prompt: { type: 'string', description: 'Template; ci gets {id} {name} {branch} {sha} {url}, issues get {number} {title} {body} {url} {author}, finished/done get {id} {title} {summary} {branch} {cwd}' },
            recipeId: { type: 'string', description: 'Run this recipe instead of prompt' },
            params: { type: 'object' },
            cron: { type: 'string', description: 'schedule: when, in words ("every monday") or 5-field cron, local time; stored as cron' },
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
            overlaps: { type: 'array', description: 'Other open tasks in the same repo that change the same files: [{ id, title, files, more, conflicts }]. conflicts lists the files merging both would leave conflicted ([] if they merge cleanly, null if git is older than 2.38). Absent when there are none.' },
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
