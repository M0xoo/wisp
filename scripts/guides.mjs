// The docs site's guides: one page per thing people search for that wisp does (Claude Code and Codex
// in parallel, agents on several machines, …). scripts/site.mjs renders them under /guides/.
//
// Each guide answers its question in the lede (search engines and AI answers quote the opening),
// shows the manual way too, then how wisp does it. Keep the facts in step with the README.
//
// h: helpers from site.mjs ({ esc, sh, shot, installButton, agents }).
//
// The spells guide's reference tables and examples come from wisp's own spell schema and the
// examples its Cast a spell agent gets, so the guide can't drift from what wisp accepts.

import { ACTIONS, EVENTS, GH_READ, HOOK_IF, SLOTS, WISP_DATA } from '../web/js/spell-schema.js';
import { SPELL_EXAMPLES } from '../server/spell-guide.js';

const REACH = { safe: 'Safe', acts: 'Acts for you', runs: 'Runs commands' };
// An action's doc starts with its JSON example ({ "open": "…" } open one link); keep the words after it.
function actionText(doc) {
  let depth = 0;
  let str = false;
  for (let i = 0; i < doc.length; i++) {
    const c = doc[i];
    if (str) { if (c === '\\') i++; else if (c === '"') str = false; continue; }
    if (c === '"') str = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return doc.slice(i + 1).trim().replace(/^./, (x) => x.toUpperCase());
  }
  return doc;
}
const spellOf = (id) => SPELL_EXAMPLES.find((x) => x.spell.id === id).spell;
// The spell fields the guide lists besides the ones its example shows.
const FIELDS = [
  ['description', 'One sentence, shown in Settings → Spells and on its review'],
  ['chips', 'Small labels on a card head or under the prompt and follow-up boxes, from a template or a script'],
  ['panels', 'Dialogs, drawers and panels above the feed or inside a card, drawn by a script from the spell’s data'],
  ['parts', 'Restyle a named part of wisp, set its props (a monospace prompt box, compact cards) or reorder the card head'],
  ['ui', '<code>hide</code> named parts; <code>tokens</code> and <code>dark</code> recolour wisp'],
  ['blocks', 'New report block types agents can use'],
  ['prompt', 'Rules added to agents’ prompts, for all tasks or some'],
  ['settings', 'Settings that win over yours while the spell is on (shown as <i>Set by …</i> in Settings)'],
  ['slash', '<code>/commands</code> for the follow-up box'],
  ['commands', '⌘K items, optionally with a single-key shortcut'],
  ['hooks', 'Something wisp does on its own when a turn finishes, fails, starts or waits'],
  ['recipes', 'Saved prompts with <code>{params}</code>'],
  ['harnesses, when', 'Which harnesses, projects, agents and modes its rules, blocks and hooks apply to'],
  ['script', 'JavaScript functions that turn data into blocks, strings or links, run in a sandbox'],
];

