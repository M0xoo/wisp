# Accounts: more than one subscription per harness

Two Claude Code plans (work and personal, or two Max seats), two ChatGPT logins for Codex, and so
on. You pick which one a task runs on; when one hits its limit, the task asks you what next.
Status: **built for Claude Code and Codex** (`server/accounts.js`, `test/accounts.test.js`).
Reviewed by Sana (backend) and Gucci (UI), marked *(review)*, and by Karen (legal) against the
providers' terms, marked *(legal)*. Mockup: `design/mockups/accounts.html`; the built UI:
`design/mockups/built-*.png`.

## Can the CLIs do it?

Yes. Each CLI keeps its login in one folder, and you can point it at a different folder with an env
var. So an account is just that folder.

| Harness | Where the login lives | How to switch | v1 |
|---|---|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR` (default `~/.claude` + `~/.claude.json`; on macOS the keychain item is named per config dir) | `CLAUDE_CONFIG_DIR=<dir>` | yes |
| Codex | `CODEX_HOME/auth.json` | `CODEX_HOME=<dir>` | yes |
| Grok | `GROK_HOME` | `GROK_HOME=<dir>` | later *(review)* |
| opencode | `$XDG_DATA_HOME/opencode/auth.json` (API keys) | a second key per provider | later *(review)* |
| Cursor, Copilot, Antigravity | no documented home override | `HOME=<dir>` would also hide git/ssh config | later |

**Default account = what you have today.** The CLI's own home (`~/.claude`) is the account named
after its email. Someone with one login sees no change at all: no account row, no chip, nothing.

## Storage

```
~/.wisp/accounts.json
  { "claude": [ { "id": "default", "label": "Work",     "email": "a@corp.com", "plan": "Max", "home": null },
                { "id": "k3f9",    "label": "Personal", "email": "a@gmail.com", "plan": "Pro", "home": "~/.wisp/accounts/claude/k3f9" } ],
    "codex":  [ … ] }
~/.wisp/accounts/<harness>/<id>/          the extra account's home: only its login is its own
```

- The order in the list is the order Auto tries them in. `home: null` is the CLI's own folder.
- **Shared everything except the login.** An extra account's folder links to **everything** in the
  default home except the credentials, not a fixed list (Claude also has `todos/`, `file-history/`,
  `plans/`, `history.jsonl`) *(review)*. Link **directories**, never single files: the CLIs write
  `settings.json` / `config.toml` atomically, which replaces a file symlink with a real file
  *(review)*. Targets are created in the default home first; links are checked and repaired on
  every launch; junctions on Windows.
- **`.claude.json` can't be linked** *(review)*: under `CLAUDE_CONFIG_DIR` it moves inside the dir
  and holds both the login (`oauthAccount`, `userID`) and your user/local `mcpServers` and `.mcp.json`
  approvals. On add, copy it without `oauthAccount`/`userID`; on each launch, merge the default
  home's user/local `mcpServers` into the `--mcp-config` wisp already builds and sync
  `enabledMcpjsonServers` for the cwd, so account B never silently loses MCP. Your MCP servers,
  skills and memory stay the same on every account, and, since `projects/` / `sessions/` are
  shared, **a conversation started on one account can be resumed on another**. That is what lets a
  task switch account in the middle without starting over. Only `.credentials.json` / `auth.json`
  / `.claude.json`'s `oauthAccount` (and the keychain item) belong to the account.
- `home` is stored absolute and normalized and passed exactly: Claude's macOS keychain item hashes
  that path string *(review)*. If you already set `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, that is the
  default home.
- An API key in the env (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) overrides any login, so while one
  is set the harness shows no extra accounts *(review)*. Codex extra accounts run with
  `-c cli_auth_credentials_store="file"` so the login stays in their folder.
- Nothing secret goes in `accounts.json`; email and plan come from `claude auth status` /
  `codex login status` and are only shown.

## Running a task on an account

- `session.account` (harness id → account id) is set at launch and copied onto each turn
  (`turn.account`). The adapter gets `accountEnv` merged into its env (`CLAUDE_CONFIG_DIR`,
  `CODEX_HOME`); wisp's own small runs (`quick.js`, `preferences.js`) get `sideEnv()`, so they
  bill an account of yours too.
- Follow-ups stay on the task's account unless you switch it (the picker in the reply box, or the
  limit card).
- Machines and cloud computers keep their own accounts (their own `~/.wisp/accounts.json`); the
  picker lists the accounts of the place the task runs on, as it does with harnesses.
- Subagents and crew jobs pick like any launch, as unattended ones: your saved account, never
  routed round a limit *(legal)*.
- Signing in is keyed by `harness/account`, and login, status and logout all get the account's env
  *(review)*.

## Picking an account

**You pick** in the runner picker (below). The choice is remembered per harness like the model is
(`defaults.accounts.<harness>`; `'auto'` or none: your saved account).

