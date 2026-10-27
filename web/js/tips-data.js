// The tips under the prompt box (features/tips.js), each with the trywisp.dev guide section that
// explains it. DOM-free, so test/site.test.js can check every link lands on a real page and heading.

const SITE = 'https://trywisp.dev';
const G = (slug, at = '') => `${SITE}/guides/${slug}.html${at && `#${at}`}`;
const PARALLEL = 'run-claude-code-and-codex-in-parallel';
const MANY = 'run-multiple-claude-code-agents-in-parallel';
const MACHINES = 'run-coding-agents-on-multiple-machines';
const MOVE = 'move-a-task-to-another-machine-or-agent';
const TEAM = 'multi-agent-coding';
const BG = 'run-coding-agents-in-the-background';
const VS = 'claude-code-vs-codex';
const SPELLS = 'customize-wisp-with-spells';
const ACCOUNTS = 'use-work-and-personal-claude-code-accounts';
const GOALS = 'make-claude-code-keep-going-until-tests-pass';

// [what to try, where it's explained]. Short enough for one line at the home's reading width.
export const TIPS = [
  ['Turn on <b>Goal</b>, say when it’s done, and wisp sends the task back each round until it holds', G(GOALS, 'the-check')],
  ['Type <b>/goal</b> in a reply box to keep a task going until your condition holds', G(GOALS, 'done-when')],
  ['Click <b>vs</b> in the launcher to run the same task on two agents, each on its own branch', G(PARALLEL, 'with-wisp')],
  ['<b>Compare</b> lines runs up side by side: time, cost, tests and the diff. <b>Keep this</b> keeps the winner', G(VS, 'run-the-comparison')],
  ['Leave the harness on <b>Auto</b> and wisp picks the agent and model per task from what worked for you', G(VS, 'let-results-pick')],
  ['When Claude Code hits its usage limit, Auto rests it and hands the next tasks to another agent', G(MANY, 'how-many')],
  ['Every task gets its own git worktree and branch, so parallel agents never touch the same files', G(MANY, 'why-worktrees')],
  ['Press <kbd>N</kbd>, describe a task, Enter, and the next one: launch tasks back to back', G(MANY, 'with-wisp')],
  ['Press <kbd>T</kbd> on a task to take it over in your own terminal, in its worktree', G(MANY, 'with-wisp')],
  ['<b>Ship it</b> commits, pushes and opens the PR; <b>Merge</b> squash-merges and syncs your local main', G(MANY, 'with-wisp')],
  ['Give one agent a team: <b>Delegate</b> lets a Claude Code lead hand work to Codex copies in parallel', G(TEAM, 'team')],
  ['<b>Delegate</b> can put a member on another machine: the lead hands it work there and gets the changes back', G(TEAM, 'team')],
  ['<b>Save as preset</b> in Delegate keeps a team for the next big task', G(TEAM, 'team')],
  ['Add <code>wisp mcp</code> to the agent in your editor and it can launch and wait on wisp tasks', G(TEAM, 'from-another-agent')],
  ['<b>Run on</b> next to the harness sends one prompt to several machines at once', G(MACHINES, 'one-prompt-several-machines')],
  ['<b>Machines</b> connects any computer you can SSH into: a desktop, a dev box, a cloud VM', G(MACHINES, 'how-it-works')],
  ['Laptop battery low? <b>Runs on</b> by the follow-up box moves the task, branch and history to another computer', G(MOVE, 'with-wisp')],
  ['Stuck agent? Switch the harness in the follow-up box and Codex picks up where Claude Code stopped', G(MOVE, 'switch-agent')],
  ['<b>Rerun</b> can start a task over on another machine or with another agent', G(MOVE, 'with-wisp')],
  ['Tailscale makes your machines reachable from anywhere, phone included, with nothing exposed', G('connect-machines-with-tailscale')],
  ['Reach this computer from your phone: <b>Machines</b> → <i>Reach this computer from anywhere</i>', G('reach-your-computer-from-your-phone', 'add')],
  ['Close the laptop: tasks on wisp Cloud or another machine keep working', G('run-claude-code-24-7-without-a-vps')],
  ['wisp Cloud gives you a box with Claude Code, Codex and Cursor installed, free during the preview', G('use-wisp-cloud')],
  ['Pick <b>Plan</b> for read-only, <b>Edits</b> to approve commands, or <b>Full auto</b>, per task', G(BG, 'start')],
  ['Questions and finished tasks can go to your phone through ntfy or Telegram', G(BG, 'away')],
  ['<code>/btw</code> asks a running agent something without interrupting it', G(BG, 'away')],
  ['<b>Recipes</b> are saved prompts with <code>{params}</code>: one click for the tasks you repeat', G(BG, 'triggers')],
  ['<b>Triggers</b> run a recipe on a schedule, when CI fails, or when an issue gets a label', G(BG, 'triggers')],
  ['Every turn is checkpointed in its worktree, so you can roll an agent’s work back', G(BG, 'headless-gaps')],
  ['<code>wisp "fix the flaky test" --wait --json</code> runs a task from a script and waits for it', G(BG, 'start')],
  ['Webhooks, a JS SDK and an HTTP API let your own tools start tasks and read reports', `${SITE}/integrations.html#webhooks`],
  ['Type <code>/spell</code> and describe a change: wisp builds it into itself, and you try it first', G(SPELLS, 'cast')],
  ['Spells add buttons, panels, chips and commands, restyle wisp, or hide what you don’t use', G(SPELLS, 'what')],
  ['Share a spell with your team as one file or one link', G(SPELLS, 'share')],
  ['wisp looks odd? Settings → Spells → <i>Turn every spell off</i>, or start with <code>WISP_SAFE=1</code>', G(SPELLS, 'trouble')],
  ['wisp runs Claude Code, Codex, Cursor, opencode, Antigravity, Grok and Copilot CLIs you already have', `${SITE}/agents/`],
  ['Run your own wisp Grid for your team: sign-in, a sandbox each, on one server', G('self-host-wisp-grid')],
  ['Have a work and a personal Claude plan? Add the other in Settings → Agents and pick one per task', G(ACCOUNTS, 'with-wisp')],
  ['At an account’s limit the task asks what to do; wisp never switches accounts for you', G(ACCOUNTS, 'limits')],
];

