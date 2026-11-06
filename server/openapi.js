// OpenAPI 3.1 description of the public HTTP API, served at GET /api/openapi.json.
// Feed it to any OpenAPI client generator, Postman, or an agent's tool loader.
// Routes under /api/internal are wisp's own plumbing and deliberately left out.

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const id = { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Session id' };
const stuffId = { name: 'sid', in: 'path', required: true, schema: { type: 'string' }, description: 'My Stuff item id' };
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
        'x-wisp-proxy-secret may use any Host, and a non-GET Origin must match WISP_PUBLIC_URL. ' +
        'A cloud wisp takes scripts at https://<handle>.<domain>/api/… with Authorization: Bearer wgk_…, an API key made in Settings.',
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
        patch: { summary: 'Auto settings', requestBody: body({ type: 'object', properties: { goal: { enum: ['cheap', 'balanced', 'best'] }, explore: { type: 'boolean', description: 'Let Auto try new models on a few tasks' }, allowed: { type: 'array', items: { type: 'string' }, description: 'Harness ids Auto may pick; empty or null = all' }, escalate: { type: 'boolean', description: 'The run errored: run the task again on a stronger pick, in its own worktree' }, best2: { type: 'boolean', description: 'Goal Best: two picks side by side, the better one marked' }, scout: { enum: ['off', 'big', 'all'], description: 'A cheap model looks at the repo first' }, habits: { type: 'boolean', description: 'Start from what you pick yourself' }, blocked: { type: 'array', items: { type: 'string' }, description: "Never pick: 'claude', 'claude:sonnet', 'claude:sonnet:high', optionally '…@ui'" }, prefer: { type: 'array', items: { type: 'string' }, description: 'Prefer, same form as blocked' } } }), responses: { 200: json({ type: 'object' }) } },
      },
      '/router/preview': { post: { summary: 'What Auto would run for a prompt (no dice): the pick, why, the alternatives it weighed and one it suggests', requestBody: body({ type: 'object', properties: { prompt: { type: 'string' }, attachments: { type: 'integer' }, goal: { enum: ['cheap', 'balanced', 'best'] }, team: { type: 'boolean' }, machine: { type: 'string' } } }), responses: { 200: json({ type: 'object' }), 404: err[404] } } },
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
      '/tools': { get: { summary: 'What Ship it needs here: git installed, gh installed and signed in to GitHub (signedIn null when unknown), with setup (tip, command, url) for this OS when missing', responses: { 200: json({ type: 'object' }) } } },
      '/agents/{aid}/drain/dismiss': {
        parameters: [{ name: 'aid', in: 'path', required: true, schema: { type: 'string' } }],
        post: {
          summary: 'Drain watch: hide the card for an account’s window until a later run shows it again',
          requestBody: body({ type: 'object', required: ['window'], properties: { account: { type: 'string', description: 'default: the CLI’s own' }, window: { type: 'string', description: 'five_hour, seven_day, …' } } }),
          responses: { 200: json({ type: 'object' }), 404: json(ref('Error')) },
        },
      },
      '/agents/{aid}/windows/dismiss': {
        parameters: [{ name: 'aid', in: 'path', required: true, schema: { type: 'string' } }],
        post: {
          summary: 'Window changes: hide the notice that an account’s usage window appeared, went, changed length or moved its reset, until that window changes again',
          requestBody: body({ type: 'object', required: ['window'], properties: { account: { type: 'string', description: 'default: the CLI’s own' }, window: { type: 'string', description: 'five_hour, seven_day, w43200m, …' } } }),
          responses: { 200: json({ type: 'object' }), 404: json(ref('Error')) },
        },
      },
      '/agents/{aid}/trust': {
        parameters: [{ name: 'aid', in: 'path', required: true, schema: { type: 'string' } }],
        post: {
          summary: 'Trust this version: pin a harness whose program changed (path, size, sha256, version) as it is now',
          responses: { 200: json({ type: 'array', items: ref('Agent') }), 404: json(ref('Error')) },
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
              kind: { type: 'string', enum: ['bug', 'idea'], description: 'bug: a bug report (needs text). Omitted: general feedback' },
              sessionId: { type: 'string', description: 'Adds that run\'s harness, model and status (never the prompt or result)' },
              turnId: { type: 'string' },
              source: { type: 'string', description: 'turn | command | dialog | home' },
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
      '/worktrees': {
        get: {
          summary: 'Worktrees on disk: per task, why each stays or when it goes, leftover folders, sizes and free disk',
          responses: { 200: json({ type: 'object' }) },
        },
      },
      '/worktrees/clean': {
        post: {
          summary: 'Remove worktrees in the background; branches stay, and a follow-up brings a folder back',
          requestBody: body({
            type: 'object',
            properties: {
              ids: { type: 'array', items: { type: 'string' }, description: 'Task ids. Without ids or leftovers: every worktree idle for a day or more' },
              leftovers: { type: 'array', items: { type: 'string' }, description: 'Folder names no task knows' },
              force: { type: 'boolean', description: 'Also drop uncommitted work in the tasks named' },
            },
          }),
          responses: { 200: json({ type: 'object', properties: { queued: { type: 'integer' }, skipped: { type: 'array', items: { type: 'string' } } } }), 400: err[400] },
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
      '/projects/{pid}/foreign-worktrees': {
        parameters: [{ name: 'pid', in: 'path', required: true, schema: { type: 'string' } }],
        get: { summary: 'The Conductor worktrees of this project’s repo that can be brought in: from `git worktree list`, minus what a task already holds and what was dismissed. Empty for a project with no folder here. Never fetches', responses: { 200: json(ref('ForeignWorktrees')), 404: err[404] } },
        post: {
          summary: 'Bring them in: each becomes a task in place, on its own path and branch, with nothing run or written there. The list is worked out again here, and a path not offered now lands in `missed`',
          requestBody: body({ type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, description: 'The worktrees to take; left out: all that are offered' } } }),
          responses: { 200: json({ type: 'object', required: ['tasks', 'missed'], properties: { tasks: { type: 'array', items: ref('Summary') }, missed: { type: 'array', items: { type: 'object', required: ['path', 'why'], properties: { path: { type: 'string' }, why: { type: 'string' } } } } } }), 400: err[400], 404: err[404] },
        },
      },
      '/projects/{pid}/foreign-worktrees/dismiss': {
        parameters: [{ name: 'pid', in: 'path', required: true, schema: { type: 'string' } }],
        post: {
          summary: 'Not now: stop offering the worktrees offered now. One made later is still offered. With `undo`, those folders are offered again instead',
          requestBody: body({ type: 'object', properties: { undo: { type: 'array', items: { type: 'string' }, description: 'The `paths` of an earlier dismiss to offer again; unknown ones are ignored' } } }),
          responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' }, skipped: { type: 'integer', description: 'How many were dismissed by this call' }, paths: { type: 'array', items: { type: 'string' }, description: 'The folders dismissed by this call' } } }), 400: err[400], 404: err[404] },
        },
      },
      '/launch/warm': { post: { summary: 'A task is being typed for this folder: fetch its repo now, so the launch starts without waiting on the network', requestBody: body({ type: 'object', properties: { cwd: { type: 'string' } } }), responses: { 200: ok } } },
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
            { name: 'since', in: 'query', schema: { type: 'string' }, description: 'The token from an earlier answer with `since` (empty the first time): answers `{ token, changed, removed }`, only what changed since then, or `{ token, full }` when it can’t tell (another run of wisp, a filter)' },
            { name: 'here', in: 'query', schema: { type: 'boolean' }, description: "This wisp's own sessions only, not its machines' (what another wisp asks for)" },
          ],
          responses: { 200: json({ type: 'array', items: ref('Summary') }) },
        },
        post: { summary: 'Launch a task. With `compare`, the response is the first session plus `group`: every session started. 409 with `hold` when it would take its account’s usage window past the Ask near the limit line (send again with `confirmLimit: true` once the user agreed)', requestBody: body(ref('Launch')), responses: { 201: json(ref('Summary')), 400: err[400], 409: json(ref('Hold'), 'Near the usage limit') } },
      },
      '/sessions/{id}': {
        parameters: [id],
        get: {
          summary: 'Full session record: turns, activity, captured edits, presentations',
          parameters: [
            { name: 'lean', in: 'query', schema: { type: 'boolean' }, description: 'Leave out each captured edit’s `beforeFile` (the whole file before it; only rollback needs it)' },
            { name: 'turns', in: 'query', schema: { type: 'integer' }, description: 'With `lean`: only the latest N turns whole; older ones are stubs (`stub: true`) with their prompt, times, status, mode, account and result title' },
          ],
          responses: { 200: json({ type: 'object' }), 404: err[404] },
        },
        patch: {
          summary: 'Rename, mark done/review, mark read, archive',
          requestBody: body({ type: 'object', properties: { title: { type: 'string' }, state: { enum: ['done', 'review'] }, unread: { type: 'boolean' }, keepWorktree: { type: 'boolean', description: 'The worktree cleanup leaves this task’s folder alone' }, lean: { type: ['string', 'null'], enum: ['on', 'off', null], description: 'Lean runs for this task only (Claude Code without its nonessential traffic): on, off, or null to follow defaults.leanRuns (off: never; on, the default: only wisp’s own side runs; all: every Claude run)' }, archived: { type: 'boolean' }, forLater: { type: ['boolean', 'number'], description: 'Save a finished task for later (true, or the time it was saved, to put it back in its place) or unsave it (false)' }, discardWorktree: { type: 'boolean', description: 'Remove the worktree and its uncommitted changes (a compare run you did not keep)' } } }),
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
      '/sessions/{id}/review': { parameters: [id], post: { summary: 'Review the task\'s open PR by another harness now: one other than the author (or defaults.review\'s pick) reads the diff and the tests run again on the PR head; the result is the session\'s review', responses: { 200: json({ type: 'object' }), 400: err[400], 409: json(ref('Error')) } } },
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
        post: { summary: 'Schedule a task ({ kind: "task", at | in, prompt, cwd, agent, … as POST /sessions }) or a reminder ({ kind: "reminder", at | in, text }). A task with draft: true instead of a time waits in Drafts; with after: <task id> it starts once that task is done', requestBody: body({ type: 'object' }), responses: { 201: json({ type: 'object' }), 400: err[400] } },
      },
      '/later/{lid}': {
        parameters: [{ name: 'lid', in: 'path', required: true, schema: { type: 'string' } }],
        patch: { summary: 'Change when it runs ({ at | in }; a draft or a task waiting for another gets that time instead), its text or prompt, or start it now ({ now: true })', requestBody: body({ type: 'object' }), responses: { 200: json({ type: 'object' }), 400: err[400], 404: err[404] } },
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
      '/hooks/{token}': {
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' }, description: 'A webhook, Slack or Linear trigger’s token' }],
        post: {
          summary: 'Start a trigger’s task from outside wisp (Settings → Automations → Webhook triggers; off: 404). No sign-in: the token is the check, then the signature (webhook: optional HMAC sha256; slack: X-Slack-Signature within 5 minutes; linear: Linear-Signature). Slack’s url_verification gets its challenge back. At most one task per trigger every 30 s. The task starts after the answer',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } }, 'application/x-www-form-urlencoded': { schema: { type: 'object' } } } },
          responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' }, skipped: { type: 'string' }, challenge: { type: 'string' } } }, 'Answered with nothing started: filtered out, a duplicate, or Slack’s url_verification'), 202: json({ type: 'object', properties: { ok: { type: 'boolean' }, accepted: { type: 'boolean' } } }, 'Accepted: the task starts'), 401: json(ref('Error'), 'The signature is missing or wrong, or too old'), 404: err[404], 429: json({ type: 'object' }, 'Another task started less than 30 s ago') },
        },
      },
      '/triggers/{tid}/run': { parameters: [{ name: 'tid', in: 'path', required: true, schema: { type: 'string' } }], post: { summary: 'Fire a schedule now, or poll a watcher now (firing for anything new)', responses: { 200: json({ type: 'object', properties: { started: { type: 'array', items: ref('Summary') }, trigger: ref('Trigger') } }) } } },
      '/crew': {
        get: { summary: 'Your crew: long-lived agents with a name, role, avatar, brief, schedule and memory (notebook, log). Their work runs as tasks (jobs, `crew` on a session summary); running counts jobs now, nextAt is the next check-in', responses: { 200: json({ type: 'array', items: ref('CrewMember') }) } },
        post: { summary: 'Add a crew member. checkin: true starts its first check-in at once', requestBody: body(ref('CrewMember')), responses: { 201: json(ref('CrewMember')), 400: err[400] } },
      },
      '/crew-layout': {
        get: { summary: 'Where each crew member sits on the Org page: { [id]: { x, y } } (x from the chart’s middle, y from its top, px). Empty: laid out automatically', responses: { 200: json({ type: 'object', additionalProperties: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } } }) } },
        put: { summary: 'Replace the Org page layout. Members left out are placed automatically; {} goes back to the automatic layout', requestBody: body({ type: 'object', required: ['layout'], properties: { layout: { type: 'object', additionalProperties: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } } } } }), responses: { 200: json({ type: 'object' }), 400: err[400] } },
      },
      '/crew-kit': {
        get: {
          summary: 'Skills (SKILL.md folders in ~/.claude/skills, ~/.agents/skills, …) and instructions files (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, …) on this computer, to add to a crew member’s kit. cwd: a project’s too',
          parameters: [{ name: 'cwd', in: 'query', schema: { type: 'string' } }],
          responses: { 200: json({ type: 'object', properties: { skills: { type: 'array', items: { type: 'object' } }, rules: { type: 'array', items: { type: 'object' } } } }) },
        },
      },
      '/crew/stats': {
        get: {
          summary: 'Each crew member’s track record and where its usage went over the last `days`: jobs by kind and outcome, check-ins and how many came back quiet, questions, your follow-ups, PRs, tokens and cost (per day, per kind of job in byKind, its heaviest jobs in top), and span (days it was around). all: every task’s tokens and cost in the range. windows: each plan window (5-hour, weekly…) with how much is used and the tokens spent since it started, per member. remote: a member on another machine, without usage',
          parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', default: 30, maximum: 365 } }],
          responses: { 200: json({ type: 'object' }) },
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
        get: { summary: 'This computer on your wisp Grid: { on, state (off | connecting | online | retrying), error, name, url, grid, account, accounts (every grid account signed in here: id, grid, handle), previews, previewUrl }. Also looks up your other computers there again (they join Machines)', responses: { 200: json({ type: 'object' }) } },
        post: { summary: 'Add this computer to the grid you are signed in to ({ on: true }: your phone and other computers reach it through the grid) or take it off ({ on: false }). { previews: true | false }: show pages running on this computer (localhost) in preview blocks through the grid, at p<port>--<name>--<handle>.<grid>; off by default', requestBody: body({ type: 'object', properties: { on: { type: 'boolean' }, previews: { type: 'boolean' }, account: { type: 'string', description: 'With on: which grid account (a cloud computer id from accounts) to add it with; moves it off another one' } } }), responses: { 200: json({ type: 'object' }), 404: json(ref('Error'), 'No such grid account'), 409: json(ref('Error'), 'Not signed in to a grid') } },
      },
      '/sandbox': { get: { summary: 'Sandboxes on your wisp Grid (/sandbox <task> runs a task in a fresh box of its own there): { grid: { host, handle } | null, enabled, logins: { claude: bool } (what every sandbox starts signed in to), login (the sign-in in progress), sandboxes (how many) }', responses: { 200: json({ type: 'object' }) } } },
      '/sandbox/env': { put: { summary: 'An env var every sandbox starts with (an API key, a database URL), sealed on your grid. Returns the names, never values', requestBody: body({ type: 'object', required: ['key', 'value'], properties: { key: { type: 'string' }, value: { type: 'string' } } }), responses: { 200: json({ type: 'object', properties: { env: { type: 'array', items: { type: 'string' } } } }), 400: err[400] } } },
      '/sandbox/env/{key}': { parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }], delete: { summary: 'Sandboxes no longer start with that env var', responses: { 200: json({ type: 'object' }) } } },
      '/sandbox/{sbid}': { parameters: [{ name: 'sbid', in: 'path', required: true, schema: { type: 'string' } }], delete: { summary: 'Delete a sandbox nothing here owns (made from another device, or left behind). One a task or crew member owns goes with it (409)', responses: { 200: json({ type: 'object' }), 409: json(ref('Error'), 'Owned by a task or member') } } },
      '/sandbox/login': {
        post: { summary: 'Sign in to Claude for every sandbox: runs `claude setup-token` here; the link to open and whether it waits for a code come back, and in the sandbox event. The token goes to the grid, never kept here', responses: { 200: json({ type: 'object' }), 409: json(ref('Error'), 'Not signed in to a grid') } },
        delete: { summary: 'Cancel the sandboxes’ sign-in', responses: { 200: json({ type: 'object' }) } },
      },
      '/sandbox/login/input': { post: { summary: 'Paste back the code the Claude sign-in page showed', requestBody: body({ type: 'object', required: ['code'], properties: { code: { type: 'string' } } }), responses: { 200: json({ type: 'object' }), 409: json(ref('Error'), 'No sign-in waiting') } } },
      '/sandbox/logins/{agent}': { parameters: [{ name: 'agent', in: 'path', required: true, schema: { type: 'string', enum: ['claude'] } }], delete: { summary: 'Sandboxes no longer start signed in to it (the grid forgets the token)', responses: { 200: json({ type: 'object' }) } } },
      '/sandbox/browser': { post: { summary: 'A sandboxed task’s browser: starts the sandbox’s screen and Chromium if need be and returns a one-time link to watch it live (noVNC, through the grid’s preview of port 6080)', requestBody: body({ type: 'object', required: ['task'], properties: { task: { type: 'string', description: 'The task id (<id>@<machine>)' }, width: { type: 'integer', description: 'Where it’s watched, CSS pixels: the screen fits it (360–1920)' }, height: { type: 'integer', description: '400–1200' } } }), responses: { 200: json({ type: 'object', properties: { url: { type: 'string' } } }), 404: err[404] } } },
      '/sandbox/desktop': { post: { summary: 'In a sandbox: start its screen (Xvfb), Chromium (DevTools on 127.0.0.1:9222) and live view (noVNC on 6080) if they aren’t running. Returns { port }', responses: { 200: json({ type: 'object', properties: { port: { type: 'integer' } } }), 403: json(ref('Error'), 'Not a sandbox') } } },
      '/sandbox/seed': { post: { summary: 'In a sandbox: the project a /sandbox task brought (a git bundle, uploaded first) set up as a repo in ~/code. Returns { cwd }', requestBody: body({ type: 'object', required: ['upload', 'ref'], properties: { upload: { type: 'string' }, ref: { type: 'string' }, name: { type: 'string' }, branch: { type: 'string' }, origin: { type: 'string' }, author: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' } } } } }), responses: { 200: json({ type: 'object', properties: { cwd: { type: 'string' } } }), 400: err[400] } } },
      '/cloud/keys': {
        get: { summary: 'For a desktop signed in to a wisp Grid: its API keys, newest first (on a cloud wisp, keys are made in Settings, by the browser at the edge). grid is null when there is none. Never the keys themselves. Refused with an API key', responses: { 200: json({ type: 'object', required: ['grid', 'keys'], properties: { grid: { type: ['object', 'null'], properties: { host: { type: 'string' }, handle: { type: 'string' } } }, keys: { type: 'array', items: ref('ApiKey') } } }), 403: json(ref('Error'), 'Asked with an API key'), 409: json(ref('Error'), 'Its grid is older'), 502: json(ref('Error'), 'Couldn’t reach the grid') } },
        post: { summary: 'For a desktop signed in to a wisp Grid: make an API key for scripting your cloud wisp (on a cloud wisp, keys are made in Settings, by the browser at the edge). The answer is the only time you see key; it is not kept here or on the grid. At most 20 live keys', requestBody: body({ type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 60 } } }), responses: { 201: json({ allOf: [ref('ApiKey'), { type: 'object', required: ['key'], properties: { key: { type: 'string', description: 'wgk_…: send it as Authorization: Bearer' } } }] }), 400: err[400], 403: json(ref('Error'), 'Asked with an API key'), 409: json(ref('Error'), 'Not signed in to a grid, 20 keys already, or its grid is older'), 502: json(ref('Error'), 'Couldn’t reach the grid') } },
      },
      '/cloud/keys/{kid}': { parameters: [{ name: 'kid', in: 'path', required: true, schema: { type: 'string' } }], delete: { summary: 'For a desktop signed in to a wisp Grid: revoke an API key, which stops working at once (on a cloud wisp, keys are managed in Settings, by the browser at the edge)', responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' } } }), 403: json(ref('Error'), 'Asked with an API key'), 404: err[404], 409: json(ref('Error'), 'Not signed in to a grid'), 502: json(ref('Error'), 'Couldn’t reach the grid') } } },
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
      '/usage/periods': {
        get: {
          summary: 'Allowance per window, for each account: period by period what was used, how much was outside wisp and what 1% cost, and a weekly shrink reading (null until 2 full weekly periods per side, and for Codex also across its December 2026 plan change). Used and outside are null for a period wisp has no reading of; per1 is null when there is too little to say; rough means the cost came from differences of cumulative totals. Reads every turn: asked for, not on GET /agents',
          responses: {
            200: json({
              type: 'object',
              properties: {
                accounts: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      agent: { type: 'string' },
                      account: { type: 'string', description: 'The account’s id, default for the CLI’s own' },
                      windows: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            label: { type: 'string' },
                            periods: {
                              type: 'array',
                              description: 'Newest first, at most 12',
                              items: {
                                type: 'object',
                                properties: {
                                  end: { type: 'integer', description: 'The period’s reset, ms' },
                                  ms: { type: 'integer', nullable: true },
                                  used: { type: 'number', nullable: true },
                                  inWisp: { type: 'number' },
                                  outside: { type: 'number', nullable: true },
                                  work: { type: 'number' },
                                  unit: { type: 'string', enum: ['usd', 'mtok'] },
                                  per1: { type: 'number', nullable: true, description: 'Work per 1% of the window' },
                                  rough: { type: 'boolean' },
                                  open: { type: 'boolean', description: 'The current period' },
                                  full: { type: 'boolean', description: 'Closed at its reset, read from before it began: it can count to a reading' },
                                  cut: { type: 'boolean', description: 'It ended before its reset' },
                                  cli: { type: 'object', description: 'What moved in the CLI against the period before: version [from, to], tools, catalog. Absent when nothing did' },
                                },
                              },
                            },
                            shrink: {
                              type: 'object',
                              nullable: true,
                              description: 'Weekly windows only: what 1% cost in the last 2 full periods against the 2 before. A diagnostic',
                              properties: { state: { type: 'string', enum: ['less', 'same', 'more'] }, change: { type: 'number' }, recent: { type: 'number' }, before: { type: 'number' }, unit: { type: 'string' }, from: { type: 'integer' }, rough: { type: 'boolean' }, cli: { type: 'object' } },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            }),
          },
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
          requestBody: body({ type: 'object', required: ['text'], properties: { text: { type: 'string' }, attachments: { type: 'array', items: { type: 'string' } }, queue: { type: 'boolean', description: 'Wait for the current run instead of interrupting it' }, sendId: { type: 'string', maxLength: 64, description: 'Your id for this message: sent again with the same id, it gets the first send’s answer and doesn’t run twice. Remembered for 10 minutes' }, mode: { enum: ['plan', 'edits', 'auto'], description: 'Switch the session to this mode from this follow-up on' }, agent: { type: 'string', description: 'Switch to this harness from this follow-up on; it is handed the turns it has not seen' }, model: { type: 'string', description: 'Switch model (empty: the harness default)' }, effort: { type: 'string', description: 'Switch thinking level (empty: the default)' }, account: { type: 'string', description: 'Switch to another of the harness’s accounts (`/agents/{aid}/accounts`) from this follow-up on' }, subagents: { type: 'array', items: { type: 'object', required: ['agent'] }, description: 'Give the lead this team from this follow-up on (same shape as a launch’s `subagents`; [] removes it). Members it already used keep their conversation' }, preset: { type: 'string', description: 'Id of a saved team (`/teams`), used when `subagents` is absent' }, confirmLimit: { type: 'boolean', description: 'The user agreed to send it although it would take the account’s usage window past their Ask near the limit line' }, goal: { type: 'object', properties: { text: { type: 'string' } }, description: 'Also set (or replace) the task’s goal, checked after the turn this follow-up starts (see PUT /sessions/{id}/goal)' } } }),
          responses: { 200: json({ type: 'object', properties: { answered: { type: 'boolean' }, queued: { type: 'boolean' }, interrupted: { type: 'boolean' }, ahead: { type: 'integer' }, btw: ref('Btw') } }), 400: err[400], 409: json(ref('Hold'), 'Near the usage limit') },
        },
      },
      '/sessions/{id}/turns/{turnId}/sign-in': {
        parameters: [id, { name: 'turnId', in: 'path', required: true, schema: { type: 'string' } }],
        post: {
          summary: 'A latest turn that failed signed out (turn.signedOut): the next login or key for its harness and account, within 16 minutes, sends its request again. armed: false when this turn can’t go by itself (a subagent’s, one wisp sent, or a newer turn): sign in, then use /rerun',
          responses: { 200: json({ type: 'object', properties: { armed: { type: 'boolean' } } }), 404: err[404] },
        },
      },
      '/sessions/{id}/turns/{turnId}/rerun': {
        parameters: [id, { name: 'turnId', in: 'path', required: true, schema: { type: 'string' } }],
        post: {
          summary: 'Send a signed-out turn’s request again, once, in the same conversation. rerun: false when it already went or a newer turn, a queue or a run stands in the way',
          requestBody: body({ type: 'object', properties: { account: { type: 'string', description: 'Continue on this account: one of turn.signedOut.others' }, sendId: { type: 'string', maxLength: 64, description: 'As on /reply' } } }),
          responses: { 200: json({ type: 'object', properties: { rerun: { type: 'boolean' } } }), 400: err[400], 404: err[404], 409: err[400] },
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
        put: { summary: 'Set or replace the task’s goal: it keeps going until wisp’s check finds the condition holds, can’t hold, or it goes in circles. An idle task is checked at once and goes after it', requestBody: body({ type: 'object', required: ['text'], properties: { text: { type: 'string', description: 'What has to be true, like “all tests pass”' }, judges: { type: 'array', maxItems: 5, items: { type: 'object', properties: { agent: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, crew: { type: 'string', description: 'A crew member, on their own harness' }, name: { type: 'string' } } }, description: 'Each checks the work on its own; [] clears them' }, vote: { enum: ['all', 'majority', 'any'], description: 'How many judges must say met (default majority). Can’t be done takes a majority' } } }), responses: { 200: json({ type: 'object' }), 400: err[400], 409: err[400] } },
        patch: { summary: 'Pause the goal (the task lands after its round) or resume it (a paused goal goes back to work)', requestBody: body({ type: 'object', required: ['action'], properties: { action: { enum: ['pause', 'resume'] } } }), responses: { 200: json({ type: 'object' }), 400: err[400], 404: err[404] } },
        delete: { summary: 'Drop the goal', responses: { 200: ok, 404: err[404] } },
      },
      '/sessions/{id}/goal-runs/{run}': {
        parameters: [id, { name: 'run', in: 'path', required: true, schema: { type: 'string' } }],
        get: { summary: 'What one goal check said and did: the prompt it got, its steps and its vote. The id is on a check’s votes (or on the check, when wisp checks by itself); a goal keeps those of its last 50 checks', responses: { 200: ok, 404: err[404] } },
      },
      '/sessions/{id}/answer': { parameters: [id], post: { summary: 'Answer the pending ask_user question (or approval: Allow, Always allow in this task, Deny, or what to do instead)', requestBody: body({ type: 'object', required: ['text'], properties: { text: { type: 'string' }, sendId: { type: 'string', maxLength: 64, description: 'As on /reply' } } }), responses: { 200: ok } } },
      '/sessions/{id}/clash': {
        parameters: [id],
        post: {
          summary: 'Answer a side discussion’s clash card: apply writes it and tells the main task, keep refuses it. Apply rechecks first: a card that no longer holds gets 409 and shows the new state',
          requestBody: body({ type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['apply', 'keep'] }, askId: { type: 'string' }, sig: { type: 'string', description: 'The card’s clash.sig, as you saw it' } } }),
          responses: { 200: ok, 400: err[400], 404: err[404], 409: json(ref('Error'), 'The main task moved, or the card has moved on') },
        },
      },
      '/sessions/{id}/approve': { parameters: [id], post: { summary: 'Allow and retry (or deny) what a finished turn’s permissions blocked', requestBody: body({ type: 'object', properties: { turnId: { type: 'string' }, allow: { type: 'boolean', description: 'Default true' } } }), responses: { 200: ok } } },
      '/sessions/{id}/revert': {
        parameters: [id],
        post: {
          summary: 'Revert (or re-apply) a single file’s changes from a turn',
          requestBody: body({ type: 'object', required: ['file'], properties: { file: { type: 'string' }, turnId: { type: 'string' }, restore: { type: 'boolean' } } }),
          responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' }, turnId: { type: 'string' }, file: { type: 'string' }, reverted: { type: 'boolean' } } }), 400: err[400], 404: err[404] },
        },
      },
      '/sessions/{id}/share': {
        parameters: [id],
        get: { summary: 'What sharing the task would carry: the grids you can share to, its link if shared, its work, delegates, crew, connectors and skills', responses: { 200: json({ type: 'object' }), 404: err[404] } },
        post: {
          summary: 'Share the task on your wisp Grid (again: the same link, updated): a page anyone with the link opens, and a task other people on that grid import into their wisp',
          requestBody: body({ type: 'object', properties: { passkey: { type: 'string', description: 'Only people with it open the link (empty: anyone with the link)' }, work: { type: 'boolean', description: 'Include its work: the branch and uncommitted changes, or a folder-less task’s files (default true)' }, account: { type: 'string', description: 'Which grid, when you are signed in to several' } } }),
          responses: { 200: json({ type: 'object', properties: { url: { type: 'string' }, locked: { type: 'boolean' }, notes: { type: 'array', items: { type: 'string' } } } }), 400: err[400], 404: err[404], 409: json(ref('Error'), 'Not signed in to a grid, or nothing to share yet') },
        },
        delete: { summary: 'Stop sharing the task: its link stops working', responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' } } }), 404: err[404] } },
      },
      '/shares/peek': {
        post: {
          summary: 'What a shared task’s link holds, for the card a pasted link shows: who shared it, its harness and model and what runs it here, turns, delegates, crew, connectors and skills',
          requestBody: body({ type: 'object', required: ['url'], properties: { url: { type: 'string' }, passkey: { type: 'string' } } }),
          responses: { 200: json({ type: 'object' }), 400: err[400], 409: json(ref('Error'), 'Not signed in to that grid') },
        },
      },
      '/shares/import': {
        post: {
          summary: 'Import a shared task: a new task with its history, work, delegates, crew, connectors and skills, carried on here',
          requestBody: body({ type: 'object', required: ['url'], properties: { url: { type: 'string' }, passkey: { type: 'string' }, prompt: { type: 'string', description: 'Its first follow-up here (empty: it waits for you)' }, mode: { type: 'string', enum: ['plan', 'edits', 'auto'] }, agent: { type: 'string', description: 'Carry it on on this harness instead' }, model: { type: 'string' }, effort: { type: 'string' }, connectors: { type: 'boolean', description: 'Add their connectors you don’t have (default true)' }, crew: { type: 'boolean', description: 'Add the crew members it delegated to (default true)' } } }),
          responses: { 201: json(ref('Summary')), 400: err[400], 403: json(ref('Error'), 'Wrong or missing passkey'), 409: json(ref('Error'), 'Not signed in to that grid') },
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
      '/sessions/{id}/side': {
        parameters: [id],
        post: {
          summary: 'Start a side discussion (/side) about the task: a task of its own (no history, no work of its own) in the task’s folder, that hears its latest state with every message. It runs commands and edits behind a clash check where the harness can ask before a write, and only reads elsewhere (sideOf.edits). Its summary has sideOf; the task lists it in sides',
          requestBody: body({ type: 'object', required: ['text'], properties: { text: { type: 'string', description: 'The opening message; a leading /side is dropped' }, agent: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, attachments: { type: 'array', items: { type: 'string' } } } }),
          responses: { 201: json(ref('Summary')), 400: err[400], 404: err[404], 409: json(ref('Error'), 'It is a side discussion already') },
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
      '/sessions/{id}/watch': {
        parameters: [id],
        get: {
          summary: 'The page its agent keeps beside the task while it works (wisp_watch), with its last state',
          responses: {
            200: json({ type: 'object', properties: { title: { type: 'string' }, caption: { type: 'string' }, state: {}, run: { type: 'object', nullable: true }, seq: { type: 'integer' }, rev: { type: 'integer' }, at: { type: 'integer' }, closed: { type: 'boolean' }, html: { type: 'string' }, problem: { type: 'string' } } }),
            404: err[404],
          },
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
      '/sessions/{id}/stop': { parameters: [id], post: { summary: 'Stop the run; queued follow-ups stay, held until you send something', responses: { 200: ok } } },
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
      '/sessions/{id}/compact': {
        parameters: [id],
        post: {
          summary: 'Compact now: shrink a large Claude task while its cache is warm (summary.compactOffer). Runs /compact as a turn of its own, without the limit check; never held',
          responses: { 200: ok, 404: err[404], 409: json(ref('Error'), 'Not offered: too small, not warm, a side discussion, a used-up window, or a question waiting') },
        },
      },
      '/sessions/{id}/held': {
        parameters: [id],
        post: { summary: 'A run held near the usage limit, for a changed harness (held.harness) or for a repo’s untrusted hooks, MCP servers or worktree setup (held.project, server/project-trust.js; its turn lists them). start: now (a changed harness or the repo is trusted first, then a held setup runs); without (repo only): this task runs without them and without the setup; wait: for the reset (limit only); skip: it never runs', requestBody: body({ type: 'object', required: ['action'], properties: { action: { enum: ['start', 'wait', 'without', 'skip'] } } }), responses: { 200: json(ref('Summary')), 400: err[400], 404: err[404] } },
      },
      '/sessions/{id}/queue': {
        parameters: [id],
        patch: { summary: 'Change a queued follow-up ({ item, text }), the order they go out in ({ order: [ids] }), combine some into one ({ merge: [ids] }) or send one now, interrupting the run ({ item, now: true })', requestBody: body({ type: 'object', properties: { item: { type: 'string' }, text: { type: 'string' }, order: { type: 'array', items: { type: 'string' } }, merge: { type: 'array', items: { type: 'string' } }, now: { type: 'boolean' } } }), responses: { 200: ok, 400: err[400], 404: err[404], 409: json(ref('Error')) } },
        delete: { summary: 'Cancel a queued follow-up', parameters: [{ name: 'item', in: 'query', required: true, schema: { type: 'string' } }], responses: { 200: ok, 404: err[404] } },
      },
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
      '/sessions/{id}/workspace': {
        parameters: [id],
        get: { summary: 'The panel beside the task: the folder it was built in (worktree or project), its branch, what is uncommitted or unpushed, and the shell there', responses: { 200: json({ type: 'object', properties: { dir: { type: 'string' }, gone: { type: 'boolean', description: 'The worktree is gone (merged): the shell opens in the project folder' }, worktree: { type: 'object', nullable: true }, status: { type: 'object', nullable: true }, host: { type: 'string' }, machine: { type: 'string' }, shell: { type: 'object', properties: { supported: { type: 'boolean' }, open: { type: 'boolean' }, app: { type: 'boolean', description: 'A terminal app can open the folder for this page' } } } } }), 404: err[404] } },
      },
      '/sessions/{id}/shell': {
        parameters: [id],
        get: { summary: 'Server-sent events from the shell in the task’s folder: hello, data (output, a JSON string), exit ({ code }), gone', responses: { 200: { description: 'text/event-stream', content: { 'text/event-stream': { schema: { type: 'string' } } } } } },
        post: {
          summary: 'Start the shell in the task’s folder (cols, rows; restart for a fresh one), type into it (data) or resize it',
          requestBody: body({ type: 'object', properties: { data: { type: 'string' }, cols: { type: 'integer' }, rows: { type: 'integer' }, restart: { type: 'boolean' } } }),
          responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' }, started: { type: 'boolean' }, dir: { type: 'string' }, gone: { type: 'boolean' } } }), 400: err[400], 404: err[404] },
        },
        delete: { summary: 'End the shell', responses: { 200: ok } },
      },
      '/sessions/{id}/open-shell': { parameters: [id], post: { summary: 'Open the task’s folder in the terminal app from Settings (on a machine: signed in over SSH)', responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' }, dir: { type: 'string' } } }), 409: json(ref('Error')) } } },
      '/sessions/{id}/run': {
        parameters: [id],
        get: { summary: 'The app run from the task’s folder for the side panel’s Preview (server/runs.js): command, running, ready (its port answers), port (PORT it got), url (the local address it printed, else the port), proxyUrl (the same app, framable, with the element picker), exitCode, signal, stopped, tail (its last lines). config is how to run it when nothing runs yet: .wisp/worktree.json’s run and port, the repo’s Conductor run script (file says which, cwd where it starts, problem why its file couldn’t be read, with command null), or a guess from package.json (source: config | conductor | package.json); canRun is false for a task without a folder', responses: { 200: json({ type: 'object', properties: { command: { type: ['string', 'null'] }, running: { type: 'boolean' }, ready: { type: 'boolean' }, port: { type: ['integer', 'null'] }, url: { type: ['string', 'null'] }, proxyUrl: { type: ['string', 'null'] }, exitCode: { type: ['integer', 'null'] }, tail: { type: 'string' }, config: { type: ['object', 'null'], properties: { command: { type: ['string', 'null'] }, port: { type: ['integer', 'null'] }, source: { enum: ['config', 'conductor', 'package.json'] }, file: { type: 'string' }, cwd: { type: 'string' }, problem: { type: 'string' } } }, canRun: { type: 'boolean' } } }), 404: err[404] } },
        post: {
          summary: 'Run the app in the task’s folder (its worktree), with PORT set to a free port wisp picks for the task (or the config’s port), in a process group of its own. command defaults to the config’s or the guess; restart stops the one running first (else a running app is left as it is)',
          requestBody: body({ type: 'object', properties: { command: { type: 'string' }, restart: { type: 'boolean' } } }),
          responses: { 200: json({ type: 'object' }), 400: err[400], 409: json(ref('Error'), 'The task has no folder') },
        },
        delete: { summary: 'Stop the app and everything it started', responses: { 200: ok } },
      },
      '/sessions/{id}/run/log': { parameters: [id], get: { summary: 'Server-sent events from the app’s output: hello (the run), lines (a JSON array of new lines; the first event holds the last 2000), exit ({ code, signal }), gone', responses: { 200: { description: 'text/event-stream', content: { 'text/event-stream': { schema: { type: 'string' } } } } } } },
      '/sessions/{id}/check-log': { parameters: [id, { name: 'url', in: 'query', required: true, schema: { type: 'string' } }], get: { summary: 'The last lines of a failing GitHub Actions job’s log (the check’s details URL), for asking the agent to fix it', responses: { 200: json({ type: 'object', properties: { log: { type: 'string' } } }) } } },
      '/sessions/{id}/unmasked': {
        parameters: [id],
        get: {
          summary: 'Reveal on a masked .env view (defaults.maskEnvFiles): one activity step, captured change or presentation block as stored, unmasked. The query is the masked field the session gave that item',
          parameters: [
            { name: 'turn', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'call', in: 'query', schema: { type: 'string' }, description: 'A step, by its call id' },
            { name: 'step', in: 'query', schema: { type: 'string' }, description: 'A step, by its time (t)' },
            { name: 'file', in: 'query', schema: { type: 'string' }, description: 'A captured change, by its file' },
            { name: 'block', in: 'query', schema: { type: 'integer' }, description: 'A presentation block, by its index' },
          ],
          responses: { 200: json({ type: 'object', properties: { value: { type: 'object' } } }), 404: err[404] },
        },
      },
      '/sessions/{id}/changes': { parameters: [id], get: { summary: 'What the task changed since its branch left the base (committed or not, new files included), each file with its hunks. files is null without a worktree: the page shows the edits wisp captured. With maskEnvFiles on, a .env file’s rows read KEY=•••• and it has masked: true, but for the paths named by reveal', parameters: [{ name: 'reveal', in: 'query', schema: { type: 'string' }, description: 'A .env file’s path to send unmasked (repeat for more)' }], responses: { 200: json({ type: 'object', properties: { base: { type: 'string' }, at: { type: 'string', description: 'The merge-base commit' }, files: { type: 'array', nullable: true, items: { type: 'object', properties: { path: { type: 'string' }, from: { type: 'string' }, status: { type: 'string', enum: ['A', 'M', 'D', 'R'] }, add: { type: 'integer' }, del: { type: 'integer' }, binary: { type: 'boolean' }, generated: { type: 'boolean' }, rows: { type: 'array', items: { type: 'object' } }, more: { type: 'integer' }, staged: { type: 'boolean', description: 'Has changes in the index' }, unstaged: { type: 'boolean', description: 'Has changes not staged yet (untracked counts)' }, hunkStage: { type: 'array', description: 'Per hunk of rows (modified files with something staged or to stage): { staged, unstaged }', items: { type: 'object', properties: { staged: { type: 'boolean' }, unstaged: { type: 'boolean' } } } } } } }, staged: { type: 'integer', description: 'How many files have staged changes' }, untracked: { type: 'integer', description: 'New files past the first 200, not listed' } } }), 404: err[404] } } },
      '/sessions/{id}/changes/revert': {
        parameters: [id],
        post: {
          summary: 'Put a file of Changes back as it was at the merge-base: one hunk of its diff (hunk, the index in its rows between gaps), or the whole file (modified and deleted files from the merge-base, added ones removed). restore puts a file back as it was before a revert (text, or null to remove it): Undo. Refused while the agent works on the task, and with 409 when the hunk changed since key',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['path'], properties: { path: { type: 'string', description: 'As /changes names it' }, hunk: { type: 'integer', minimum: 0 }, key: { type: 'string', description: 'The hunk’s rows as the page saw them (hashed), so a moved hunk is refused' }, restore: { type: ['string', 'null'] }, hash: { type: 'string', description: 'With restore: the sha1 the file had after the revert' } } } } } },
          responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' }, hash: { type: 'string', nullable: true, description: 'sha1 of the file now (null: it is gone), for PUT /source or restore' } } }), 400: err[400], 404: err[404], 409: { description: 'The agent is working, or the part changed since you looked' } },
        },
      },
      '/sessions/{id}/changes/stage': {
        parameters: [id],
        post: {
          summary: 'Stage a file of Changes (git add), or one hunk of its diff (the matching hunks of git diff applied to the index); unstage takes it back out (git restore --staged, or the hunk applied backwards). Refused while the agent works on the task, and with 409 when the hunk changed since key or has nothing left to move',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['path'], properties: { path: { type: 'string', description: 'As /changes names it' }, hunk: { type: 'integer', minimum: 0 }, key: { type: 'string', description: 'The hunk’s rows as the page saw them (hashed)' }, unstage: { type: 'boolean' } } } } } },
          responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' } } }), 400: err[400], 404: err[404], 409: { description: 'The agent is working, no worktree, or the part changed since you looked' } },
        },
      },
      '/sessions/{id}/changes/commit': {
        parameters: [id],
        post: {
          summary: 'Commit what is staged in the task’s worktree (all: stage everything first). 400 on an empty message or nothing staged; refused while the agent works on the task',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['message'], properties: { message: { type: 'string' }, all: { type: 'boolean' } } } } } },
          responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' }, sha: { type: 'string', description: 'The new commit, short' } } }), 400: err[400], 404: err[404], 409: { description: 'The agent is working, no worktree, or git refused (a hook, no author)' } },
        },
      },
      '/issues': {
        get: {
          summary: 'Open issues to start a task from: a project’s on GitHub (through gh, its origin remote), or the Linear issues assigned to you when a Linear connector has an API key. Kept for a minute per project and search. A problem (gh missing or signed out, no GitHub remote, no Linear key) comes back as error and fix beside an empty list',
          parameters: [{ name: 'project', in: 'query', schema: { type: 'string' }, description: 'Project id (GitHub)' }, { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Search words (gh issue list --search; a Linear title match)' }, { name: 'source', in: 'query', schema: { type: 'string', enum: ['github', 'linear', 'jira'], default: 'github' } }],
          responses: { 200: json({ type: 'object', properties: { source: { type: 'string' }, repo: { type: 'string' }, linear: { type: 'boolean', description: 'A Linear connector has an API key' }, error: { type: 'string' }, fix: { type: 'string', enum: ['install', 'signin', 'remote', 'linear', 'project'] }, issues: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, ref: { type: 'string', description: '#123, or ENG-123 on Linear' }, number: { oneOf: [{ type: 'integer' }, { type: 'string' }] }, title: { type: 'string' }, url: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } }, assignee: { type: 'string' }, body: { type: 'string', description: 'Its first 4000 characters' }, updatedAt: { type: 'string', nullable: true } } } } } }), 400: err[400], 404: err[404] },
        },
      },
      '/search': {
        get: {
          summary: 'Past work by its words: every word must be in one title, prompt or answer of a task; newest tasks first, up to three turns each',
          parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } }],
          responses: { 200: json({ type: 'object', properties: { hits: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, turn: { type: 'string', nullable: true }, where: { type: 'string', enum: ['title', 'prompt', 'answer'] }, snippet: { type: 'string' }, at: { type: 'integer' } } } } } }) },
        },
      },
      '/sessions/{id}/files': { parameters: [id], get: { summary: 'The task folder’s files as git lists them (tracked, and new ones not ignored), for Open file… in the panel’s editor. More than 20,000: the first ones and how many more', responses: { 200: json({ type: 'object', properties: { files: { type: 'array', items: { type: 'string' } }, more: { type: 'integer' }, git: { type: 'boolean' } } }), 404: err[404] } } },
      '/files': { get: { summary: 'A project’s files on this computer, as git lists them (tracked, and new ones not ignored), for @ in New task. More than 20,000: the first ones and how many more', parameters: [{ name: 'project', in: 'query', required: true, schema: { type: 'string' } }], responses: { 200: json({ type: 'object', properties: { files: { type: 'array', items: { type: 'string' } }, more: { type: 'integer' }, git: { type: 'boolean' } } }), 404: err[404] } } },
      '/sessions/{id}/lsp': {
        parameters: [id],
        post: {
          summary: 'Language intelligence for the editor from a language server found for the file (TypeScript/JavaScript, Python, Go, Rust): where a name is defined, every use, hover text, diagnostics. lsp is null when none is installed (install says which wisp can install)',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['op', 'path'], properties: { op: { type: 'string', enum: ['definition', 'references', 'hover', 'diagnostics', 'rename', 'completion'] }, newName: { type: 'string', description: 'rename: the new name; the server writes every file it changes (refused while the agent works)' }, path: { type: 'string' }, text: { type: 'string', description: 'The editor’s copy (unsaved edits too); the file on disk without it' }, line: { type: 'integer' }, col: { type: 'integer' } } } } } },
          responses: { 200: json({ type: 'object', properties: { lsp: { type: 'string', nullable: true }, install: { type: 'string', nullable: true }, hits: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'integer' }, col: { type: 'integer' }, text: { type: 'string' } } } }, hover: { type: 'string' }, diagnostics: { type: 'array', items: { type: 'object' } } } }), 400: err[400], 404: err[404] },
        },
      },
      '/lsp/install': { post: { summary: 'Install the npm language servers wisp knows (typescript-language-server, pyright) into <home>/lsp for the editor', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['lang'], properties: { lang: { type: 'string', enum: ['ts', 'py'] } } } } } }, responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' } } }), 400: err[400] } } },
      '/sessions/{id}/grep': { parameters: [id], get: { summary: 'Search the task folder’s files (git grep, case-insensitive text), or with def= find where a name is defined (a declaring keyword before it, or a function assigned to it). At most 60 hits', parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'def', in: 'query', schema: { type: 'string' } }], responses: { 200: json({ type: 'object', properties: { hits: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'integer' }, text: { type: 'string' } } } }, git: { type: 'boolean' } } }), 400: err[400], 404: err[404] } } },
      '/sessions/{id}/source': {
        parameters: [id],
        get: { summary: 'A file of the task’s folder (its worktree, or the project folder without one) as text, for the side panel’s editor', parameters: [{ name: 'path', in: 'query', required: true, schema: { type: 'string' }, description: 'Relative to the folder, as /changes names it' }], responses: { 200: json({ type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' }, hash: { type: 'string', description: 'sha1 of the file, to send back with PUT' } } }), 404: err[404], 413: { description: 'Over 1 MB' }, 415: { description: 'Not text' } } },
        put: { summary: 'Save a file of the task’s folder. Refused while the agent works on the task, and with 409 (and the file’s text and hash now) when it changed since hash', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['path', 'text'], properties: { path: { type: 'string' }, text: { type: 'string' }, hash: { type: 'string' } } } } } }, responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' }, hash: { type: 'string' } } }), 404: err[404], 409: { description: 'The agent is working, or the file changed since you opened it' } } },
      },
      '/sessions/{id}/prs': { parameters: [id], get: { summary: 'Every PR of the task in full: each check, reviewers, comments and reviews (bots marked), inline threads, files changed', responses: { 200: json({ type: 'object', properties: { prs: { type: 'array', items: { type: 'object' } } } }), 404: err[404] } } },
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
      '/stuff': {
        get: {
          summary: 'My Stuff: what you and your agents kept from tasks (pictures, videos, docs, code, files, links), newest first. publishTo: the wisp Grids an app can be published to',
          responses: { 200: json({ type: 'object', properties: { items: { type: 'array', items: ref('StuffItem') }, publishTo: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, host: { type: 'string' }, handle: { type: 'string' } } } } } }) },
        },
        post: {
          summary: 'Save to My Stuff: a link (url), text (text, with name or lang for a snippet), or a file from a task (session, path). The same key again answers the item already saved',
          requestBody: body({ type: 'object', properties: { url: { type: 'string' }, text: { type: 'string' }, name: { type: 'string' }, lang: { type: 'string' }, session: { type: 'string' }, path: { type: 'string' }, turn: { type: 'string' }, key: { type: 'string' }, title: { type: 'string' }, note: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } }),
          responses: { 200: json(ref('StuffItem'), 'Already saved'), 201: json(ref('StuffItem'), 'Saved'), 400: err[400], 404: err[404] },
        },
      },
      '/stuff/upload': {
        post: {
          summary: 'Save a file to My Stuff from its raw body',
          parameters: ['name', 'type', 'title', 'session', 'turn', 'key', 'from'].map((name) => ({ name, in: 'query', schema: { type: 'string' } })),
          requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
          responses: { 200: json(ref('StuffItem'), 'Already saved'), 201: json(ref('StuffItem'), 'Saved'), 400: err[400] },
        },
      },
      '/stuff/{sid}': {
        parameters: [stuffId],
        patch: { summary: 'Rename, note, tag or star an item', requestBody: body({ type: 'object', properties: { title: { type: 'string' }, note: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, starred: { type: 'boolean' } } }), responses: { 200: json(ref('StuffItem')), 404: err[404] } },
        delete: { summary: 'Remove an item and its file', responses: { 200: ok, 404: err[404] } },
      },
      '/stuff/{sid}/file': {
        parameters: [stuffId, { name: 'download', in: 'query', schema: { type: 'string' }, description: 'Any value: saved as a download' }],
        get: { summary: 'The item’s file, with byte ranges', responses: { 200: { description: 'The file' }, 404: err[404] } },
      },
      '/stuff/{sid}/cover': { parameters: [stuffId], get: { summary: 'An app’s picture, for its card', responses: { 200: { description: 'The picture' }, 404: err[404] } } },
      '/stuff/{sid}/launch': {
        parameters: [stuffId],
        post: { summary: 'Launch an app: wisp serves its folder on a loopback port of its own (the same one each time) until it is stopped or idle for 30 minutes', responses: { 200: json({ type: 'object', properties: { port: { type: 'integer' }, url: { type: 'string' } } }), 404: err[404] } },
        delete: { summary: 'Stop an app', responses: { 200: ok, 404: err[404] } },
      },
      '/stuff/{sid}/publish': {
        parameters: [stuffId],
        post: {
          summary: 'Publish an app to your wisp Grid (or update it there): anyone with its link can open it. account: one of publishTo (default: where it went before, else the first)',
          requestBody: body({ type: 'object', properties: { account: { type: 'string' } } }),
          responses: { 200: json(ref('StuffItem')), 404: err[404], 409: json(ref('Error'), 'Not signed in to a grid'), 413: json(ref('Error'), 'Too big') },
        },
        delete: { summary: 'Unpublish an app: its link stops working; it stays in My Stuff', responses: { 200: json(ref('StuffItem')), 404: err[404], 409: json(ref('Error'), 'Signed out of that grid') } },
      },
      '/stuff/{sid}/data': {
        parameters: [stuffId],
        delete: { summary: 'Reset an app’s data: its database goes, and is made again from its seed on the next query', responses: { 200: json(ref('StuffItem')), 404: err[404] } },
      },
      '/stuff/{sid}/allow': {
        parameters: [stuffId],
        post: {
          summary: 'Allow a pinned app (a pane) what its wisp-app.json "uses" asks for: tasks:read, tasks:write, prs:read, crew:read, usage:read. Only scopes it asks for are kept; the list replaces what was allowed. tasks:write holds only for the app’s code as it is now. 409 when this adds a scope while the task in `task`, or the task that made the app, runs in Full auto',
          requestBody: body({ type: 'object', required: ['uses'], properties: { uses: { type: 'array', items: { type: 'string', enum: ['tasks:read', 'tasks:write', 'prs:read', 'crew:read', 'usage:read'] } }, task: { type: 'string', description: 'The task the pane is shown beside, when there is one' } } }),
          responses: { 200: json(ref('StuffItem')), 404: err[404], 409: json(ref('Error'), 'A Full auto run forbids adding a scope') },
        },
        delete: { summary: 'Take back everything a pane was allowed', responses: { 200: json(ref('StuffItem')), 404: err[404] } },
      },
      '/stuff/{sid}/grant': {
        parameters: [stuffId],
        get: { summary: 'What a pane may use right now: allowed, and changed when its code moved since you allowed tasks:write (which is then off until you allow it again, or the code goes back)', responses: { 200: json({ type: 'object', required: ['allowed', 'changed'], properties: { allowed: { type: 'array', items: { type: 'string' } }, changed: { type: 'boolean' } } }), 404: err[404] } },
      },
      '/stuff/starters': {
        get: { summary: 'The panes wisp ships with: id, name, description, uses, and added, the id of its item in My Stuff once it’s there', responses: { 200: json({ type: 'object', properties: { starters: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, uses: { type: 'array', items: { type: 'string' } }, added: { type: ['string', 'null'] } } } } } }) } },
      },
      '/stuff/starters/{starter}': {
        parameters: [{ name: 'starter', in: 'path', required: true, schema: { type: 'string' } }],
        post: { summary: 'Add a starter pane to My Stuff, or answer the one already there. Grants and pins nothing', responses: { 200: json(ref('StuffItem')), 201: json(ref('StuffItem')), 404: err[404] } },
      },
      '/stuff/{sid}/restore': { parameters: [stuffId], post: { summary: 'Swap an item with its previous version (before its last update)', responses: { 200: json(ref('StuffItem')), 404: err[404] } } },
      '/stuff/{sid}/reveal': { parameters: [stuffId], post: { summary: 'Show the item’s file in its folder (on the computer running wisp)', responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' }, path: { type: 'string' } } }), 404: err[404], 409: json(ref('Error'), 'Through a proxy: the path, to copy') } } },
      '/events': {
        get: {
          summary: 'Server-sent events: summary, activity, turn, finished, removed, config, preferences, agents, stuff, ping',
          responses: { 200: { description: 'text/event-stream', content: { 'text/event-stream': { schema: { type: 'string' } } } } },
        },
      },
    },
    components: {
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'string' } } },
        StuffItem: {
          type: 'object',
          description: 'Something kept in My Stuff. Docs and code carry their opening (excerpt); links their url; apps their entry, file count and whether they run',
          properties: { id: { type: 'string' }, kind: { type: 'string', enum: ['image', 'video', 'doc', 'code', 'file', 'link', 'app'] }, entry: { type: 'string' }, files: { type: 'integer' }, cover: { type: 'boolean' }, rev: { type: 'integer' }, updatedAt: { type: 'integer' }, prev: { type: 'object', properties: { at: { type: 'integer' }, size: { type: 'integer' }, by: { type: 'string' } } }, running: { type: 'object', properties: { port: { type: 'integer' } } }, db: { type: 'boolean', description: 'The app has a database (wisp-app.json "db")' }, uses: { type: 'array', items: { type: 'string' }, description: 'What the app asks to use when pinned as a pane (wisp-app.json "uses")' }, allowed: { type: 'array', items: { type: 'string' }, description: 'What you allowed it (a subset of uses)' }, data: { type: 'boolean', description: 'Its database has been made' }, published: { type: 'object', description: 'Its public link on a wisp Grid, and the version (rev) that went up', properties: { url: { type: 'string' }, account: { type: 'string' }, host: { type: 'string' }, handle: { type: 'string' }, rev: { type: 'integer' }, at: { type: 'integer' } } }, name: { type: 'string' }, title: { type: 'string' }, mime: { type: 'string' }, size: { type: 'integer' }, at: { type: 'integer' }, by: { type: 'string', enum: ['you', 'agent', 'wisp'] }, url: { type: 'string' }, lang: { type: 'string' }, excerpt: { type: 'string' }, note: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, starred: { type: 'boolean' }, from: { type: 'object', properties: { session: { type: 'string' }, title: { type: 'string' }, turn: { type: 'string' }, key: { type: 'string' } } }, uses: { type: 'array', items: { type: 'string' }, description: 'An app’s wisp-app.json "uses"' }, allowed: { type: 'array', items: { type: 'string' }, description: 'What a pane may use now: tasks:write only while its code is what you allowed' }, changed: { type: 'boolean', description: 'Its code moved since you allowed tasks:write' }, risky: { type: 'array', items: { enum: ['webrtc'] }, description: 'What its code does that wisp can’t hold back' } },
        },
        Hold: {
          type: 'object',
          description: 'Refused: it would take the account’s usage window past the Ask near the limit line (Settings → Usage)',
          properties: {
            error: { type: 'string' },
            hold: { type: 'object', properties: { agent: { type: 'string' }, account: { type: 'string' }, id: { type: 'string', description: 'five_hour, seven_day, …' }, label: { type: 'string' }, used: { type: 'number', description: '0..1' }, to: { type: 'array', items: { type: 'number' }, description: 'Where it would likely end up, low and high (0..1)' }, resetsAt: { type: ['integer', 'null'] }, line: { type: 'number' } } },
          },
        },
        ApiKey: { type: 'object', required: ['id', 'name', 'hint', 'createdAt', 'lastUsedAt'], properties: { id: { type: 'string' }, name: { type: 'string' }, hint: { type: 'string', description: 'The last 4 characters of the key' }, createdAt: { type: 'integer' }, lastUsedAt: { type: ['integer', 'null'] } } },
        CloudSignin: { type: 'object', properties: { id: { type: 'string' }, grid: { type: 'string' }, state: { enum: ['waiting', 'done', 'denied', 'expired', 'failed', 'cancelled'] }, userCode: { type: 'string' }, verifyUrl: { type: 'string' }, expiresAt: { type: 'integer' }, error: { type: 'string' }, machineId: { type: ['string', 'null'] }, user: { type: ['object', 'null'] } } },
        Health: { type: 'object', properties: { ok: { type: 'boolean' }, name: { const: 'wisp' }, version: { type: 'string' }, apiVersion: { type: 'integer' }, pid: { type: 'integer' }, url: { type: 'string' } } },
        Agent: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, available: { type: 'boolean' }, version: { type: 'string' }, models: { type: 'array', items: { type: 'object' } }, efforts: { type: 'array', items: { type: 'string' } }, hasKey: { type: ['boolean', 'null'], description: 'opencode only: signed in to a provider or has an API key in the environment (false: its free models alone)' }, setup: { type: 'object', description: 'Only while not found: how to get it on that OS', properties: { tip: { type: 'string' }, command: { type: 'string' }, url: { type: 'string' } } }, budget: { type: 'array', description: 'How much of each account’s usage windows is gone, as its CLI last reported (Claude, Codex). hitAt: when it runs out at this pace, if before the reset. where: the tasks that used most of the longest window, and where.subagents: its share by subagent type ({ type, calls, model, output, used, instead })', items: { type: 'object', properties: { account: { type: 'string', description: 'default: the CLI’s own' }, at: { type: 'integer' }, windows: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', description: 'five_hour, seven_day, …' }, label: { type: 'string' }, used: { type: 'number', minimum: 0, maximum: 1 }, resetsAt: { type: ['integer', 'null'] }, hitAt: { type: ['integer', 'null'] } } } }, overage: { type: 'object', description: 'Past your plan: runs on this account billed beyond the plan in the last 7 days (kind: extra = Claude extra usage, credits = Codex credits, api = an API key). Each such turn also has turn.overage { kind, at }', properties: { runs: { type: 'integer' }, at: { type: 'integer' }, kind: { type: 'string', enum: ['extra', 'credits', 'api'] }, sid: { type: 'string', description: 'the last one’s task' } } }, notices: { type: 'array', description: 'Window changes (defaults.windowNotice, on unless off): a window that appeared (new), went (gone), changed length (length: wasMs) or moved its reset off its schedule (reset: wasResetsAt), until dismissed', items: { type: 'object', properties: { window: { type: 'string' }, kind: { type: 'string', enum: ['new', 'gone', 'length', 'reset'] }, label: { type: 'string' }, wasLabel: { type: 'string' }, ms: { type: ['integer', 'null'] }, wasMs: { type: ['integer', 'null'] }, resetsAt: { type: ['integer', 'null'] }, wasResetsAt: { type: ['integer', 'null'] }, at: { type: 'integer' } } } } } } }, compare: { type: 'array', description: 'Tokens per turn by account, only with several accounts: per model this harness ran on two or more accounts in the last 7 days, each account’s median finished turn (output and input tokens; input counts cache reads and writes) and the share it read from the cache, once each account shown has 5 turns on that model. A diagnostic: wisp never picks an account from it', items: { type: 'object', properties: { model: { type: 'string', description: '\'\' for the harness default' }, accounts: { type: 'array', items: { type: 'object', properties: { account: { type: 'string' }, turns: { type: 'integer' }, output: { type: 'integer' }, input: { type: 'integer' }, cache: { type: ['number', 'null'] }, missing: { type: 'array', items: { type: 'string' }, description: 'Tools another account in this row had on its latest turn and this one did not (Claude Code’s init tool list, wisp’s own MCP tools left out)' } } } } } } }, pinnedAt: { type: 'integer', description: 'Harness watch: when wisp pinned its program (path, size, sha256, version)' }, changed: { type: 'object', description: 'Harness watch: its program is not the pinned one. kind: update (version up, same install folder) or warn', properties: { kind: { type: 'string', enum: ['update', 'warn'] }, from: { type: 'object' }, to: { type: 'object' }, at: { type: 'integer' } } } } },
        Project: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, path: { type: 'string' }, color: { type: 'string' } } },
        ForeignWorktrees: {
          type: 'object',
          required: ['from', 'items', 'detached'],
          properties: {
            from: { type: 'string', description: 'The tool they came from: Conductor' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                required: ['path', 'branch', 'name', 'dirty', 'chat', 'from'],
                properties: {
                  path: { type: 'string' },
                  branch: { type: 'string', description: 'As git has it now' },
                  name: { type: 'string', description: 'The folder’s name' },
                  dirty: { type: 'integer', description: 'Lines of `git status --porcelain`' },
                  chat: { type: 'boolean', description: 'A Claude conversation was found for this folder, and resumes on the next message' },
                  from: { type: 'string', enum: ['conductor'] },
                },
              },
            },
            detached: { type: 'integer', description: 'Worktrees here with no branch: counted, not offered' },
          },
        },
        Webhook: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' }, events: { type: 'array', items: { enum: ['session.finished', 'session.waiting'] } } } },
        Launch: {
          type: 'object',
          required: ['prompt'],
          properties: {
            prompt: { type: 'string' },
            confirmLimit: { type: 'boolean', description: 'The user agreed to go ahead although it would take the account’s usage window past their Ask near the limit line (see the 409 `hold`)' },
            cwd: { type: 'string', description: 'Project folder (absolute; ~ allowed). Default: the server’s cwd' },
            also: { type: 'array', maxItems: 8, items: { type: 'string' }, description: 'More folders the same task works in (absolute; ~ allowed). The agent gets each; git repos get their own worktree, and Ship it opens a PR in each' },
            scratch: { type: 'boolean', description: 'No project folder: run in an empty scratch directory (no worktree). Overrides cwd' },
            kind: { type: 'string', enum: ['spell', 'pane'], description: 'pane: Make a pane. The agent builds an app for My Stuff and pins it (the same empty folder, Edits mode, this computer). spell: Cast a spell. The agent writes a spell that changes wisp (an empty scratch folder, Edits mode, this computer); its report ends with a spell block to keep' },
            agent: { enum: ['auto', 'claude', 'codex', 'opencode', 'cursor', 'antigravity', 'grok', 'copilot'], default: 'auto', description: 'auto: wisp picks the harness and model from what worked before; model is then the goal (cheap, balanced, best)' },
            important: { type: 'boolean', description: 'With agent auto: no exploring, take the pick with the best record' },
            autoPin: { type: 'string', description: "With agent auto: the pick a preview showed (an arm key, 'claude:opus:high'); it runs if it still can" },
            autoOverride: { type: 'object', properties: { key: { type: 'string' }, type: { type: 'string' } }, description: 'With a harness you picked: the pick Auto previewed instead, so it learns from the change' },
            mode: { enum: ['plan', 'edits', 'auto'], default: 'auto' },
            model: { type: 'string' },
            effort: { type: 'string', description: 'Thinking level: low, medium, high, xhigh, max (per harness)' },
            account: { type: 'string', description: 'Which of the harness’s accounts to run on (`/agents/{aid}/accounts`); none: your last pick (skipping one already at its usage limit)' },
            attachments: { type: 'array', items: { type: 'string' }, description: 'Upload ids' },
            worktree: { type: 'boolean', description: 'Run in a fresh git worktree + branch. Default: on in git repos (Settings), off in plan mode' },
            subagents: { type: 'array', items: { type: 'object', required: ['agent'], properties: { name: { type: 'string' }, agent: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, use: { type: 'string', description: 'When the lead should pick this one' }, count: { type: 'integer', minimum: 1, maximum: 5, description: 'Identical copies that take tasks in parallel (name#1, name#2, …); 12 in all' }, machine: { type: 'string', description: 'Where it runs: empty (with the lead), `here` (this computer), a machine id, or `sandbox` (a box of its own on your wisp Grid, kept for the task; Claude Code only). One on another place works on a copy of the lead’s work there; its changes come back as a patch' } } }, description: 'A team the lead can delegate to through the injected `delegate` tool. Each runs as a child session in the lead’s folder' },
            preset: { type: 'string', description: 'Id of a saved team (`/teams`), used when `subagents` is absent' },
            goal: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, judges: { type: 'array', maxItems: 5, items: { type: 'object', properties: { agent: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, crew: { type: 'string', description: 'A crew member, on their own harness' }, name: { type: 'string' } } }, description: 'Each checks the work on its own; [] clears them' }, vote: { enum: ['all', 'majority', 'any'], description: 'How many judges must say met (default majority). Can’t be done takes a majority' } }, description: 'Keep going until this holds: after each turn wisp checks it and sends the task back with what is missing. A prompt that is just `/goal <condition>` does the same' },
            compare: { type: 'array', maxItems: 3, items: { type: 'object', properties: { agent: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, account: { type: 'string', description: 'Which of the harness’s accounts this run uses; none = your last pick' } } }, description: 'Also run the same task on these, each in its own worktree' },
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
            sandbox: { enum: ['', 'job', 'own'], description: 'Their jobs run in a box on your wisp Grid with their project as it is here: `job` a fresh one per job (deleted with the job), `own` one kept for them (their installs stay; deleted with them). Clears machine. Claude Code or auto only' },
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
            kind: { enum: ['schedule', 'ci', 'issues', 'finished', 'done', 'webhook', 'slack', 'linear'], description: 'finished: a task finished a turn; done: a task was marked done; webhook, slack, linear: its URL (POST /hooks/{token}) was called' },
            enabled: { type: 'boolean' },
            cwd: { type: 'string', description: 'finished/done: only tasks in this project; empty = the crew member’s project, or any' },
            prompt: { type: 'string', description: 'Template; ci gets {id} {name} {branch} {sha} {url}, issues get {number} {title} {body} {url} {author}, finished/done get {id} {title} {summary} {branch} {cwd}; webhook gets {{body.a.b}} {{text}}, slack {{text}} {{user}} {{channel}}, linear {{title}} {{url}} {{description}} {{identifier}}' },
            recipeId: { type: 'string', description: 'Run this recipe instead of prompt' },
            params: { type: 'object' },
            cron: { type: 'string', description: 'schedule: when, in words ("every monday") or 5-field cron, local time; stored as cron' },
            branch: { type: 'string', description: 'ci: only failures on this branch' },
            label: { type: 'string', description: 'issues: the label to watch; linear: only issues with this label (empty: any)' },
            token: { type: 'string', readOnly: true, description: 'webhook/slack/linear: the secret part of its URL, /api/hooks/{token}' },
            regenerate: { type: 'boolean', writeOnly: true, description: 'A new token: the old URL stops working' },
            secret: { type: ['string', 'null'], writeOnly: true, description: 'webhook: signs deliveries (HMAC sha256 of the body, optional); slack: the app’s signing secret; linear: the webhook’s signing secret. Never sent back (hasSecret); left out it stays, null clears it' },
            hasSecret: { type: 'boolean', readOnly: true },
            header: { type: 'string', description: 'webhook: the header carrying the signature (default X-Hub-Signature-256), hex or sha256=hex' },
            channel: { type: 'string', description: 'slack: the channel id (C0123456789) whose mentions and messages start tasks' },
            keyword: { type: 'string', description: 'slack: only messages with this word' },
            deliveries: { type: 'array', readOnly: true, description: 'webhook/slack/linear: the last five calls', items: { type: 'object', properties: { at: { type: 'integer' }, result: { enum: ['started', 'skipped', 'rejected'] }, why: { type: 'string' }, session: { type: ['string', 'null'] } } } },
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
            compactOffer: { type: 'object', description: 'Compact now is offered: tokens, the USD estimates compact and cold (null on a model wisp has no price for), and until (ms): when the offer ends', properties: { tokens: { type: 'number' }, compact: { type: 'number', nullable: true }, cold: { type: 'number', nullable: true }, until: { type: 'number' } } },
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
            queueHeld: { type: 'boolean', description: 'A Stop held the queued follow-ups: none goes out until you send something or Send now' },
            turnCount: { type: 'integer' },
            createdAt: { type: 'integer' },
            updatedAt: { type: 'integer' },
            branch: { type: 'string', description: 'Worktree branch, if it has one' },
            foreign: { type: 'string', description: "'conductor': a worktree it was brought in on, which wisp never removes; '' otherwise" },
            pr: { type: ['object', 'null'], description: 'Its pull request, once shipped' },
            shipping: { type: ['object', 'null'], description: "{ step: start | commit | push | pr, update } while Ship it runs" },
            review: { type: ['object', 'null'], description: "Review by another harness of the PR's head (defaults.review): { status: running | done | failed | held, head, current (of the PR's head now), by: { agent, model }, summary, findings: [{ severity: high | medium | low, file, line, text }], tests: { verdict, command, passed, failed }, coverage: how much of the diff the reviewer was given, when it was computed: { files, seen (files whole), chars, seenChars, cut: [paths only partly in it], missing: [paths not in it], more (names dropped past 50 between cut and missing, left out when 0) }; seen < files is a partial review, and with no findings its summary is wisp's own, why }" },
            conflictFix: { type: ['object', 'null'], description: "{ step: fixing | pushing | done | failed, why } while wisp fixes the PR's merge conflicts: after Fix conflicts, or on its own with defaults.fixConflicts: 'on'" },
            overlaps: { type: 'array', description: 'Other open tasks in the same repo that change the same files: [{ id, title, files, more, conflicts }]. conflicts lists the files merging both would leave conflicted ([] if they merge cleanly, null if git is older than 2.38). Absent when there are none.' },
            groupId: { type: ['string', 'null'], description: 'Shared by sessions launched together with compare' },
            origin: { type: ['object', 'null'], description: '{ kind: recipe | trigger, id, name } when not launched by hand' },
            keepWorktree: { type: 'boolean', description: 'The worktree cleanup leaves this task’s folder alone (PATCH keepWorktree)' },
            lean: { enum: ['on', 'off'], description: 'This task’s own lean runs choice (PATCH lean), when it has one' },
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