export function guides(h) {
  const { esc, sh, shot, installButton } = h;
  // Lists of plain values stay on one line, so a spell reads like the file people write.
  const json = (obj) => `<pre data-lang="json"><code>${esc(JSON.stringify(obj, null, 2).replace(/\[\s*\n((?:\s*(?:"(?:[^"\\]|\\.)*"|-?\d[\d.]*|true|false|null),?\n)+)\s*\]/g, (m, items) => `[${items.split('\n').map((x) => x.trim()).filter(Boolean).join(' ')}]`))}</code></pre>`;
  const claude = h.agents.find((a) => a.id === 'claude');
  const codex = h.agents.find((a) => a.id === 'codex');

  return [
    {
      slug: 'run-claude-code-and-codex-in-parallel',
      title: 'How to run Claude Code and Codex in parallel — wisp',
      h1: 'Run Claude Code and Codex in parallel',
      card: 'Same task on both agents, or different tasks at once, each on its own branch.',
      description: 'Run Claude Code and OpenAI Codex at the same time on one repo: a git worktree per agent, both CLIs headless, then compare tests, time and diffs. The manual way, and the one-click way with wisp.',
      lede: 'To run Claude Code and Codex in parallel on the same repo, give each agent its own git worktree and branch, start both CLIs headless, and compare what they did before you merge. wisp does all of it in one step: type the task, click <b>vs</b>, and both agents work side by side while you do something else.',
      shot: ['compare', 'Compare view: Claude Code and Codex ran the same task; each column shows time, cost, tests and a Keep this button', 'story-'],
      body: `
    <section>
      <h2 id="why">Why run both</h2>
      <ul class="doc-list">
        <li><b>The same task on both.</b> Two agents make different assumptions. Running both shows you which diff needs less review, and on a hard bug one of them often finds the cause the other missed.</li>
        <li><b>Different tasks at once.</b> Codex fixes the flaky test while Claude Code does the migration. Two subscriptions, twice the work, no waiting for one agent to finish.</li>
        <li><b>Usage limits.</b> When one agent hits its limit, the other keeps going.</li>
      </ul>
    </section>

    <section>
      <h2 id="manual">The manual way: one git worktree per agent</h2>
      <p>Two agents in one folder overwrite each other’s files and run tests against each other’s half-finished edits. A <a href="https://git-scm.com/docs/git-worktree" target="_blank" rel="noopener">git worktree</a> gives each one its own checkout and branch of the same repo:</p>
      ${sh(`git fetch origin
git worktree add ../app-claude -b try/claude origin/main
git worktree add ../app-codex  -b try/codex  origin/main

(cd ../app-claude && claude -p "fix the flaky auth test" --permission-mode acceptEdits) &
(cd ../app-codex  && codex exec -c sandbox_mode="workspace-write" "fix the flaky auth test") &
wait

git diff --stat origin/main...try/claude
git diff --stat origin/main...try/codex`)}
      <p>That works, with gaps: a headless agent that needs a decision guesses instead of asking, nothing tells you when a run is done, you read two transcripts to find out what happened, each worktree needs its own <code>npm install</code>, and you clean up the worktrees and branches yourself.</p>
    </section>

    <section>
      <h2 id="with-wisp">With wisp: click vs</h2>
      <ol class="doc-steps">
        <li><b>Start wisp.</b> ${installButton()}</li>
        <li><b>Pick Claude Code in the launcher, click vs and pick Codex</b> (and a model for each, if you like). Describe the task and press Enter.</li>
        <li><b>Go do something else.</b> Each run gets its own worktree and branch from <code>origin/main</code>. Both show up as one task with a row per agent. If either needs a decision, it asks you, and you get a notification.</li>
        <li><b>Compare.</b> The task’s <b>Compare</b> view lines the runs up: time, cost where the CLI reports it, files changed, tests, and each agent’s one-screen report with the real diff.</li>
        <li><b>Keep the winner.</b> <b>Keep this</b> archives the other run and deletes its worktree. <b>Ship it</b> commits, pushes and opens the pull request.</li>
      </ol>
      <p>From a terminal, the same thing:</p>
      ${sh(`wisp "fix the flaky auth test" --agent claude --compare codex
# three at once
wisp "fix the flaky auth test" --agent claude --compare codex,opencode`)}
    </section>

    <section>
      <h2 id="split">Or split the work between them</h2>
      <p>Launch tasks back to back and pick a different agent for each. Every task gets its own worktree, so Claude Code and Codex can work on the same repo at the same time without colliding. Leave the harness on <b>Auto</b> and wisp picks the agent and model per task from what worked for you before.</p>
      <p>For one big task, give the lead agent a team: Claude Code plans and hands the tests to three Codex copies, which work in parallel. See <a href="/guides/multi-agent-coding.html">multi-agent coding</a>.</p>
    </section>
`,
      faq: [
        ['Can Claude Code and Codex edit the same repo at the same time?', 'Yes, as long as each has its own working copy. In one folder they overwrite each other’s files. wisp gives every run its own git worktree and branch, so both can work on the same repo at once.'],
        ['Does running both cost more?', 'Each agent bills to its own account (Anthropic for Claude Code, OpenAI for Codex), the same as running the CLIs yourself. wisp is free and open source. The Compare view shows time and, where the CLI reports it, the cost of each run.'],
        ['Do I need API keys?', 'No. wisp runs the claude and codex CLIs you already have installed and signed in, with whatever plan they use.'],
        ['Can I compare more than two agents?', 'Yes. Pass several harnesses to --compare (codex,opencode,cursor), or add more in the launcher. Each run gets its own worktree.'],
      ],
      related: ['claude-code-vs-codex', 'run-multiple-claude-code-agents-in-parallel', 'multi-agent-coding'],
    },

    {
      slug: 'run-coding-agents-on-multiple-machines',
      title: 'Run Claude Code and Codex on multiple machines over SSH — wisp',
      h1: 'Run coding agents on multiple machines',
      card: 'Your desktop, a dev box, a cloud VM: one prompt, several machines, one queue.',
      description: 'Run Claude Code, Codex and other coding agents on your other computers over SSH: one prompt on several machines in parallel, one queue on your laptop, and agents that keep working when it sleeps.',
      lede: 'wisp runs Claude Code, Codex and other coding agent CLIs on your other computers over plain SSH: a desktop, a dev box, a cloud VM or a Mac mini on Tailscale. One prompt can go to several machines in parallel, every run lands in one queue on your laptop, and the agents keep working when the laptop sleeps.',
      shot: ['app', 'The wisp queue with tasks from this computer and from other machines, grouped into Needs you, Working and Done'],
      body: `
    <section>
      <h2 id="why">Why run agents on other machines</h2>
      <ul class="doc-list">
        <li><b>Close the laptop.</b> A run on a desktop or a VM doesn’t stop when your laptop sleeps, loses Wi-Fi or runs out of battery.</li>
        <li><b>More agents at once.</b> Builds and test suites from five parallel agents are too much for one laptop. Spread them out.</li>
        <li><b>The right box for the job.</b> Linux for the server code, the GPU machine for the model code, the Mac for the iOS app.</li>
      </ul>
    </section>

    <section>
      <h2 id="how-it-works">How it works</h2>
      <p>Open <b>Machines</b> (top bar, Settings or <kbd>⌘</kbd><kbd>K</kbd>). wisp lists the hosts this computer already knows from <code>~/.ssh/config</code>, <code>known_hosts</code> and Tailscale; pick one, or type <code>user@host</code>, and press <b>Connect</b>:</p>
      <ol class="doc-steps">
        <li>wisp signs in with <code>ssh</code> using your keys, agent and config. Never a password.</li>
        <li>On the machine it finds Node.js 20+ and starts <code>npx -y wisp-agents --no-open</code> detached, at the same version as yours, or reuses the wisp already running there.</li>
        <li>It forwards a free local port to that wisp with <code>ssh -L</code> and relays its events into your queue.</li>
      </ol>
      <p>Nothing new listens on the network: wisp on the machine stays on its own <code>127.0.0.1</code>. There is no account, relay server or cloud in between. The machine needs SSH access with a key, Node.js 20+ and the agent CLIs you want to run, signed in.</p>
    </section>

    <section>
      <h2 id="one-prompt-several-machines">One prompt, several machines</h2>
      <p>In the launcher, <b>Run on</b> (next to the harness) picks where the prompt goes: this computer, any machine, or several at once. Enter launches on every place in parallel, and the runs land as one task with a row per machine.</p>
      <p>Every project runs on every machine. If a machine has no checkout yet, wisp reuses a clone of the same repo it finds there, or clones the project’s <code>origin</code> first.</p>
      <p>On the machine, everything works as it does locally: a worktree per task, real diffs, checkpoints and rollback, questions mid-run, subagents, compare and <b>Ship it</b>. <b>Take over</b> opens <code>ssh -t &lt;host&gt;</code> and resumes the agent in your terminal, and VS Code, Cursor or Windsurf open the worktree through Remote - SSH.</p>
    </section>

    <section>
      <h2 id="move-a-task">Move a task to another computer</h2>
      <p>Started on the laptop and want it to keep going on the desktop? The <b>Runs on</b> button next to the follow-up box moves your next message, and the task, to another computer. The branch and its uncommitted work travel as a git bundle into a worktree on the same branch there, and the earlier turns come along, so the agent picks up where it stopped. The same follow-up can switch agents. <b>Rerun</b> has the same picker. <a href="/guides/move-a-task-to-another-machine-or-agent.html">How moving a task works →</a></p>
    </section>

    <section>
      <h2 id="manual">Without wisp</h2>
      <p>You can do a version of this with <code>ssh</code> and <code>tmux</code>:</p>
      ${sh(`ssh devbox
cd ~/code/app && git worktree add ../app-fix -b fix/auth origin/main
tmux new -d -s fix 'cd ../app-fix && claude -p "fix the flaky auth test"'`)}
      <p>Then repeat per machine and per task, check each <code>tmux</code> session by hand, and copy the results back. wisp keeps the SSH part and adds the queue, the questions, the reports and shipping on top.</p>
    </section>
`,
      faq: [
        ['Do I need a server or a cloud account?', 'No. Any computer you can SSH into with a key works: a desktop, a home server, a cloud VM, a machine on Tailscale. wisp starts itself there with npx.'],
        ['Does it open ports on the machine?', 'No. wisp on the machine listens only on its own 127.0.0.1. Your laptop reaches it through an SSH port forward.'],
        ['What happens when my laptop disconnects?', 'The agents on the machine keep running. wisp reconnects on its own when your laptop is back, and finished reports and pending questions are waiting in the queue.'],
        ['Can I answer an agent’s question from my phone?', 'Yes. Questions and finished tasks from every machine go to ntfy or Telegram, and you can answer from there.'],
      ],
      related: ['move-a-task-to-another-machine-or-agent', 'run-coding-agents-in-the-background', 'multi-agent-coding'],
    },

    {
      slug: 'move-a-task-to-another-machine-or-agent',
      title: 'Move a Claude Code or Codex task to another machine or agent — wisp',
      h1: 'Move a task to another machine or agent, mid-way',
      card: 'Laptop to dev box, Claude Code to Codex: one follow-up, work and history included.',
      description: 'Continue a Claude Code or Codex task on another computer, or hand it to another agent, without losing work: the branch, uncommitted changes and earlier turns move with your next follow-up.',
      lede: 'To carry a coding-agent task over to another computer, the new place needs the branch, the uncommitted changes and what happened so far. In wisp, the <b>Runs on</b> button next to the follow-up box moves all three with your next message: the work travels as a git bundle into a worktree on the same branch, and the agent there gets the earlier turns. The same follow-up can switch from Claude Code to Codex.',
      demo: 'relay',
      body: `
    <section>
      <h2 id="why">When you’d move a task</h2>
      <ul class="doc-list">
        <li><b>The laptop has to go.</b> The battery is low, or you’re about to close it. Move the task to a desktop or a VM and it keeps working.</li>
        <li><b>The job got bigger.</b> The full test suite, a Docker build or a GPU needs a bigger box than the one it started on.</li>
        <li><b>The agent is stuck or out of quota.</b> Claude Code hit its usage limit or keeps going in circles. Hand the next step to Codex, or the other way round.</li>
        <li><b>A second opinion.</b> Have another model review or finish what the first one started, in the same branch.</li>
      </ul>
    </section>

    <section>
      <h2 id="manual">Doing it by hand</h2>
      <p>Git can carry the work. The agent’s conversation can’t: it stays in the first CLI’s session files on the first computer.</p>
      ${sh(`# on the laptop: commit what's there, bundle the branch, copy it over
git add -A && git commit -m "wip: stripe v2"
git bundle create /tmp/work.bundle origin/main..HEAD
scp /tmp/work.bundle devbox:/tmp/

# on the dev box: a worktree on the same branch
cd ~/code/app && git fetch /tmp/work.bundle HEAD:stripe-v2
git worktree add ../app-stripe stripe-v2
cd ../app-stripe && codex   # starts with no idea what happened so far`)}
      <p>Then you explain the task again: what was asked, what the first agent did, what’s left. And the WIP commit is now part of your branch.</p>
    </section>

    <section>
      <h2 id="with-wisp">With wisp: one follow-up</h2>
      <ol class="doc-steps">
        <li><b>Connect the other computer</b> once, under <b>Machines</b>. It needs SSH with a key, Node.js 20+ and the agent CLIs, signed in. See <a href="/guides/run-coding-agents-on-multiple-machines.html">agents on multiple machines</a>.</li>
        <li><b>Click the Runs on button</b> (the laptop icon next to the follow-up box) and pick the machine. To switch agents too, use the harness button beside it and pick Codex, opencode or another model.</li>
        <li><b>Type the follow-up and press Enter.</b> A running task has to stop or finish first.</li>
      </ol>
      <p>Then wisp:</p>
      <ol class="doc-list">
        <li>packs the task’s branch and its uncommitted and untracked changes into a git bundle (your own checkout and index are left alone);</li>
        <li>carries it to the other computer, which reuses its checkout of the project or clones the repo’s <code>origin</code>;</li>
        <li>unpacks it into a worktree there, on the same branch, with the uncommitted changes still uncommitted;</li>
        <li>starts the agent on your follow-up, with the earlier turns written out ahead of it: each request, the report it got and the files that were edited;</li>
        <li>archives the old card with a <b>Continues on devbox</b> link. The new card shows <b>From MacBook</b> and tags each earlier turn with where it ran.</li>
      </ol>
      <p><b>Rerun</b> has the same picker, for starting the task over somewhere else instead.</p>
    </section>

    <section>
      <h2 id="switch-agent">Switch agent without moving</h2>
      <p>The harness button in the follow-up box works on its own too. What the next agent knows depends on what you switch:</p>
      <div class="table"><table>
        <thead><tr><th>You switch</th><th>Conversation</th><th>What it’s told</th></tr></thead>
        <tbody>
          <tr><td>Model or thinking level</td><td>Same conversation, resumed</td><td>Nothing extra: it was there</td></tr>
          <tr><td>Harness (Claude Code → Codex)</td><td>Codex starts its own, in the same folder</td><td>Every turn it didn’t see, newest first, up to about 24k characters</td></tr>
          <tr><td>Back to the first harness</td><td>Its own session, resumed</td><td>Only what happened while it was away</td></tr>
          <tr><td>Computer</td><td>A new session on that computer</td><td>Every earlier turn, tagged with where it ran</td></tr>
        </tbody>
      </table></div>
      <p>Each turn’s badge shows the harness that ran it, so the card reads as one story across agents and computers.</p>
    </section>

    <section>
      <h2 id="api">From the CLI and API</h2>
      ${sh(`# switch agent and model on the next follow-up
wisp reply <id> "finish the other call sites" --agent codex

# move the task too: machine is a machine's id, "" for this computer
curl -X POST localhost:4477/api/sessions/<id>/reply \\
  -H 'content-type: application/json' \\
  -d '{"text":"finish the other call sites","machine":"devbox","agent":"codex"}'`)}
      <p>The MCP tool <code>wisp_reply</code> takes <code>agent</code>, <code>model</code> and <code>effort</code> as well. See <a href="/integrations.html">integrations</a>.</p>
    </section>
`,
      faq: [
        ['Can I move a task while the agent is running?', 'No. Stop it or let it finish first, so there is a settled state to pack. Then send the follow-up with another computer picked.'],
        ['Does the agent on the other computer remember the conversation?', 'Its CLI starts a new session there, since the old one stays on the first computer. wisp writes the earlier turns into the follow-up: each request, the report and the files edited, newest first. The code itself is already in the worktree.'],
        ['What if the other machine doesn’t have the project?', 'wisp reuses a clone of the same repo if it finds one there, or clones the project’s origin first. A repo without a remote can’t be cloned this way; add its folder on that machine instead.'],
        ['Can I move it back?', 'Yes. Use the same button on the new card and pick this computer. The work and history come back the same way.'],
      ],
      related: ['run-coding-agents-on-multiple-machines', 'claude-code-vs-codex', 'run-coding-agents-in-the-background'],
    },

    {
      slug: 'run-multiple-claude-code-agents-in-parallel',
      title: 'How to run multiple Claude Code agents in parallel — wisp',
      h1: 'Run multiple Claude Code agents in parallel',
      card: 'Several Claude Code sessions on one repo, a git worktree each, one queue.',
      description: 'Run several Claude Code sessions at once on one repo without them colliding: a git worktree and branch per task, headless runs, questions routed to you, and one queue that shows which needs you.',
      lede: 'Run several Claude Code sessions at once by giving each one its own git worktree, so they never edit the same files on disk. wisp makes a worktree and branch per task from <code>origin/main</code>, runs <code>claude</code> headless in each, and puts every run in one queue that tells you which one needs you.',
      shot: ['app', 'The wisp queue: several Claude Code tasks sorted into Needs you, Working and Done'],
      body: `
    <section>
      <h2 id="why-worktrees">Why not just open more terminals?</h2>
      <p>Two Claude Code sessions in the same folder share one working tree. One overwrites the other’s edits, both fight over the git index, and the tests one runs see the other’s half-finished code. Separate <a href="https://git-scm.com/docs/git-worktree" target="_blank" rel="noopener">git worktrees</a> fix that: each session gets its own checkout and branch, and they share only the repository’s history.</p>
    </section>

    <section>
      <h2 id="manual">The manual way</h2>
      ${sh(`git worktree add ../app-auth   -b fix/auth   origin/main
git worktree add ../app-stripe -b feat/stripe origin/main

# one terminal (or tmux pane) each
cd ../app-auth   && claude
cd ../app-stripe && claude

# when a branch is merged
git worktree remove ../app-auth`)}
      <p>Things to know: dependencies aren’t shared, so each worktree needs its own install, and two dev servers on the same port collide. And you have to keep checking each terminal to see which session is waiting for you.</p>
    </section>

    <section>
      <h2 id="with-wisp">With wisp</h2>
      <ol class="doc-steps">
        <li><b>Start wisp</b> in your repo. ${installButton()}</li>
        <li><b>Launch tasks back to back.</b> Press <kbd>N</kbd>, describe the task, press Enter, and the next one. Each runs in its own worktree under <code>~/.wisp/worktrees/</code> on a branch named <code>wisp/&lt;task&gt;-&lt;id&gt;</code>.</li>
        <li><b>Watch one queue, not five terminals.</b> Cards sort into <em>Needs you</em>, <em>Working</em> with a live one-line status, and <em>Done</em>. When Claude Code needs a decision it asks through an MCP tool, the card moves to Needs you, and your answer goes straight back into the running session. In Edits mode its permission prompts come to you as <b>Allow</b>, <b>Always allow in this task</b> and <b>Deny</b>.</li>
        <li><b>Read the report, ship it.</b> Each finished run hands back a headline, the real diff, the test run and next steps. <b>Ship it</b> commits, pushes and opens the PR; <b>Merge</b> squash-merges and syncs your local main.</li>
      </ol>
      <p>Press <kbd>T</kbd> on any card to continue that session yourself: your terminal opens in its worktree with <code>${h.esc(claude.resume)}</code>.</p>
    </section>

    <section>
      <h2 id="how-many">How many at once?</h2>
      <p>The limits are your Claude plan’s usage limits and your machine. When Claude Code says it’s at its limit, wisp’s <b>Auto</b> harness rests it until the limit resets and moves the next tasks to another agent you have, like <a href="/agents/codex.html">Codex</a>. For more CPU, <a href="/guides/run-coding-agents-on-multiple-machines.html">run some of the sessions on another machine</a>.</p>
    </section>
`,
      faq: [
        ['Does this use my Claude Pro or Max subscription?', 'wisp runs the claude CLI you are signed in with, so it uses whatever that CLI uses: your subscription or an API key.'],
        ['Do parallel sessions share context?', 'No. Each is its own Claude Code session. To have one session hand work to others, use subagents: the lead gets a delegate tool and the members run in parallel.'],
        ['Are my uncommitted changes carried into the worktrees?', 'No. Each worktree starts from origin/main (fetched first). Commit or push what the agents should see, or turn worktrees off for a task to edit your folder in place.'],
      ],
      related: ['run-claude-code-and-codex-in-parallel', 'run-coding-agents-in-the-background', 'run-coding-agents-on-multiple-machines'],
    },

    {
      slug: 'claude-code-vs-codex',
      title: 'Claude Code vs Codex: compare them on your own code — wisp',
      h1: 'Claude Code vs Codex, on your own repo',
      card: 'Run the same task on both and compare tests, time, cost and the diff.',
      description: 'Claude Code or OpenAI Codex? Run the same task on both, each on its own branch, and compare tests, time, cost and the diff. How the two CLIs differ, and how to let your own results pick.',
      lede: 'Benchmarks can’t tell you which agent is better on your codebase. The fastest honest answer is to give Claude Code and Codex the same task, each on its own branch, and compare the tests, the time, the cost and the diff. wisp does that with one click, then keeps the run you pick.',
      shot: ['compare', 'Claude Code and Codex side by side in wisp’s Compare view: time, cost, tests and Keep this', 'story-'],
      body: `
    <section>
      <h2 id="differences">How the two CLIs differ</h2>
      <p>Both are terminal agents that read your repo, edit files and run commands. What differs, as wisp drives them:</p>
      <div class="table"><table>
        <thead><tr><th></th><th><a href="/agents/claude-code.html">Claude Code</a></th><th><a href="/agents/codex.html">Codex</a></th></tr></thead>
        <tbody>
          <tr><th scope="row">From</th><td>${claude.vendor}</td><td>${codex.vendor}</td></tr>
          <tr><th scope="row">CLI</th><td><code>${claude.bin}</code></td><td><code>${codex.bin}</code></td></tr>
          <tr><th scope="row">Headless</th><td><code>claude -p</code></td><td><code>codex exec</code></td></tr>
          <tr><th scope="row">Read-only</th><td><code>${h.esc(claude.modes.plan)}</code></td><td><code>${h.esc(codex.modes.plan)}</code></td></tr>
          <tr><th scope="row">Edit, ask for the rest</th><td><code>${h.esc(claude.modes.edits)}</code></td><td><code>${h.esc(codex.modes.edits)}</code></td></tr>
          <tr><th scope="row">No prompts</th><td><code>${h.esc(claude.modes.auto)}</code></td><td><code>${h.esc(codex.modes.auto)}</code></td></tr>
          <tr><th scope="row">Permission prompts</th><td>Per call: allow, always, deny</td><td>A sandbox decides; no per-call prompt</td></tr>
          <tr><th scope="row">Reports cost</th><td>Yes</td><td>Tokens only</td></tr>
          <tr><th scope="row">Resume</th><td><code>${h.esc(claude.resume)}</code></td><td><code>${h.esc(codex.resume)}</code></td></tr>
        </tbody>
      </table></div>
      <p>Models change every few months, so a verdict on which one writes better code goes stale fast. Your repo, your tests and your review time are the benchmark that matters.</p>
    </section>

    <section>
      <h2 id="what-to-compare">What to compare</h2>
      <ul class="doc-list">
        <li><b>Do the tests pass?</b> The project’s own suite, not the agent’s claim.</li>
        <li><b>The diff.</b> How many files it touched, and whether you’d merge it without rewriting half.</li>
        <li><b>Time and cost.</b> Wall-clock time for both; dollars where the CLI reports them.</li>
        <li><b>How much it needed you.</b> Questions asked, and follow-ups before it was right.</li>
      </ul>
    </section>

    <section>
      <h2 id="run-the-comparison">Run the comparison</h2>
      <p>In the wisp launcher pick Claude Code, click <b>vs</b>, pick Codex and press Enter. Or from a terminal:</p>
      ${sh('wisp "add rate limiting to /login" --agent claude --compare codex')}
      <p>Each run gets its own worktree. <b>Compare</b> shows them side by side with both reports, and <b>Keep this</b> keeps the better branch and deletes the other. The <a href="/guides/run-claude-code-and-codex-in-parallel.html">parallel guide</a> also shows how to do this by hand with <code>git worktree</code>.</p>
    </section>

    <section>
      <h2 id="let-results-pick">Let your results pick</h2>
      <p>One comparison is one data point. wisp’s <b>Auto</b> harness keeps score for you: for each kind of task (bug, feature, UI, tests, refactor, docs) it tracks how often each agent, model and thinking level worked, counting merged PRs, 👍 and 👎, rollbacks and the follow-ups you needed. Then it picks per task, now and then trying the other option so the estimate stays honest. <b>Settings → Auto</b> shows what it learned.</p>
      <p>You don’t have to choose one at all: <a href="/guides/multi-agent-coding.html">a Claude Code lead can hand work to Codex</a>.</p>
    </section>
`,
      faq: [
        ['Is Claude Code or Codex better?', 'It depends on the task, the repo and the current models. Run the same task on both, each on its own branch, and compare whether the tests pass, the diff, the time and the cost. wisp’s Compare view does that side by side.'],
        ['Can I use Claude Code and Codex together?', 'Yes. Run different tasks on each at the same time, run the same task on both and keep the better result, or let a Claude Code lead delegate parts of a task to Codex subagents.'],
        ['Can I compare Cursor, opencode, Antigravity or Grok too?', 'Yes. wisp runs Claude Code, Codex, Cursor CLI, opencode, Antigravity CLI and Grok Build, and --compare takes any of them.'],
      ],
      related: ['run-claude-code-and-codex-in-parallel', 'multi-agent-coding', 'run-multiple-claude-code-agents-in-parallel'],
    },

    {
      slug: 'multi-agent-coding',
      title: 'Multi-agent coding: Claude Code delegating to Codex and more — wisp',
      h1: 'Multi-agent coding across Claude Code, Codex and more',
      card: 'A lead agent with a team on other harnesses, working in parallel.',
      description: 'Orchestrate several coding agents at once: parallel tasks, the same task on two agents, a Claude Code lead delegating to Codex subagents, and runs spread over several machines. Open source.',
      lede: 'In wisp, one lead agent can run a team of coding agents on other harnesses: Claude Code plans the change and hands the tests to three Codex copies, which work in parallel. The lead gets a <code>delegate</code> tool over MCP, and every member’s edits land in its worktree, its diff and its pull request.',
      shot: ['picker', 'The wisp launcher’s harness and model picker, where a lead and its team are chosen'],
      body: `
    <section>
      <h2 id="four-ways">Four ways to run agents together</h2>
      <div class="table"><table>
        <thead><tr><th>Pattern</th><th>When</th><th>In wisp</th></tr></thead>
        <tbody>
          <tr><th scope="row">Parallel tasks</th><td>Independent tasks, one per agent</td><td>Launch them back to back; a worktree each. <a href="/guides/run-multiple-claude-code-agents-in-parallel.html">Guide</a></td></tr>
          <tr><th scope="row">Compare</th><td>One task, the best of several attempts</td><td><b>vs</b> in the launcher, <code>--compare</code>. <a href="/guides/run-claude-code-and-codex-in-parallel.html">Guide</a></td></tr>
          <tr><th scope="row">Subagents</th><td>One big task, split by a lead</td><td><b>Subagents</b> in the launcher (below)</td></tr>
          <tr><th scope="row">Machines</th><td>More agents than one computer handles</td><td><b>Run on</b> in the launcher. <a href="/guides/run-coding-agents-on-multiple-machines.html">Guide</a></td></tr>
        </tbody>
      </table></div>
      <p>They combine: a lead with a team, running on a dev box, compared against a second lead.</p>
    </section>

    <section>
      <h2 id="team">Give the lead a team</h2>
      <p>The launcher’s <b>Subagents</b> button sets up a team of up to 6 members. Each has a harness, a model and thinking level, a name, a <b>Use for</b> note that tells the lead when to pick it, and a copies count:</p>
      <div class="table"><table>
        <thead><tr><th>Member</th><th>Harness</th><th>Use for</th></tr></thead>
        <tbody>
          <tr><td>lead</td><td>Claude Code</td><td>Plans the change, reviews, ships</td></tr>
          <tr><td><code>codex#1</code>…<code>codex#3</code></td><td>Codex ×3</td><td>Writing and fixing tests, one module each</td></tr>
          <tr><td><code>docs</code></td><td>opencode, a cheap model</td><td>README and changelog</td></tr>
        </tbody>
      </table></div>
      <p>Claude Code, Codex, opencode and Grok Build can lead; Cursor CLI and Antigravity CLI can be members too. <b>Save as preset</b> keeps a team for later.</p>
    </section>

    <section>
      <h2 id="delegation">How delegation works</h2>
      <ul class="doc-list">
        <li>The lead gets a <code>delegate</code> tool on wisp’s MCP server. Tasks it sends in one call run in parallel, in the lead’s folder.</li>
        <li>Delegating to the same member again resumes that member’s conversation, so it keeps its context.</li>
        <li>Members’ edits count as the lead’s: they show up in its diff, its checkpoints and rollback, and its pull request.</li>
        <li>The call returns each member’s report and the files it changed, and wisp shows those reports next to the lead’s. Members don’t ask you questions; they make the call and note the assumption, and the lead decides.</li>
      </ul>
      <p>From the API, pass <code>subagents</code> or a saved <code>preset</code> to <code>POST /sessions</code>. See <a href="/integrations.html">integrations</a>.</p>
    </section>

    <section>
      <h2 id="from-another-agent">Orchestrate from the agent you already use</h2>
      <p>wisp ships an MCP server. Add <code>wisp mcp</code> to Claude Code, Codex, Cursor or opencode, and the agent in your editor can launch tasks into wisp’s queue (<code>wisp_launch</code>), wait for them (<code>wisp_wait</code>) and read the reports back, on any harness and any machine.</p>
      ${sh(`claude mcp add wisp -- npx -y wisp-agents mcp
# or install the agent skill
npx wisp-agents skill install --agent all`)}
    </section>
`,
      faq: [
        ['Do subagents work in the same worktree?', 'Yes. Members work in the lead’s folder, so their edits are part of one branch, one diff and one pull request. Separate tasks get separate worktrees.'],
        ['Can the team run on another machine?', 'Yes. When a task runs on a machine, the lead and its team run there, with the harnesses that machine has.'],
        ['Which agents can lead?', 'Claude Code, Codex, opencode and Grok Build can lead a team. Cursor CLI and Antigravity CLI can be members.'],
      ],
      related: ['run-claude-code-and-codex-in-parallel', 'run-coding-agents-on-multiple-machines', 'claude-code-vs-codex'],
    },

    {
      slug: 'run-coding-agents-in-the-background',
      title: 'Run Claude Code and Codex in the background, headless — wisp',
      h1: 'Run coding agents in the background',
      card: 'Headless runs that can still ask you, notify you, and report back in one screen.',
      description: 'Run Claude Code, Codex and other coding agents headless in the background: questions mid-run, notifications on desktop and phone, schedules and CI triggers, and a one-screen report instead of a transcript.',
      lede: 'Headless coding agents (<code>claude -p</code>, <code>codex exec</code>) can work without you, but they can’t ask a question, nothing tells you when they finish, and what they leave is a long transcript. wisp runs them in the background with a way to ask you mid-run, notifications on your desktop and phone, and a one-screen report when each one is done.',
      shot: ['report', 'A wisp report for a finished background task: headline, numbers, the real diff and the test run'],
      body: `
    <section>
      <h2 id="headless-gaps">What plain headless runs miss</h2>
      <div class="table"><table>
        <thead><tr><th>When the agent…</th><th>Plain <code>-p</code> / <code>exec</code></th><th>With wisp</th></tr></thead>
        <tbody>
          <tr><td>needs a decision</td><td>guesses, or stops</td><td>asks through an <code>ask_user</code> tool; the run pauses and you get a notification</td></tr>
          <tr><td>hits a permission prompt</td><td>the call fails</td><td><b>Allow</b> / <b>Deny</b> on the card, or <b>Allow &amp; retry</b></td></tr>
          <tr><td>finishes</td><td>you check the terminal</td><td>desktop and phone notification</td></tr>
          <tr><td>reports back</td><td>thousands of lines of log</td><td>a headline, the real diff, the tests, next steps</td></tr>
          <tr><td>edits files</td><td>in your checkout</td><td>in its own worktree, with a checkpoint per turn</td></tr>
        </tbody>
      </table></div>
    </section>

    <section>
      <h2 id="start">Start one</h2>
      ${sh(`npx wisp-agents "fix the flaky auth test"            # this folder, the agent you last picked
npx wisp-agents --agent codex --mode plan "audit deps" # read-only
wisp "bump node to 22" --wait --json                   # block until done, for scripts`)}
      <p>Or open the app with <code>npx wisp-agents</code> and use the launcher. Pick a permission mode per task: <b>Plan</b> (read-only), <b>Edits</b> (file edits allowed, the rest asks you) or <b>Full auto</b>.</p>
    </section>

    <section>
      <h2 id="away">While you’re away</h2>
      <ul class="doc-list">
        <li><b>Phone.</b> Questions and finished tasks go to ntfy or Telegram. Tap an option to answer, or start a task from Telegram with <code>/new</code>.</li>
        <li><b>Ask without interrupting.</b> <code>/btw did you update the docs too?</code> gets an answer from a copy of the conversation while the run keeps going.</li>
        <li><b>Keep it running.</b> Run tasks on a desktop or VM so they don’t stop when the laptop sleeps: <a href="/guides/run-coding-agents-on-multiple-machines.html">agents on other machines</a>.</li>
      </ul>
    </section>

    <section>
      <h2 id="triggers">On a schedule, or when CI fails</h2>
      <p><b>Recipes</b> are saved prompts with <code>{params}</code> (<code>wisp run release 0.26.0</code>). <b>Triggers</b> start them on their own while wisp is open:</p>
      <div class="table"><table>
        <thead><tr><th>Trigger</th><th>Fires when</th></tr></thead>
        <tbody>
          <tr><td>Schedule</td><td>a cron expression matches, e.g. <code>0 9 * * 1-5</code></td></tr>
          <tr><td>CI failed</td><td>a GitHub Actions run fails, optionally on one branch</td></tr>
          <tr><td>Issue labelled</td><td>an open issue carries a label</td></tr>
        </tbody>
      </table></div>
      <p>GitHub triggers poll with your <code>gh</code> login, so nothing has to reach your machine. Issue triggers start in Plan mode, since anyone who can open an issue writes that prompt.</p>
      <p>Scripts and CI can use the CLI with <code>--json</code>, the JS SDK, the HTTP API or webhooks. See <a href="/integrations.html">integrations</a>.</p>
    </section>
`,
      faq: [
        ['Is Full auto safe?', 'Each task runs in its own git worktree, so your checkout is untouched, and every turn is checkpointed so you can roll back. For anything you are unsure about, use Plan (read-only) or Edits, where anything else the agent wants to run comes to you first.'],
        ['Can I watch what it is doing?', 'Yes. A working card shows a live one-line status, the full transcript is one click (or V) away, and T opens the session in your own terminal.'],
        ['Does it need to stay open?', 'wisp runs the agents, so it has to be running somewhere. Run it on a desktop or a VM through Machines and your laptop can sleep.'],
      ],
      related: ['run-coding-agents-on-multiple-machines', 'run-multiple-claude-code-agents-in-parallel', 'multi-agent-coding'],
    },

    {
      slug: 'customize-wisp-with-spells',
      title: 'Add buttons, panels and blocks to wisp by asking — spells',
      h1: 'Change wisp itself, by asking: spells',
      card: 'A floating button for your PRs, a stats panel, a block for agents: ask, try it, keep it.',
      description: 'Add a button that opens all your PRs, a panel with your agent tool stats, a block agents can use in reports, or a new look, by asking wisp. Try each change live, keep it, share it.',
      lede: 'In wisp you change the app itself by asking: “a floating button that opens all my PRs”, “a panel with my tool stats”, “a deploy block for agents”, “compact cards”. An agent writes the change as a <b>spell</b>, a small JSON file wisp layers over itself. You try it in the window, keep it, and share it as a file.',
      demo: 'spells',
      body: `
    <p class="muted">Above: a working copy. Pick an ask and the little wisp window changes the way the app does; switch a spell off and it changes back. <code>{ }</code> shows the spell file.</p>

    <nav class="toc" aria-label="On this page"><p class="eyebrow">On this page</p><ul>
      <li><a href="#cast">Cast one</a></li>
      <li><a href="#what">What a spell can change</a></li>
      <li><a href="#anatomy">What’s in a spell file</a></li>
      <li><a href="#places">Where things can go</a></li>
      <li><a href="#actions">What buttons can do</a></li>
      <li><a href="#data">Data and scripts</a></li>
      <li><a href="#agents">Blocks, prompt rules and hooks</a></li>
      <li><a href="#safe">Why it’s safe to keep one</a></li>
      <li><a href="#share">Share it with your team</a></li>
      <li><a href="#cli">From the terminal</a></li>
      <li><a href="#trouble">When something looks wrong</a></li>
    </ul></nav>

    <section>
      <h2 id="cast">Cast one</h2>
      <ol class="doc-steps">
        <li><b>Start wisp.</b> ${installButton()}</li>
        <li><b>Say what to change.</b> ⌘K → <i>Cast a spell…</i>, Settings → Spells, or type <code>/spell</code> in the prompt box: <code>/spell a floating button that opens all my open PRs, with how many there are</code>. Be as specific as you like about where it goes and what it shows.</li>
        <li><b>Look at the preview.</b> The agent works in an empty folder of its own: it reads wisp’s spell reference, samples your real data, checks the spell with wisp until it passes, and hands it back as a card. The card shows its buttons as they will look, its panels drawn with your data, and a plain-words list of what it adds.</li>
        <li><b>Try it, then keep it.</b> <b>Try it</b> applies the spell to this window only; <b>Undo</b> takes it back. <b>Turn on</b> keeps it. A follow-up on the card changes it (“make it a top bar button”, “only for api-server”), and “remove the … spell” drops it.</li>
      </ol>
      ${shot('spell', 'A Cast a spell report in wisp: the Task board spell with what it adds, a preview of its floating button and its panel drawn with real data, and Turn on, Try it, JSON and Copy buttons')}
      <p>Every spell you have is in Settings → Spells, with a switch, its reach, and export, copy and remove.</p>
    </section>

    <section>
      <h2 id="what">What a spell can change</h2>
      <div class="table"><table>
        <thead><tr><th>Ask for</th><th>What wisp does</th></tr></thead>
        <tbody>
          <tr><td>A floating button that opens all my PRs</td><td>A button in a corner with a live count, from a read-only <code>gh search prs</code> wisp runs; one click opens them all</td></tr>
          <tr><td>My wisp tool stats</td><td>A top bar button that opens a dialog of stats and charts from <code>/usage/tools</code></td></tr>
          <tr><td>A deploy block for agents</td><td>A new block type agents are told about and can end their reports with</td></tr>
          <tr><td>Quick replies, a second opinion</td><td>Chips above the follow-up box, a <i>Second opinion</i> button that reruns the task on Codex in Plan mode</td></tr>
          <tr><td>Compact cards, PR first, Open PR on hover</td><td>Restyles and reorders the card head, adds a hover button on cards that have a PR</td></tr>
          <tr><td>A bigger, monospace prompt box</td><td>Placeholder, rows and font of the prompt box; hides the parts you don’t use</td></tr>
          <tr><td>A violet wisp</td><td>Sets design tokens (<code>--accent</code>, <code>--radius</code>, …), with separate values for dark mode</td></tr>
          <tr><td>A /explain command</td><td>A slash command for the follow-up box that sends a prompt with what you typed after it</td></tr>
          <tr><td>Send failing tests back once</td><td>A hook: when a turn ends with failing tests, wisp replies to the agent, once per task</td></tr>
          <tr><td>Codex always runs the linter first</td><td>A rule added to Codex agents’ prompts</td></tr>
        </tbody>
      </table></div>
    </section>

    <section>
      <h2 id="anatomy">What’s in a spell file</h2>
      <p>A spell is one JSON object. Only <code>wispSpell</code>, <code>id</code> and <code>name</code> are required; everything else is a list of things to add or change. This is the whole <i>My PRs</i> spell:</p>
      ${json(spellOf('my-prs'))}
      <ul class="doc-list">
        <li><b><code>id</code>, <code>version</code></b>: the file is <code>~/.wisp/spells/&lt;id&gt;.json</code>. A changed spell keeps its id and bumps its version, so installing it again updates it in place.</li>
        <li><b><code>data</code></b>: named sources wisp fetches for the spell. Here <code>prs</code> is a read-only <code>gh</code> command, refreshed every 120 seconds.</li>
        <li><b><code>buttons</code></b>: each names a <a href="#places">slot</a>, a label, an icon, an optional badge (here: how many items <code>prs</code> has) and what it <a href="#actions">does</a>.</li>
      </ul>
      <p>The other top-level fields:</p>
      <div class="table"><table>
        <thead><tr><th>Field</th><th>What it holds</th></tr></thead>
        <tbody>${FIELDS.map(([f, d]) => `<tr><td><code>${f}</code></td><td>${d}</td></tr>`).join('')}</tbody>
      </table></div>
      <p>Text, labels, links and <code>gh</code> arguments can use <code>{field}</code> templates filled from the card’s task: <code>{title}</code>, <code>{branch}</code>, <code>{project}</code>, <code>{agent}</code>, <code>{pr.number}</code>, <code>{pr.url}</code> and more. In slash commands, <code>{args}</code> is what you typed after the command.</p>
    </section>

    <section>
      <h2 id="places">Where things can go</h2>
      <p>Spells never touch wisp’s page directly. They name a slot, and wisp puts the button, chip or panel there with its own markup, so wisp updates don’t break them.</p>
      <div class="table"><table>
        <thead><tr><th>Slot</th><th>Where</th></tr></thead>
        <tbody>${Object.entries(SLOTS).map(([k, d]) => `<tr><td><code>${k}</code></td><td>${esc(d)}</td></tr>`).join('')}</tbody>
      </table></div>
      <p>Panels open as a <code>dialog</code>, a side <code>drawer</code>, pinned above the <code>feed</code>, or inside an open <code>card</code>. To restyle or hide something, a spell names a part (<code>card.title</code>, <code>launcher.input</code>, <code>topbar.machines</code>, …) and sets a short list of allowed CSS properties, props such as <code>density</code> or <code>monospace</code>, or the order of the card head.</p>
      <p>The split view (tasks in a sidebar, the open one beside it) is a spell’s too: <code>settings: { "view": "split" }</code> switches to it, the <code>sidebar</code> part takes <code>width</code>, <code>side</code> (<code>left</code>, the default, or <code>right</code>) and <code>details</code> (<code>full</code> shows the model, machine and project on every row), <code>split.main</code> takes a <code>readWidth</code>, <code>split.home</code> a <code>greeting</code> over the prompt box, and the <code>sidebar.top</code> and <code>split.head</code> slots take buttons.</p>
    </section>

    <section>
      <h2 id="actions">What buttons can do</h2>
      <p>Each action has a reach, and a spell’s reach is the furthest of its actions. You see it before you turn the spell on.</p>
      <div class="table"><table>
        <thead><tr><th>Action</th><th>Reach</th><th>Does</th></tr></thead>
        <tbody>${Object.entries(ACTIONS).map(([k, a]) => `<tr><td><code>${k}</code></td><td>${REACH[a.kind]}</td><td>${esc(actionText(a.doc))}</td></tr>`).join('')}</tbody>
      </table></div>
    </section>

    <section>
      <h2 id="data">Data and scripts</h2>
      <p>A spell can read two kinds of data, and wisp fetches both; spell code never touches the network.</p>
      <ul class="doc-list">
        <li><b>wisp’s own routes</b>, read-only: ${WISP_DATA.map((r) => `<code>${r}</code>`).join(', ')}.</li>
        <li><b>Read-only <code>gh</code> commands</b>: ${Object.entries(GH_READ).map(([c, subs]) => `<code>gh ${c}${subs ? ` ${subs.join('|')}` : ''}</code>`).join(', ')}. <code>gh api</code> may only read: no <code>-X</code>, <code>-f</code>, <code>-F</code> or <code>--input</code>.</li>
      </ul>
      <p>To draw a panel, a spell carries a <code>script</code>: plain JavaScript functions that get the data and return wisp’s report blocks (stats, charts, checklists, callouts, tables of files, …). wisp checks what comes back and draws it with its own renderer. This is the panel behind <i>Tool stats</i>:</p>
      ${json(spellOf('tool-stats'))}
    </section>

    <section>
      <h2 id="agents">Blocks, prompt rules and hooks</h2>
      <p>Spells also change what agents do, for every harness or only some (<code>harnesses</code>), and for every task or only some projects, agents or modes (<code>when</code>).</p>
      <ul class="doc-list">
        <li><b>Blocks.</b> A new report block type. wisp tells agents about it while the spell is on, and the spell’s script draws it. The <code>doc</code> line is what agents read.</li>
        <li><b>Prompt rules.</b> Lines added to agents’ system prompts: “Codex runs <code>npm run lint</code> before reporting”.</li>
        <li><b>Hooks.</b> On ${Object.keys(EVENTS).map((e) => `<code>${e}</code>`).join(', ')}, if ${HOOK_IF.map((e) => `<code>${e}</code>`).join(', ')} match, reply, mark done, archive, notify or call a webhook. <code>max</code> caps how often per task (default once).</li>
      </ul>
      ${json(spellOf('fix-failing-tests'))}
    </section>

    <section>
      <h2 id="safe">Why it’s safe to keep one</h2>
      <ul class="doc-list">
        <li><b>Spell code can’t reach anything.</b> It runs in a sandboxed frame with no network, no page and no wisp API. It gets the data wisp fetched and returns blocks, which wisp checks and draws itself.</li>
        <li><b>Data is read-only.</b> Spells read wisp’s own routes and read-only <code>gh</code> commands. They can’t merge, push or write.</li>
        <li><b>You see how far it reaches.</b> Each spell is <i>Safe</i>, <i>Acts for you</i>, <i>Reads GitHub</i> or <i>Runs commands</i>, with every command listed. A command asks you before its first run.</li>
        <li><b>Some things stay put.</b> Questions, approvals and Settings → Spells can’t be restyled or hidden, so a spell can’t lock you out of turning it off.</li>
        <li><b>Off means gone.</b> Turning a spell off puts wisp back exactly as it was. <code>WISP_SAFE=1</code> starts wisp with every spell off.</li>
      </ul>
    </section>

    <section>
      <h2 id="share">Share it with your team</h2>
      <p>Settings → Spells exports a spell as a <code>.spell.json</code> file, or copies its JSON for a chat. A colleague drops the file on wisp, pastes it (or a link) into Settings → Spells, or runs:</p>
      ${sh(`wisp spell install ./my-prs.spell.json --on
wisp spell install https://example.com/my-prs.spell.json
wisp spell install gist:<id>`)}
      <p>They see the same review first, and it stays off until they turn it on. Commit a team’s spells to a repo and everyone installs the same set.</p>
    </section>

    <section>
      <h2 id="cli">From the terminal</h2>
      <div class="table"><table>
        <thead><tr><th>Command</th><th>Does</th></tr></thead>
        <tbody>
          <tr><td><code>wisp spell</code></td><td>List your spells: <code>●</code> on, <code>○</code> off, and any that are broken</td></tr>
          <tr><td><code>wisp spell cast "…"</code></td><td>An agent writes a spell for it; keep it in the app. <code>--wait</code> blocks until it’s done; <code>--agent</code>, <code>--model</code>, <code>--effort</code> pick who writes it</td></tr>
          <tr><td><code>wisp spell install &lt;file|url&gt;</code></td><td>Check and add a spell (a file, an https link or <code>gist:&lt;id&gt;</code>). Off until you add <code>--on</code></td></tr>
          <tr><td><code>wisp spell on|off &lt;id&gt;</code></td><td>Turn one on or off; <code>wisp spell off --all</code> turns every spell off</td></tr>
          <tr><td><code>wisp spell rm &lt;id&gt;</code></td><td>Remove it</td></tr>
          <tr><td><code>wisp spell export &lt;id&gt;</code></td><td>Print the spell file, to save or send</td></tr>
        </tbody>
      </table></div>
      ${sh(`wisp spell cast "a /explain command that asks for a plain-words explanation" --wait
wisp spell export my-prs > my-prs.spell.json
wisp spell off --all`)}
      <p>Over HTTP the same lives under <code>/spells</code>; see <a href="/integrations.html">Integrations</a>.</p>
    </section>

    <section>
      <h2 id="trouble">When something looks wrong</h2>
      <ul class="doc-list">
        <li><b>wisp looks odd and you don’t know why.</b> Settings → Spells → <i>Turn every spell off</i>, then turn them back on one at a time. If wisp won’t even open properly, start it with <code>WISP_SAFE=1</code>.</li>
        <li><b>A spell is listed as broken.</b> <code>wisp spell</code> prints <code>! &lt;id&gt;: &lt;why&gt;</code>. Usually it names a slot, part or action this version of wisp doesn’t have; ask for a follow-up on its card, or remove it.</li>
        <li><b>A button doesn’t show.</b> Card buttons can have a <code>when</code> (only cards with a PR, only Codex tasks, …), and hidden parts take their buttons with them. Ask the agent which applies.</li>
        <li><b>The data is empty.</b> <code>gh</code> sources need the GitHub CLI installed and signed in (<code>gh auth status</code>) on the machine wisp runs on.</li>
      </ul>
    </section>
`,
      faq: [
        ['Do spells change wisp’s code?', 'No. A spell is a JSON file in ~/.wisp/spells that wisp reads at runtime. Your wisp install stays as it is, updates keep working, and turning a spell off removes everything it added.'],
        ['Which agents can cast spells?', 'Any harness wisp runs: Claude Code, Codex, opencode, Cursor, Antigravity or Grok. The agent works in an empty folder of its own and uses wisp’s spell tools to read the reference and check its spell.'],
        ['Can a spell I get from someone else run code on my computer?', 'Only if it says so: a spell whose buttons run commands is marked Runs commands and lists each command, and asks before the first run. Spell scripts run in a sandbox with no network or file access.'],
        ['Can I write a spell by hand?', 'Yes. Write the JSON, then run wisp spell install ./my.spell.json: wisp checks it the same way it checks a cast spell and tells you, in plain words, what it does or what is wrong.'],
        ['What if I ask for something spells can’t do?', 'The agent says so in its report and does the closest thing spells can. Spells can only use the slots, parts, actions and data sources in wisp’s reference, so they can’t reach further than that.'],
      ],
      related: ['run-coding-agents-in-the-background', 'multi-agent-coding', 'run-claude-code-and-codex-in-parallel'],
    },
  ];
}