// The phone app's computers screen (mobile/www/app.js; scripts/shared.mjs copies this file there):
// what a first-time user can do from the phone, in the same shape.
const PHONE = 'reach-your-computer-from-your-phone';
export const PHONE_TIPS = [
  ['<b>Cloud</b> is your wisp on a server: its agents keep working with every computer switched off', G('use-wisp-cloud', 'phone')],
  ['<b>Your computer</b> opens while it’s awake: tasks there run on its own files, repos and tools', G(PHONE, 'phone')],
  ['Lock the phone or switch apps: tasks run on the computer, not here, and wait for you when they ask', G(BG, 'away')],
  ['Inside a computer, <b>New task</b> starts one; tap the <b>wisp logo</b> to come back here', G(PHONE, 'phone')],
  ['Questions from your agents show under <b>Needs you</b>: answer from here and the task picks up', G(BG, 'away')],
  ['Leave the agent on <b>Auto</b> and wisp picks the agent and model per task from what worked for you', G(VS, 'let-results-pick')],
  ['Start several tasks at once: each gets its own branch, so agents never touch the same files', G(MANY, 'why-worktrees')],
  ['Turn on <b>Goal</b> and a task keeps going round after round until your check passes', G(GOALS, 'the-check')],
  ['<b>Ship it</b> commits, pushes and opens the pull request, right from your phone', G(MANY, 'with-wisp')],
  ['Signed in to Claude Code or Codex on that computer? The phone uses them as they are', `${SITE}/agents/`],
  ['No ports to open: the grid carries the page to you, while your files and logins stay on the computer', G(PHONE, 'private')],
];