**Without a pick**, a launch takes your saved account, else the first in your order. A launch you
start yourself skips one already known to be at its limit, as you would in the picker; unattended
launches (crew jobs, schedules, triggers, subagents) take it as it is, and a limit there asks you
*(legal)*. There is no *Spread the work* and no load balancing across accounts, ever *(legal)*.

Auto's learning doesn't change: arms stay harness × model × level (an Opus run is an Opus run on
any account), and the account is picked under the arm (`Accounts.pick`).

## Hitting a limit *(legal)*

`infraError()` tells a usage limit (scope `agent`, until the reset) from a rate limit (scope `arm`).
On a usage limit with several accounts, `Runner.#atLimit` marks **that account** until its reset
and the turn gets `turn.limit = { account, until, kind, others, extra }`: the task stops in Needs
you with a card under the hero:

> **Work is at its usage limit** (the hero, no time) · *At its limit until 9 pm* (the card, in the page's time format)
> [Wait until 9 pm] [Continue on Personal] [Hand to Codex] [Get extra usage ↗]
> *Personal is a personal plan. This conversation, with its code, will go to it.* (only across kinds)

- **Wait until 9 pm** schedules a follow-up into the same task at the reset (`POST /sessions/:id/later`).
- **Continue on Personal** is a follow-up with `account` (same conversation: Claude resumes it, since
  transcripts are shared; Codex starts afresh with a handoff of the turns, `resumes: false`).
- **Hand to Codex** is a follow-up with `agent`.
- **Get extra usage** opens the provider's own page (`HOMES[agent].extra`).

wisp **never** moves a task to another account by itself. Auto may still hand a task to another
*harness* at a limit (`#moveOn`): each account stays within its own limits. A rate limit (429 /
overloaded) changes nothing about accounts.

## Terms *(legal)*

Karen (crew, legal) checked Anthropic's and OpenAI's terms on 2026-10-26 (full report in her
folder: `legal/accounts-terms-review-2026-10-26.md`). Not legal advice; the short version:

| Case | Verdict | Basis |
|---|---|---|
| Your own plan + your employer's seat, picked by hand | allowed | Anthropic's help center documents switching between them |
| Two personal plans of one provider, picked by hand | grey, low risk | no one-account rule; limits stay per account |
| Switching to another account *because* one hit its limit | **grey, high risk: not built** | Anthropic AUP *"bypass … restrictions … established within our products"*, Consumer Terms §3 *"bypassing any of our systems or protective measures"*; OpenAI Terms *"circumvent any rate limits or restrictions"* |
| Several people on one login (Grid) | **prohibited** | Anthropic Consumer Terms §2; OpenAI Terms (Registration), Services Agreement 3.1/3.2 |

So: a limit asks, accounts have a kind (personal / work) and moving a conversation across kinds
warns, *Add another account* shows a notice (only accounts that are yours; no combining limits),
Grid says one person per login, credentials are never linked or copied (`own`, `NO_SYNC`, tested),
sign-in only through the CLI's own login, and the words are *accounts* and *pick which account a
task runs on*, never quota, more usage, rotate, pool, combine or unlimited. Re-read both usage
policies after their new versions take effect (Anthropic Nov 12, OpenAI Nov 20, 2026).

## UI

### Runner picker (launcher and reply box)

The picker already has harnesses on the left, models on the right and thinking levels underneath.
Accounts get a row of their own under the levels, shown **only when the focused harness has two or
more**:

```
┌ Claude ───────────┬ Opus 5.5 ✓ ──────────────────────┐
│ Codex             │ Sonnet 5.5                       │
│ Grok              │ Haiku 5.5                        │
│                   ├──────────────────────────────────┤
│                   │ Thinking  Default  Low  Med  High│
│                   │ Account   [Auto] [● Work] [◐ Personal · resets 9 pm] │
└───────────────────┴──────────────────────────────────┘
```

- Each account is a segment with a **neutral** initial (`--bg-2`, 1px `--line-2`, `--ink-2`; no
  project colours, which `ui.md` keeps for projects) and its label *(review)*. State is never in the
  initial: a clock icon on the segment, and one line under the row: *Personal is at its limit until
  9 pm.* *Signed out* accounts are greyed. One time phrase everywhere: *at its limit until 9 pm*
  *(review)*.
- **Auto** is first: Auto's account policy. Picking a cooling account is allowed (you may know the
  reset is close); it starts and, if it's still at the limit, follows *Hitting a limit*.

### The chip on the prompt / reply box

Today: `[logo] Opus 5.5 · High`. With more than one account: `[logo with initial] Opus 5.5 · High
| Work`. The account is its own `.rb-a` (`flex: none`) after `.rb-e`, not appended to `.rb-m`
(max 180px, it would be cut off); hidden where `.rb-m` folds (≤720px); nothing for Auto
*(review)*. The initial sits bottom-right of the logo; Auto's `.routed` dot moves top-right
*(review)*.

### On the task

- **Sidebar cards and the task head don't change**: split view hides the card's logo and the
  head is title-only *(review)*.
- **Details column**: the harness row (`.it-props`) reads `Claude · Opus 5.5 · High thinking ·
  Personal`, with the initial on the logo.
- **Turn meta** (under each answer): the account when it differs from the turn before *(review)*.
- **A turn that hit a limit** shows the card from *Hitting a limit* under its hero (`turn.limit`).

### Settings → Agents

The count goes in the harness's small line (`2.1.30 · 3 models · 2 accounts`), and an account
list replaces today's single *Signed in as…* line. Account rows show state only when it's not
ready, so *Ready* isn't repeated per row *(review)*:

```
Claude Code                                            ● Ready
2.1.30 · 3 models · 2 accounts
  (W) Work      a@corp.com · Max                                 ⋯
  (P) Personal  a@gmail.com · Pro   ◷ At its limit until 9 pm   ⋯
  + Add another Claude account
```

- **Add another account** opens a small dialog: a label (blank: the email's name part), Personal /
  Work, and the notice *(legal)*: *Only add accounts that are yours. … it won't switch accounts to
  get around a limit: when one runs out, it asks you first. …* Then today's sign-in flow (link +
  code, `server/agent-login.js`) with the new account's home in the env.
- Each row shows its kind after the plan (`a@corp.com · Max · Work`); the kind is guessed from the
  plan (Team, Enterprise, Business, Edu: work) until you set it in `⋯`.
- On wisp Grid: *Sign in with your own account. Each person on this wisp signs in for themselves; a
  login can't be shared.* *(legal)*
- `⋯` holds Rename, Move up, Move down, Sign out, Remove (the order is Auto's order; no drag or
  colour in v1) *(review)*. Remove runs the CLI's logout with that account's env first, then deletes
  the folder; it asks, since the login is lost.

### Usage

Unchanged in v1 *(review)*; a **By account** table comes later (turns already record
`turn.account`).

### Phones

The picker turns into one column (harnesses as a row on top, then models, levels, accounts).
Settings → Agents's account rows wrap the email and the limit onto their own lines. Reorder is
⋯ → Move up / Move down, the same as desktop.

## Spells

- No new `SETTINGS`: there is nothing to switch on or off about limits *(legal)*.
- `PARTS`: `picker.accounts`, `runner.account` (the chip's `.rb-a`), `details.account` (the
  account on the details harness row) *(review)*, `settings.accounts`. Not the limit card: it asks you something, and spells never hide those.
- No `PART_PROPS` needed in v1.

## API

```
GET    /api/agents/:id/accounts                    { accounts: [{ id, label, email, plan, kind, default, state: ready | limit | signedOut, until }] }
POST   /api/agents/:id/accounts                    { label, kind } → { account, accounts, login } (its sign-in starts at once)
PATCH  /api/agents/:id/accounts/:acc               { label, kind, move: up | down } → { accounts }
DELETE /api/agents/:id/accounts/:acc               signs it out, removes the folder → { accounts }
…/agents/:id/login, /login/input, /logout          ?account=<id> for an extra account
POST   /api/sessions, /api/sessions/:id/reply      account: which account (a follow-up switches the task from then on)
/api/machines/:mid/agents/:id/accounts…            the same, on a machine
```

All in `server/openapi.js`. `/agents` keeps returning one entry per harness, with `accounts: [...]`
added, so older pages keep working.

## Out of scope for v1

- Cursor, Copilot, Antigravity accounts (no home override; `HOME=` is too wide). Grok and
  opencode follow once Claude and Codex are in *(review)*.
- The *By account* usage table, drag to reorder, account colours. (*Spread the work* is out for
  good *(legal)*.)
- Reading remaining quota ahead of time. Claude and Codex don't expose it to the CLI reliably;
  wisp learns limits from the errors, as Auto does today.
- Sharing an account between people (Grid): each person's accounts stay in their own home.

## Risks

- Provider terms: see *Terms*. Enforcement can come without notice, so the line stays: wisp never
  switches accounts because of a limit.
- macOS keychain: Claude names the keychain item per `CLAUDE_CONFIG_DIR` (checked on Claude Code
  2.1.309: a fresh folder reports signed out while `~/.claude` is signed in). Older versions may
  not; such a version would show the second account signed in as the first.
- Not yet tried with two real logins: resuming a Claude conversation on the other account, and
  Codex's `CODEX_HOME` login (its keyring entry is assumed to follow the folder).
- Symlinked `projects/` means two accounts can write the same transcript folder; only one turn of a
  task runs at a time, so they never write the same file at once.
