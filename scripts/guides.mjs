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
import { TEMPLATES } from '../web/js/crew-templates.js';

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
  ['panels', 'Dialogs, drawers and panels on home or inside a card, drawn by a script from the spell’s data'],
  ['parts', 'Restyle a named part of wisp, set its props (a monospace prompt box, compact cards) or reorder the card head'],
  ['ui', '<code>hide</code> named parts; <code>tokens</code> and <code>dark</code> recolour wisp'],
  ['blocks', 'New report block types agents can use'],
  ['prompt', 'Rules added to agents’ prompts, for all tasks or some'],
  ['settings', 'Settings that win over yours while the spell is on (shown as <i>Set by …</i> in Settings)'],
  ['slash', '<code>/commands</code> for the follow-up box'],
  ['commands', '⌘K items, optionally with a single-key shortcut'],
  ['hooks', 'Something wisp does on its own when a turn finishes, fails, starts or waits'],
  ['recipes', 'Saved prompts with <code>{params}</code>'],
  ['crew', 'Crew members the spell brings: a name, brief, schedule, mode and skills. They join paused, you pick their project, and the spell keeps them up to date (a change to what they do pauses them until you’ve seen it)'],
  ['harnesses, when', 'Which harnesses, projects, agents and modes its rules, blocks and hooks apply to'],
  ['script', 'JavaScript functions that turn data into blocks, strings or links, run in a sandbox. An <code>app</code> block makes it interactive: a small page of your own, sandboxed too, that can offer a follow-up to the task'],
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
      <p>Want to reach it from anywhere, or from your phone? With no SSH at all: <a href="/guides/reach-your-computer-from-your-phone.html">add it to wisp Cloud from its Machines →</a> Or over SSH: <a href="/guides/connect-machines-with-tailscale.html">Connect your machines with Tailscale →</a></p>
    </section>

    <section>
      <h2 id="one-prompt-several-machines">One prompt, several machines</h2>
      <p>In the launcher, <b>Run on</b> (next to the harness) picks where the prompt goes: this computer, any machine, or several at once. Enter launches on every place in parallel, and the runs land as one task with a row per machine.</p>
      <p>Every project runs on every machine. If a machine has no checkout yet, wisp reuses a clone of the same repo it finds there, or clones the project’s <code>origin</code> first.</p>
      <p>On the machine, everything works as it does locally: a worktree per task, real diffs, checkpoints and rollback, questions mid-run, delegates, compare and <b>Ship it</b>. <b>Take over</b> opens <code>ssh -t &lt;host&gt;</code> and resumes the agent in your terminal, and VS Code, Cursor or Windsurf open the worktree through Remote - SSH.</p>
    </section>

    <section>
      <h2 id="split-a-task">Split one task across machines</h2>
      <p>One big task can use several computers at once. In the launcher’s <b>Delegate</b> popover, give the lead a team and pick where each member runs: <i>With the lead</i>, this computer, or any machine, with the harness and model installed there. The lead stays where <b>Run on</b> puts it and hands parts of the work to the others:</p>
      <div class="table"><table>
        <thead><tr><th>Member</th><th>Runs on</th><th>Use for</th></tr></thead>
        <tbody>
          <tr><td>lead</td><td>Your laptop, Claude Code</td><td>Plans the change, reviews, ships</td></tr>
          <tr><td><code>tester</code></td><td>With the lead, Codex ×2</td><td>Writing and running tests</td></tr>
          <tr><td><code>heavy</code></td><td>The GPU box, Claude Code</td><td>The long refactor, the model code</td></tr>
        </tbody>
      </table></div>
      <p>A member on another machine gets a copy of the lead’s work there, uncommitted edits included, and its changes come back into the lead’s worktree when it finishes. <a href="/guides/multi-agent-coding.html#other-machines">How delegating to a machine works →</a></p>
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
      slug: 'connect-machines-with-tailscale',
      title: 'Reach your coding machines from anywhere with Tailscale and SSH — wisp',
      h1: 'Connect your machines with Tailscale',
      card: 'Laptop, desktop, server and phone on one private network: SSH in from anywhere, with no open ports.',
      description: 'Put your laptop, dev box and phone on Tailscale and turn on SSH. wisp installs the rest there, so you run Claude Code and Codex on it from anywhere, desktop or Android, without opening a port.',
      lede: 'To run coding agents on another computer from anywhere, put both devices on <a href="https://tailscale.com" target="_blank" rel="noopener">Tailscale</a>, and turn on SSH on the machine. wisp does the rest by the machine’s tailnet name, from your laptop or the wisp Android app: your password there once, then Node.js and wisp, and nothing is exposed to the internet. Settings → Machines → <b>This computer</b> checks each step for you.',
      // Two drawings of one diagram: side by side, and stacked for phones (docs/style.css swaps them).
      figure: `<figure class="doc-shot doc-diagram" aria-label="Your laptop and phone reach a machine over SSH inside your private tailnet; wisp on the machine stays on 127.0.0.1">
  <svg class="wide" viewBox="0 0 960 300" aria-hidden="true">
    <rect x="330" y="20" width="300" height="260" rx="22" class="zone"/>
    <text x="480" y="52" text-anchor="middle" class="sub">your tailnet · private, encrypted</text>
    <rect x="20" y="58" width="220" height="74" rx="14" class="box"/>
    <text x="130" y="91" text-anchor="middle" class="name">Laptop</text>
    <text x="130" y="115" text-anchor="middle" class="sub">wisp · Machines</text>
    <rect x="20" y="168" width="220" height="74" rx="14" class="box"/>
    <text x="130" y="201" text-anchor="middle" class="name">Phone</text>
    <text x="130" y="225" text-anchor="middle" class="sub">wisp Android app</text>
    <path d="M240 95 C 330 95, 360 150, 715 150 M240 205 C 330 205, 360 150, 715 150" class="link"/>
    <path d="M703 142 L717 150 L703 158" class="link"/>
    <text x="480" y="252" text-anchor="middle" class="cmd">ssh you@devbox</text>
    <rect x="720" y="58" width="220" height="184" rx="14" class="box"/>
    <text x="830" y="91" text-anchor="middle" class="name">devbox</text>
    <text x="830" y="135" text-anchor="middle" class="mono">sshd :22</text>
    <text x="830" y="168" text-anchor="middle" class="mono">wisp 127.0.0.1:4477</text>
    <text x="830" y="201" text-anchor="middle" class="sub">Claude Code · Codex · …</text>
  </svg>
  <svg class="tall" viewBox="0 0 340 470" aria-hidden="true">
    <rect x="10" y="10" width="150" height="74" rx="14" class="box"/>
    <text x="85" y="43" text-anchor="middle" class="name">Laptop</text>
    <text x="85" y="66" text-anchor="middle" class="sub">wisp</text>
    <rect x="180" y="10" width="150" height="74" rx="14" class="box"/>
    <text x="255" y="43" text-anchor="middle" class="name">Phone</text>
    <text x="255" y="66" text-anchor="middle" class="sub">wisp app</text>
    <rect x="30" y="112" width="280" height="150" rx="20" class="zone"/>
    <text x="170" y="140" text-anchor="middle" class="sub">your tailnet · private</text>
    <path d="M85 84 V 205 C 85 255, 170 250, 170 296 M255 84 V 205 C 255 255, 170 250, 170 296" class="link"/>
    <path d="M162 284 L170 298 L178 284" class="link"/>
    <text x="170" y="168" text-anchor="middle" class="cmd">ssh you@devbox</text>
    <rect x="60" y="300" width="220" height="160" rx="14" class="box"/>
    <text x="170" y="333" text-anchor="middle" class="name">devbox</text>
    <text x="170" y="371" text-anchor="middle" class="mono">sshd :22</text>
    <text x="170" y="402" text-anchor="middle" class="mono">wisp 127.0.0.1:4477</text>
    <text x="170" y="433" text-anchor="middle" class="sub">Claude Code · Codex</text>
  </svg>
</figure>`,
      body: `
    <section>
      <h2 id="why">Why Tailscale</h2>
      <ul class="doc-list">
        <li><b>Anywhere, no port forwarding.</b> Your devices find each other from home, the office, a café or mobile data. No router setup, no public IP, no port 22 open to the internet.</li>
        <li><b>Stable names.</b> Each device gets a name like <code>devbox.tail1234.ts.net</code> that keeps working when its IP changes. wisp lists your tailnet’s computers under <b>Found on this computer</b> in Machines.</li>
        <li><b>Free for personal use.</b> Laptop, desktop, servers and phone all fit on the free plan.</li>
      </ul>
      <p>Any other way to reach the machine over SSH works too: your LAN, a VPN, or a cloud VM with a public address.</p>
    </section>

    <section>
      <h2 id="machine">1. Get the machine ready</h2>
      <p>The machine is the computer the agents run on: a desktop, a home server, a Mac mini, a cloud VM. It runs macOS or Linux (on Windows, use WSL). If wisp is already installed there, open Settings → Machines: <b>This computer</b> shows which of these steps are done and gives the command for each one that isn’t.</p>
      <ol class="doc-steps">
        <li><b>Install Tailscale and sign in</b> from <a href="https://tailscale.com/download" target="_blank" rel="noopener">tailscale.com/download</a>. On Linux:
${sh(`curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up`)}</li>
        <li><b>Turn on SSH.</b> On macOS, System Settings → General → Sharing → <b>Remote Login</b>, or:
${sh('sudo systemsetup -setremotelogin on')}
        On Debian or Ubuntu:
${sh('sudo apt install -y openssh-server && sudo systemctl enable --now ssh')}
        On Fedora: <code>sudo dnf install openssh-server && sudo systemctl enable --now sshd</code>.</li>
        <li><b>That’s it.</b> wisp installs Node.js there by itself when it’s missing (into <code>~/.wisp/node</code>, no admin needed) and starts itself with <code>npx</code>. Once connected, pick a coding agent in wisp’s Settings → Agents: opencode installs in one click; Claude Code and Codex need their CLI signed in once.</li>
      </ol>
    </section>

    <section>
      <h2 id="laptop">2. Connect from your laptop</h2>
      <ol class="doc-steps">
        <li>Install Tailscale on the laptop and sign in with the same account.</li>
        <li>In wisp, open <b>Machines</b>. The machine is listed under <b>Computers wisp found</b> with its tailnet name: pick it and press <b>Add and connect</b>.</li>
        <li>The first time, wisp says <i>This computer isn’t allowed in yet</i>: type your password for the machine and press <b>Let me in</b>. wisp adds this computer’s SSH key there (making one if you have none) and never keeps the password. Prefer a terminal? <code>ssh-copy-id you@devbox</code> does the same.</li>
      </ol>
      <p>wisp then installs Node.js there if it’s missing, starts <code>npx -y wisp-agents</code> (or reuses the one already running) and forwards a local port to it. <a href="/guides/run-coding-agents-on-multiple-machines.html">What you can do once it’s connected →</a></p>
    </section>

    <section>
      <h2 id="phone">3. Connect from your phone</h2>
      <p>The wisp Android app (a prototype; build it from <code>mobile/</code> in the repo) opens wisp on your computers: tap one and you’re in its wisp, with every feature.</p>
      <ol class="doc-steps">
        <li>Install the Tailscale app on the phone and sign in.</li>
        <li>In wisp, tap <b>Add your computer</b>, type <code>you@devbox</code> and your password on it. The password is used once: the app adds its own key there and forgets it.</li>
        <li>Tap <b>Connect</b>. The card shows the same steps as on the desktop (Node.js and wisp get installed if they’re missing), then wisp opens.</li>
        <li><b>Computers</b> in wisp’s top bar brings you back to the list, to switch to another computer or add one.</li>
        <li>Allow notifications when asked. While the machine is connected, a finished task or a question shows up as an Android notification, even with the screen off; tap it to open the task.</li>
      </ol>
    </section>

    <section>
      <h2 id="tailscale-ssh">Optional: Tailscale SSH, no keys at all</h2>
      <p>On a Linux machine, <a href="https://tailscale.com/kb/1193/tailscale-ssh" target="_blank" rel="noopener">Tailscale SSH</a> lets the devices on your tailnet in by their Tailscale identity, so there are no keys to copy:</p>
      ${sh('sudo tailscale set --ssh')}
      <p>Your tailnet’s access rules decide who may connect. wisp on the laptop and the phone app both work with it. On macOS, use Remote Login: the Mac App Store build of Tailscale can’t run an SSH server.</p>
    </section>

    <section>
      <h2 id="safety">What is exposed</h2>
      <p>Only SSH, and only inside your tailnet. wisp on the machine listens on its own <code>127.0.0.1</code>, so the only way to reach it is through an SSH tunnel you opened yourself. There is no wisp account, relay or cloud in between.</p>
    </section>
`,
      faq: [
        ['Do I need Tailscale?', 'No. wisp needs SSH access to the machine. Tailscale makes that work from anywhere without opening ports, and a LAN, a VPN or a cloud VM with a public address work just as well. Or skip SSH: add the machine to wisp Cloud from its own Machines, and your other computers and phone reach it through the grid.'],
        ['Which machines can run agents?', 'macOS and Linux with SSH and Node.js 20+. On Windows, run wisp inside WSL. Phones and tablets connect to machines; they don’t run agents.'],
        ['How do I check that a machine is ready?', 'Install wisp there and open Settings → Machines. This computer checks the SSH server, Tailscale and authorized keys, and shows the address to connect with.'],
        ['Does the phone app need its own key?', 'Each machine uses one of the keys on the phone: one the app makes (it shows the authorized_keys command) or one you import. With Tailscale SSH on a Linux machine, no key is needed.'],
      ],
      related: ['run-coding-agents-on-multiple-machines', 'move-a-task-to-another-machine-or-agent', 'run-coding-agents-in-the-background'],
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
      <p>The limits are your Claude plan’s usage limits and your machine. When Claude Code says it’s at its limit, wisp’s <b>Auto</b> harness rests it until the limit resets and moves the next tasks to another agent you have, like <a href="/agents/codex.html">Codex</a>. Your work and personal plans each keep their own limits, and wisp doesn’t combine them; you <a href="/guides/use-work-and-personal-claude-code-accounts.html">pick which account each task runs on</a>. For more CPU, <a href="/guides/run-coding-agents-on-multiple-machines.html">run some of the sessions on another machine</a>.</p>
    </section>
`,
      faq: [
        ['Does this use my Claude Pro or Max subscription?', 'wisp runs the claude CLI you are signed in with, so it uses whatever that CLI uses: your subscription or an API key.'],
        ['Do parallel sessions share context?', 'No. Each is its own Claude Code session. To have one session hand work to others, use Delegate in the launcher: the lead gets a delegate tool and the members run in parallel, here or on your other machines.'],
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
        ['Can I use Claude Code and Codex together?', 'Yes. Run different tasks on each at the same time, run the same task on both and keep the better result, or let a Claude Code lead delegate parts of a task to Codex with the launcher’s Delegate button.'],
        ['Can I compare Cursor, opencode, Antigravity, Grok or Copilot too?', 'Yes. wisp runs Claude Code, Codex, Cursor CLI, opencode, Antigravity CLI, Grok Build and GitHub Copilot CLI, and --compare takes any of them.'],
      ],
      related: ['run-claude-code-and-codex-in-parallel', 'multi-agent-coding', 'run-multiple-claude-code-agents-in-parallel'],
    },

    {
      slug: 'multi-agent-coding',
      title: 'Multi-agent coding: Claude Code delegating to Codex and more — wisp',
      h1: 'Multi-agent coding across Claude Code, Codex and more',
      card: 'A lead agent with a team on other harnesses and other machines, working in parallel.',
      description: 'Orchestrate several coding agents at once: parallel tasks, the same task on two agents, a Claude Code lead delegating to Codex, and a team spread over several machines. Open source.',
      lede: 'In wisp, one lead agent can run a team of coding agents on other harnesses: Claude Code plans the change, hands the tests to three Codex copies and the heavy refactor to Claude on your GPU box, and they work in parallel. The lead gets a <code>delegate</code> tool over MCP, and every member’s edits land in its worktree, its diff and its pull request.',
      shot: ['picker', 'The wisp launcher’s harness and model picker, where a lead and its team are chosen'],
      body: `
    <section>
      <h2 id="four-ways">Four ways to run agents together</h2>
      <div class="table"><table>
        <thead><tr><th>Pattern</th><th>When</th><th>In wisp</th></tr></thead>
        <tbody>
          <tr><th scope="row">Parallel tasks</th><td>Independent tasks, one per agent</td><td>Launch them back to back; a worktree each. <a href="/guides/run-multiple-claude-code-agents-in-parallel.html">Guide</a></td></tr>
          <tr><th scope="row">Compare</th><td>One task, the best of several attempts</td><td><b>vs</b> in the launcher, <code>--compare</code>. <a href="/guides/run-claude-code-and-codex-in-parallel.html">Guide</a></td></tr>
          <tr><th scope="row">Delegate</th><td>One big task, split by a lead</td><td><b>Delegate</b> in the launcher (below), members here or on other machines</td></tr>
          <tr><th scope="row">Machines</th><td>More agents than one computer handles</td><td><b>Run on</b> in the launcher. <a href="/guides/run-coding-agents-on-multiple-machines.html">Guide</a></td></tr>
        </tbody>
      </table></div>
      <p>They combine: a lead on your laptop with members on a dev box and a GPU machine, compared against a second lead.</p>
    </section>

    <section>
      <h2 id="team">Give the lead a team</h2>
      <p>The launcher’s <b>Delegate</b> button sets up a team of up to 6 members. Each has a place (with the lead, this computer or one of your machines), a harness, a model and thinking level, a name, a <b>Use for</b> note that tells the lead when to pick it, and a copies count:</p>
      <div class="table"><table>
        <thead><tr><th>Member</th><th>Harness</th><th>Use for</th></tr></thead>
        <tbody>
          <tr><td>lead</td><td>Claude Code</td><td>Plans the change, reviews, ships</td></tr>
          <tr><td><code>codex#1</code>…<code>codex#3</code></td><td>Codex ×3</td><td>Writing and fixing tests, one module each</td></tr>
          <tr><td><code>docs</code></td><td>opencode, a cheap model</td><td>README and changelog</td></tr>
          <tr><td><code>heavy</code></td><td>Claude Code on your GPU box</td><td>The long refactor</td></tr>
        </tbody>
      </table></div>
      <p>Claude Code, Codex, opencode, Grok Build and Copilot CLI can lead; Cursor CLI and Antigravity CLI can be members too. <b>Save as preset</b> keeps a team for later.</p>
      <p>You can follow up while the lead waits on its members. A follow-up that interrupts the lead leaves them working: the lead’s next turn is told who is still on it and collects their reports, and a member that finishes after the lead is done sends its report back as a follow-up from wisp. <b>Stop</b> stops the lead and every member.</p>
      <p>The top of the popover shows the lead and where it runs; click the place to move it. <b>Add delegate</b> asks where the new member goes, and its harness picker lists what’s installed there, so each machine can run its own model.</p>
    </section>

    <section>
      <h2 id="other-machines">Delegate to another machine</h2>
      <p>A member’s place is <i>With the lead</i> by default: same computer, same folder, and it sees the lead’s edits as they happen. Put it on this computer or one of your <a href="/guides/run-coding-agents-on-multiple-machines.html">machines</a> instead and each task it gets goes like this:</p>
      <ol class="doc-steps">
        <li>wisp packs the lead’s work, its branch and uncommitted edits, like <a href="/guides/move-a-task-to-another-machine-or-agent.html">moving a task</a> does.</li>
        <li>On that machine, the project’s checkout (cloned there first if need be) gets a worktree holding that work, and the member runs the task in it. Its live line shows on the lead’s card.</li>
        <li>When it finishes, its changes come back as a patch and land in the lead’s folder, merged three ways if the lead changed things meanwhile. Its report goes to the lead, and the run over there is cleaned up.</li>
      </ol>
      <p>Give a member on another machine work that doesn’t overlap with the rest: it doesn’t see edits made after it started. If its lines clash with the lead’s, the report lists the conflicted files; a patch that doesn’t apply is saved and the report says where. It needs a git repo; stopping the lead stops it too. The lead can run on a machine as well, since the wisp you launched from does the carrying.</p>
    </section>

    <section>
      <h2 id="delegation">How delegation works</h2>
      <ul class="doc-list">
        <li>The lead gets a <code>delegate</code> tool on wisp’s MCP server, and its harness’s own subagent tool is switched off. Tasks it sends in one call run in parallel, in the lead’s folder (or on a copy of it, for members on other machines).</li>
        <li>Delegating to the same member again resumes that member’s conversation, so it keeps its context.</li>
        <li>Members’ edits count as the lead’s: they show up in its diff, its checkpoints and rollback, and its pull request.</li>
        <li>The call returns each member’s report and the files it changed, and wisp shows those reports next to the lead’s. Members don’t ask you questions; they make the call and note the assumption, and the lead decides.</li>
      </ul>
      <p>From the API, pass <code>subagents</code> (each with an optional <code>machine</code>: <code>here</code> or a machine id) or a saved <code>preset</code> to <code>POST /sessions</code>. See <a href="/integrations.html">integrations</a>.</p>
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
        ['Do delegates work in the same worktree?', 'Members with the lead do: they work in the lead’s folder, so their edits are part of one branch, one diff and one pull request. Members on other machines work on a copy there, and their changes come back into it. Separate tasks get separate worktrees.'],
        ['Can the team run on another machine?', 'Yes. When a task runs on a machine, the lead and its team run there. Each member can also run on a place of its own (this computer or any of your machines): it works on a copy of the lead’s work there, and its changes come back when it finishes.'],
        ['Which agents can lead?', 'Claude Code, Codex, opencode, Grok Build and Copilot CLI can lead a team. Cursor CLI and Antigravity CLI can be members.'],
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
        <li><b>Keep it running.</b> Run tasks on a desktop or VM so they don’t stop when the laptop sleeps (<a href="/guides/run-coding-agents-on-multiple-machines.html">agents on other machines</a>), or on <a href="/guides/use-wisp-cloud.html">wisp Cloud</a>, your own wisp on a server.</li>
      </ul>
    </section>

    <section>
      <h2 id="triggers">On a schedule, or when CI fails</h2>
      <p><b>Recipes</b> are saved prompts with <code>{params}</code> (<code>wisp run release 0.42.0</code>). <b>Triggers</b> start them on their own while wisp is open:</p>
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
        ['Does it need to stay open?', 'wisp runs the agents, so it has to be running somewhere. Run it on a desktop or a VM through Machines, or use wisp Cloud (your own wisp on a server), and your laptop can sleep.'],
      ],
      related: ['run-claude-code-24-7-without-a-vps', 'run-coding-agents-on-multiple-machines', 'multi-agent-coding'],
    },

    {
      slug: 'make-claude-code-keep-going-until-tests-pass',
      title: 'Make Claude Code keep going until the tests pass — wisp',
      h1: 'Make Claude Code keep going until the tests pass',
      card: 'Give a task a Done when goal. wisp checks after every round and sends it back until it holds.',
      description: 'Stop coding agents from quitting early. Give a task a Done when goal and wisp runs your tests after every round until it holds. Works on any harness.',
      lede: 'Coding agents stop when they think they’re done, often with a test still failing. In wisp you give the task a goal, <i>Done when all tests pass and the login page works on a phone</i>. After every round wisp checks the work itself: it runs the tests and has a read-only model read the diff. Until the goal holds, the agent gets the task back with what’s missing. It works on Claude Code, Codex, opencode, Cursor and the rest.',
      shot: ['goal', 'A wisp task working toward its goal: the condition, a progress bar at 60% (+30 since the last round), Round 3 of 10, and what the last check found still missing'],
      body: `
    <section>
      <h2 id="why-agents-stop">Why agents stop early</h2>
      <p>An agent ends its turn when its own reading of the task says it’s finished. It may have skipped the slow test suite, fixed the case it was shown and not the one next to it, or reported success on a build it never ran. The usual fix is to read the report, run the tests yourself and type “the auth tests still fail, keep going”, several times over. A goal hands that loop to wisp.</p>
    </section>

    <section>
      <h2 id="done-when">Write a Done when that can be checked</h2>
      <p>Turn on <b>Goal</b> in the prompt box and a <i>Done when</i> line opens under the prompt. Write what has to be true, not what to do:</p>
      <ul class="doc-list">
        <li><b>Good:</b> <i>every test in <code>test/auth</code> passes and <code>npm run build</code> has no warnings</i>. Tests and a build the checker can run.</li>
        <li><b>Good:</b> <i>the login form fits a 390px screen with no horizontal scroll</i>. Something the checker can read in the CSS and markup.</li>
        <li><b>Too vague:</b> <i>the code is clean</i>. Nothing to check it against, so the rounds run out.</li>
      </ul>
      <p>Pick how many rounds it gets: 3, 5, 10 or 20. On a task that’s already running or finished, type <code>/goal &lt;condition&gt;</code> in the reply box; an idle task is checked right away, since it may already hold.</p>
    </section>

    <section>
      <h2 id="the-check">What wisp checks after each round</h2>
      <ol class="doc-list">
        <li><b>The tests.</b> wisp runs the project’s test command itself. Only tests that passed before the change count as failures.</li>
        <li><b>The diff.</b> A cheap model, read-only, in the task’s folder, reads everything that changed since the goal was set, and can open any file.</li>
        <li><b>The agent’s report, as a claim.</b> It goes in last and is labelled as what the agent says, not as evidence.</li>
      </ol>
      <p>The checker answers <i>met</i>, <i>not yet</i> or <i>can’t be done</i>, with why. A <i>met</i> needs evidence it saw for itself and tests that don’t disagree; otherwise it counts as not yet. Not yet sends the task back with what’s missing and the next step.</p>
    </section>

    <section>
      <h2 id="rounds">Rounds, stalls and the one ping</h2>
      <p>The task stays in Working through every round. A band on top of it shows the goal, a progress bar with how much the last round moved it, <i>Round 3 of 10</i>, and the last check in the checker’s words; the row in the list shows a ring and <i>3/10</i>. It lands in <i>Needs you</i>, with one notification, when the goal is:</p>
      <div class="table"><table>
        <thead><tr><th>Outcome</th><th>When</th><th>What you can do</th></tr></thead>
        <tbody>
          <tr><td>Met</td><td>the checker saw it hold, tests passing</td><td>Ship it</td></tr>
          <tr><td>Can’t be done</td><td>it needs access or a decision only you have, or contradicts itself</td><td>read why, change the goal</td></tr>
          <tr><td>Out of rounds</td><td>still not met after the last round</td><td><b>Resume goal</b> for another set of rounds</td></tr>
          <tr><td>Stalled</td><td>two rounds changed nothing, or got the same next step with no progress</td><td>steer it with a follow-up, then resume</td></tr>
        </tbody>
      </table></div>
      <p><b>Stop</b> pauses the goal. A follow-up of yours keeps it, and it’s checked again after your turn.</p>
    </section>

    <section>
      <h2 id="any-harness">Goals on Codex, opencode and Cursor</h2>
      <p>wisp checks the work outside the agent, so a goal works the same on every harness it runs: Claude Code, Codex, opencode, Cursor, Antigravity, Grok and Copilot. The agent is told its goal every turn and that it will be checked. With <a href="/guides/claude-code-vs-codex.html#let-results-pick">Auto</a>, a task handed to a stronger model takes its goal, and the rounds it has left, along.</p>
      ${sh(`wisp "/goal every test in test/auth passes"        # the condition is the task
curl -X PUT localhost:4477/api/sessions/$ID/goal \\
  -H 'content-type: application/json' \\
  -d '{"text":"npm run build has no warnings","max":5}'`)}
    </section>
`,
      faq: [
        ['Does it cost more?', 'Each round is another agent turn, plus a test run and a short call to a cheap model. Pick fewer rounds for small tasks; a stalled goal pauses on its own instead of using them up.'],
        ['What if my project has no tests?', 'The checker still reads the diff and the files. Write a goal it can verify by reading, like a page that fits 390px or an endpoint that returns 404 for unknown ids.'],
        ['Can I change the goal mid-way?', 'Yes. Edit goal… in the band, More, the right-click menu or ⌘K changes the words and keeps the rounds it has used. /goal drop, or Drop goal, removes it.'],
      ],
      related: ['run-coding-agents-in-the-background', 'claude-code-vs-codex', 'run-multiple-claude-code-agents-in-parallel'],
    },

    {
      slug: 'run-claude-code-24-7-without-a-vps',
      cloud: true,
      title: 'Run Claude Code 24/7 without setting up a VPS — wisp',
      h1: 'Run Claude Code 24/7 without a VPS',
      card: 'Keep Claude Code and Codex working with the laptop shut: rent and run a server, or open a free box on wisp Cloud.',
      description: 'Keep Claude Code and Codex running while your laptop sleeps: a DIY VPS (tmux, SSH from your phone, upkeep) next to wisp Cloud, your own sandboxed box that is free during the preview.',
      lede: 'Claude Code runs where you start it, so it stops when your laptop sleeps or the SSH session drops. To keep it going overnight it needs a computer that stays on. You can rent one and run it yourself, or open <a href="https://grid.trywisp.dev" data-cloud-cta="guide-lede">wisp Cloud</a> and get your own box with Claude Code, Codex and Cursor already installed, free during the preview.',
      figure: `<figure class="doc-shot doc-diagram" aria-label="On the laptop, the run stops when the lid closes at 18:40. On wisp Cloud it keeps going and the report is ready at 02:14.">
  <svg class="wide" viewBox="0 0 960 300" aria-hidden="true">
    <text x="20" y="66" class="name">Laptop</text>
    <text x="20" y="88" class="sub">Claude Code in a terminal</text>
    <path d="M250 74 H 281" class="link"/>
    <circle cx="288" cy="74" r="7" class="box"/>
    <path d="M300 74 H 940" class="zone"/>
    <text x="300" y="56" class="sub">18:40 · the lid closes and the run stops with it</text>
    <text x="20" y="186" class="name">wisp Cloud</text>
    <text x="20" y="208" class="sub">your own box on a server</text>
    <path d="M250 194 H 610" class="link"/>
    <path d="M598 186 L612 194 L598 202" class="link"/>
    <text x="300" y="176" class="sub">keeps going with the lid shut</text>
    <rect x="620" y="162" width="250" height="64" rx="14" class="box"/>
    <text x="745" y="190" text-anchor="middle" class="name">Report ready</text>
    <text x="745" y="212" text-anchor="middle" class="sub">02:14 · waiting on your phone</text>
    <text x="250" y="282" class="mono">18:00</text>
    <text x="388" y="282" text-anchor="middle" class="mono">21:00</text>
    <text x="526" y="282" text-anchor="middle" class="mono">00:00</text>
    <text x="664" y="282" text-anchor="middle" class="mono">03:00</text>
    <text x="802" y="282" text-anchor="middle" class="mono">06:00</text>
    <text x="940" y="282" text-anchor="end" class="mono">09:00</text>
  </svg>
  <svg class="tall" viewBox="0 0 340 440" aria-hidden="true">
    <rect x="10" y="10" width="320" height="170" rx="16" class="box"/>
    <text x="30" y="46" class="name">Laptop</text>
    <text x="30" y="68" class="sub">Claude Code in a terminal</text>
    <path d="M30 108 H 84" class="link"/>
    <circle cx="92" cy="108" r="7" class="box"/>
    <path d="M104 108 H 310" class="zone"/>
    <text x="30" y="150" class="sub">18:40 · the lid closes, the run stops</text>
    <rect x="10" y="200" width="320" height="230" rx="16" class="box"/>
    <text x="30" y="236" class="name">wisp Cloud</text>
    <text x="30" y="258" class="sub">your own box on a server</text>
    <path d="M30 298 H 300" class="link"/>
    <path d="M290 290 L304 298 L290 306" class="link"/>
    <text x="30" y="340" class="sub">keeps going with the lid shut</text>
    <rect x="30" y="358" width="280" height="52" rx="12" class="box"/>
    <text x="170" y="390" text-anchor="middle" class="mono">02:14 · report on your phone</text>
  </svg>
</figure>`,
      body: `
    <section>
      <h2 id="why">Why it stops</h2>
      <p>A coding agent is a process on the computer you started it on. When that computer sleeps, the process sleeps; when your SSH session drops, the process goes with it unless something like <code>tmux</code> holds it. Driving it from your phone doesn’t change that: the run still lives on the machine that has to stay awake. So the fix is a computer that never closes its lid.</p>
    </section>

    <section>
      <h2 id="vps">Option 1: run your own server</h2>
      <ol class="doc-steps">
        <li><b>Rent a small Linux VM.</b> 2–4 GB of RAM is a floor once the agent runs your builds and tests.</li>
        <li><b>Set it up:</b> a user that isn’t root, Node.js, Claude Code, <code>git</code> and <code>gh</code>, and your repo cloned.</li>
        <li><b>Sign in on the server</b> with <code>claude auth login</code>: open the link it prints and paste the code back.</li>
        <li><b>Run it inside tmux</b> so it survives the connection dropping, and attach from your phone’s SSH app.</li>
      </ol>
      ${sh(`ssh you@your-server
tmux new -s agent      # keeps running when the connection drops
claude                 # sign in once with: claude auth login

# later, from your phone's SSH app
tmux attach -t agent`)}
      <p>It works. What you get on the phone is the terminal: the transcript, permission prompts and diffs at phone size. You also keep the box patched, watch its disk, update the CLIs, and do it all again for Codex.</p>
    </section>

    <section>
      <h2 id="cloud">Option 2: wisp Cloud, nothing to set up</h2>
      <ol class="doc-steps">
        <li>Open <a href="https://grid.trywisp.dev" data-cloud-cta="guide-steps">grid.trywisp.dev</a> and press <b>Continue with GitHub</b>. You get your own wisp at <code>you.grid.trywisp.dev</code>, in a gVisor sandbox of its own.</li>
        <li><b>Sign in to Claude Code</b> from the model picker or Settings → Agents: a link to Claude’s own sign-in page and a code, no terminal. Codex, Cursor, Grok, Antigravity and <code>gh</code> sign in the same way; opencode’s free models need no account, and its Zen and Go subscriptions take the API key you paste there.</li>
        <li><b>Give it a task and close the laptop.</b> It keeps running. Questions and the finished report reach you in the browser, wisp on your computer, or the Android app.</li>
      </ol>
      <p>The preview is free. It opens seats as its server shows room for more people, and when they’re all taken <a href="/cloud.html">the Cloud page</a> takes your email for the next one. The full walkthrough is in <a href="/guides/use-wisp-cloud.html">Use wisp Cloud</a>.</p>
    </section>

    <section>
      <h2 id="compare">Side by side</h2>
      <div class="table"><table>
        <thead><tr><th></th><th>Your own server</th><th>wisp Cloud</th></tr></thead>
        <tbody>
          <tr><th scope="row">Setup</th><td>A VM, a user, Node, the CLIs, sign-ins, tmux</td><td>Sign in with GitHub or Google, then sign in to Claude Code with a code</td></tr>
          <tr><th scope="row">Cost</th><td>The VM every month, plus your Claude plan</td><td>Free during the preview, plus your Claude plan</td></tr>
          <tr><th scope="row">Agents</th><td>The ones you install</td><td>Claude Code, Codex, Cursor, opencode, Grok and Antigravity, installed</td></tr>
          <tr><th scope="row">From the phone</th><td>An SSH app and a terminal</td><td>wisp in the browser or the Android app: cards, reports, a button per question</td></tr>
          <tr><th scope="row">When the agent asks</th><td>It waits in the terminal until you attach</td><td>A notification; answer from whichever device you’re on</td></tr>
          <tr><th scope="row">When nothing runs</th><td>The VM stays up</td><td>It sleeps, and wakes in seconds for you, a task or a schedule</td></tr>
          <tr><th scope="row">Upkeep</th><td>OS patches, disk, CLI updates</td><td>None on your side</td></tr>
        </tbody>
      </table></div>
    </section>

    <section>
      <h2 id="own">Option 3: a computer you already have</h2>
      <p>A desktop or home server that stays on works too. wisp’s <b>Machines</b> starts the agents there over SSH from your laptop, and every run lands in the same queue: <a href="/guides/run-coding-agents-on-multiple-machines.html">agents on multiple machines</a>. For a team, run the same server wisp Cloud runs on: <a href="/guides/self-host-wisp-grid.html">run your own wisp Grid</a>.</p>
    </section>
`,
      faq: [
        ['Which Claude plan do I need?', 'Your own, the same as on your laptop: Claude Code signs in with your Claude account. wisp doesn’t resell model usage, so your plan’s limits apply wherever it runs.'],
        ['What happens when I close the laptop mid-task?', 'On wisp Cloud, nothing: the task runs on the server. Your box only sleeps when no task is running and nobody is looking, and it wakes in seconds when you open it, send a task, or a schedule is due.'],
        ['Is wisp Cloud really free?', 'Yes, during the early preview. It runs on one small server, so it takes a set number of accounts; the Cloud page says how many are left, and when they’re taken you can leave your email for the next one.'],
        ['Does it work for Codex and Cursor too?', 'Yes. Codex, Cursor, opencode, Grok and Antigravity are installed next to Claude Code, each signs in with a link and a code, and one queue holds all of them.'],
      ],
      related: ['use-wisp-cloud', 'run-coding-agents-in-the-background', 'self-host-wisp-grid'],
    },

    {
      slug: 'use-wisp-cloud',
      cloud: true,
      title: 'Run Claude Code and Codex on a server while your laptop sleeps',
      h1: 'Use wisp Cloud',
      card: 'Your own wisp on a server: sign in with GitHub or Google, close the laptop, read the report on your phone.',
      description: 'Your own wisp on a server at grid.trywisp.dev: sign in with GitHub or Google, connect Claude Code and Codex with a code, and agents keep working with your laptop closed.',
      lede: 'To keep coding agents working when your laptop is closed, run them on a computer that stays on. <a href="https://grid.trywisp.dev">wisp Cloud</a> gives you one: your own wisp on a server, in a sandbox of its own, that you open from the browser, from wisp on your computer, or from your phone. It’s free in early preview at <a href="https://grid.trywisp.dev">grid.trywisp.dev</a>, a few accounts at a time, and you can run the same thing on your own server.',
      figure: `<figure class="doc-shot doc-diagram" aria-label="Your laptop, phone and browser open your own wisp on grid.trywisp.dev, in a sandbox of its own">
  <svg class="wide" viewBox="0 0 960 300" aria-hidden="true">
    <rect x="20" y="20" width="200" height="66" rx="14" class="box"/>
    <text x="120" y="50" text-anchor="middle" class="name">Laptop</text>
    <text x="120" y="72" text-anchor="middle" class="sub">Machines</text>
    <rect x="20" y="117" width="200" height="66" rx="14" class="box"/>
    <text x="120" y="147" text-anchor="middle" class="name">Phone</text>
    <text x="120" y="169" text-anchor="middle" class="sub">wisp Cloud</text>
    <rect x="20" y="214" width="200" height="66" rx="14" class="box"/>
    <text x="120" y="244" text-anchor="middle" class="name">Browser</text>
    <text x="120" y="266" text-anchor="middle" class="sub">grid.trywisp.dev</text>
    <path d="M220 53 C 300 53, 330 150, 430 150 M220 150 H 430 M220 247 C 300 247, 330 150, 430 150" class="link"/>
    <path d="M418 142 L432 150 L418 158" class="link"/>
    <rect x="440" y="20" width="500" height="260" rx="22" class="zone"/>
    <text x="690" y="52" text-anchor="middle" class="sub">grid.trywisp.dev · sign in with GitHub or Google</text>
    <rect x="540" y="82" width="300" height="164" rx="14" class="box"/>
    <text x="690" y="116" text-anchor="middle" class="name">you.grid.trywisp.dev</text>
    <text x="690" y="148" text-anchor="middle" class="sub">your own sandbox</text>
    <text x="690" y="184" text-anchor="middle" class="mono">Claude Code · Codex · gh</text>
    <text x="690" y="216" text-anchor="middle" class="sub">sleeps when idle</text>
  </svg>
  <svg class="tall" viewBox="0 0 340 470" aria-hidden="true">
    <rect x="10" y="10" width="100" height="62" rx="12" class="box"/>
    <text x="60" y="47" text-anchor="middle" class="name">Laptop</text>
    <rect x="120" y="10" width="100" height="62" rx="12" class="box"/>
    <text x="170" y="47" text-anchor="middle" class="name">Phone</text>
    <rect x="230" y="10" width="100" height="62" rx="12" class="box"/>
    <text x="280" y="47" text-anchor="middle" class="name">Browser</text>
    <path d="M60 72 C 60 120, 170 110, 170 150 M170 72 V 150 M280 72 C 280 120, 170 110, 170 150" class="link"/>
    <path d="M162 138 L170 152 L178 138" class="link"/>
    <rect x="20" y="160" width="300" height="296" rx="20" class="zone"/>
    <text x="170" y="190" text-anchor="middle" class="sub">grid.trywisp.dev</text>
    <rect x="50" y="216" width="240" height="210" rx="14" class="box"/>
    <text x="170" y="254" text-anchor="middle" class="name">your wisp</text>
    <text x="170" y="290" text-anchor="middle" class="sub">its own sandbox</text>
    <text x="170" y="330" text-anchor="middle" class="mono">Claude Code · Codex</text>
    <text x="170" y="360" text-anchor="middle" class="mono">gh</text>
    <text x="170" y="398" text-anchor="middle" class="sub">sleeps when idle</text>
  </svg>
</figure>`,
      body: `
    <section>
      <h2 id="signin">1. Sign in</h2>
      <ol class="doc-steps">
        <li>Open <a href="https://grid.trywisp.dev">grid.trywisp.dev</a> and press <b>Continue with GitHub</b>.</li>
        <li>Your account page shows your cloud computer at <code>you.grid.trywisp.dev</code>. Press <b>Open wisp</b>: it starts in a few seconds, and you’re in the same wisp you know, in the browser.</li>
      </ol>
    </section>

    <section>
      <h2 id="agents">2. Connect your agents</h2>
      <p>Your cloud computer comes with Claude Code, Codex, opencode and <code>gh</code> installed. Sign them in with your own accounts: in your cloud wisp, Settings → <b>Agents</b> → <b>Sign in</b>.</p>
      <ul class="doc-list">
        <li><b>Claude Code:</b> open the sign-in page, sign in with your Claude account, and paste the code it shows back into wisp.</li>
        <li><b>Codex:</b> open the page and type in the code wisp shows (it runs <code>codex login --device-auth</code> for you).</li>
        <li><b>GitHub:</b> the same, with <code>gh auth login</code>. Afterwards <code>git</code> pushes with it and commits carry your GitHub name, so <b>Ship it</b> opens pull requests.</li>
      </ul>
      <p>The logins stay in your own folder on the server. The model picker only offers the agents you signed in to; opencode’s free models work with no account at all.</p>
    </section>

    <section>
      <h2 id="desktop">3. Use it from your computer</h2>
      <ol class="doc-steps">
        <li>In wisp on your computer, open <b>Machines</b> → <i>Reach this computer from anywhere</i> (or Settings → <b>Cloud</b>). The address is filled in: press <b>Sign in and add it</b>.</li>
        <li>wisp shows a code and opens grid.trywisp.dev. Check the code and press <b>Allow</b>.</li>
        <li>Your cloud computer joins <b>Run on</b> next to this computer and your SSH machines, marked <i>Cloud · on grid</i>. Settings → Cloud also lists its agents with <b>Sign in</b> buttons, so you can sign them in from here.</li>
        <li>Signed in from Machines, this computer joins the grid too: your phone and your other computers can open it. <b>Remove from grid</b> takes it off. <a href="/guides/reach-your-computer-from-your-phone.html">More →</a></li>
      </ol>
      <p>Watching it from your desktop doesn’t keep it awake. When it sleeps the card says <i>Asleep</i>, its tasks still show, and anything you send it wakes it.</p>
    </section>

    <section>
      <h2 id="phone">4. Use it from your phone</h2>
      <p>The wisp Android app starts with <b>wisp Cloud</b> on its first screen: press <b>Sign in</b> and allow the code in your browser. It then lists your cloud computer and every computer you added to the grid, each one a tap away. No SSH and no tunnel to set up.</p>
    </section>

    <section>
      <h2 id="private">What’s private</h2>
      <ul class="doc-list">
        <li><b>A sandbox per person.</b> Your wisp runs in its own gVisor container, with its own folder and network. Other people’s wisps can’t reach it, and neither can it reach theirs or the server itself.</li>
        <li><b>Your logins stay yours.</b> Claude, ChatGPT and GitHub sign in inside your box. The grid never sees a password.</li>
        <li><b>It sleeps when idle</b> and wakes for you, a task, or a schedule.</li>
        <li><b>Delete your account</b> and your folder and its keys are gone.</li>
      </ul>
    </section>
`,
      faq: [
        ['Is wisp Cloud free?', 'Yes, during the early preview. You bring your own Claude, ChatGPT or GitHub accounts; model usage is billed by those providers.'],
        ['Why can’t I sign up?', 'The preview opens seats as its server shows room for more people. When they’re all taken, the sign-in page says so and trywisp.dev/cloud.html takes your email: the next seat is held for the oldest email on the list, for the GitHub account that uses it. People who already have an account keep signing in.'],
        ['Do I need wisp installed on my computer?', 'No. The browser is enough. wisp on your computer and the Android app can sign in to it too, with a code.'],
        ['Can I run my own?', 'Yes: the grid is in the wisp repo (MIT). See Run your own wisp Grid.'],
        ['What happens to a task when the cloud computer sleeps?', 'It only sleeps when no task is running and nobody is looking. Tasks, reports and logins are kept; it wakes in seconds.'],
      ],
      related: ['reach-your-computer-from-your-phone', 'run-claude-code-24-7-without-a-vps', 'self-host-wisp-grid'],
    },

    {
      slug: 'reach-your-computer-from-your-phone',
      cloud: true,
      title: 'Use Claude Code on your own computer from your phone, no SSH — wisp',
      h1: 'Reach your own computer from anywhere',
      card: 'Add your desktop to wisp Cloud from its Machines: your phone and other computers open it, with no SSH, Tailscale or open port.',
      description: 'Add the computer running wisp to wisp Cloud and open it from your phone or another computer, anywhere: no SSH, no Tailscale, no port forwarding. Claude Code and Codex keep running there with your files.',
      lede: 'To use the coding agents on your desktop from your phone or another computer, add it to <a href="https://grid.trywisp.dev">wisp Cloud</a>: in wisp on it, <b>Machines</b> → <i>Reach this computer from anywhere</i>. It dials out to the grid and keeps that connection open, so no port or router needs opening. Your phone and other computers, signed in as you, list it and open it with one tap. The agents run on it, with its files.',
      figure: `<figure class="doc-shot doc-diagram" aria-label="Your phone and laptop open your desktop through grid.trywisp.dev; the desktop holds a tunnel open to the grid">
  <svg class="wide" viewBox="0 0 960 300" aria-hidden="true">
    <rect x="20" y="40" width="200" height="66" rx="14" class="box"/>
    <text x="120" y="70" text-anchor="middle" class="name">Phone</text>
    <text x="120" y="92" text-anchor="middle" class="sub">wisp app</text>
    <rect x="20" y="194" width="200" height="66" rx="14" class="box"/>
    <text x="120" y="224" text-anchor="middle" class="name">Laptop</text>
    <text x="120" y="246" text-anchor="middle" class="sub">Machines</text>
    <path d="M220 73 C 280 73, 300 150, 350 150 M220 227 C 280 227, 300 150, 350 150" class="link"/>
    <path d="M338 142 L352 150 L338 158" class="link"/>
    <rect x="360" y="90" width="240" height="120" rx="16" class="zone"/>
    <text x="480" y="140" text-anchor="middle" class="name">grid.trywisp.dev</text>
    <text x="480" y="168" text-anchor="middle" class="sub">checks it’s you</text>
    <path d="M600 150 H 720" class="link"/>
    <text x="660" y="138" text-anchor="middle" class="sub">tunnel</text>
    <rect x="730" y="70" width="210" height="160" rx="14" class="box"/>
    <text x="835" y="114" text-anchor="middle" class="name">Your desktop</text>
    <text x="835" y="144" text-anchor="middle" class="mono">Claude Code · Codex</text>
    <text x="835" y="176" text-anchor="middle" class="sub">dials out, no open port</text>
    <text x="835" y="204" text-anchor="middle" class="sub">your files stay here</text>
  </svg>
  <svg class="tall" viewBox="0 0 340 470" aria-hidden="true">
    <rect x="20" y="10" width="140" height="62" rx="12" class="box"/>
    <text x="90" y="47" text-anchor="middle" class="name">Phone</text>
    <rect x="180" y="10" width="140" height="62" rx="12" class="box"/>
    <text x="250" y="47" text-anchor="middle" class="name">Laptop</text>
    <path d="M90 72 C 90 110, 170 100, 170 130 M250 72 C 250 110, 170 100, 170 130" class="link"/>
    <path d="M162 118 L170 132 L178 118" class="link"/>
    <rect x="50" y="140" width="240" height="90" rx="16" class="zone"/>
    <text x="170" y="180" text-anchor="middle" class="name">grid.trywisp.dev</text>
    <text x="170" y="206" text-anchor="middle" class="sub">checks it’s you</text>
    <path d="M170 230 V 290" class="link"/>
    <text x="190" y="266" class="sub">tunnel</text>
    <rect x="40" y="296" width="260" height="160" rx="14" class="box"/>
    <text x="170" y="336" text-anchor="middle" class="name">Your desktop</text>
    <text x="170" y="368" text-anchor="middle" class="mono">Claude Code · Codex</text>
    <text x="170" y="400" text-anchor="middle" class="sub">dials out, no open port</text>
    <text x="170" y="428" text-anchor="middle" class="sub">your files stay here</text>
  </svg>
</figure>`,
      body: `
    <section>
      <h2 id="add">1. Add the computer</h2>
      <ol class="doc-steps">
        <li>Run wisp on it: the desktop app, or <code>npx wisp-agents</code>.</li>
        <li>Open <b>Machines</b> → <i>Reach this computer from anywhere</i>. The address (<code>grid.trywisp.dev</code>, or your own grid) is filled in: press <b>Sign in and add it</b>.</li>
        <li>A page from the grid opens with a code. Check it matches, sign in with GitHub or Google if asked, and press <b>Allow</b>.</li>
      </ol>
      <p>From a terminal, on a server or a computer you reach over SSH, <code>wisp computer on</code> does the same: it prints the code and the page to open (any browser, even your phone’s), waits for you to allow it, then prints the computer’s address. <code>wisp computer</code> says whether it’s on, <code>wisp computer off</code> takes it off, and <code>--grid wisp.example.com</code> picks your own grid.</p>
      <p>Machines now says <i>This computer · On your grid</i>, online at an address like <code>studio--you.grid.trywisp.dev</code>. <b>Remove from grid</b> takes it off again; wisp on it keeps running either way.</p>
    </section>

    <section>
      <h2 id="phone">2. Open it from your phone</h2>
      <p>In the wisp Android app, sign in to <b>wisp Cloud</b> on the first screen with the same account. The list shows your cloud wisp and every computer you added, marked <i>Your computer · via grid</i>. Tap <b>Open</b> and you’re in that computer’s wisp: start tasks, answer your agents, read reports. A computer that’s switched off, or not running wisp, shows <i>Offline</i>.</p>
    </section>

    <section>
      <h2 id="computers">3. Open it from your other computers</h2>
      <p>Add each of your computers the same way. In each one’s <b>Machines</b>, the others show up by themselves, and <b>Run on</b> sends tasks to them like any machine: their worktrees, diffs and Ship it work over there. Your account page at <a href="https://grid.trywisp.dev">grid.trywisp.dev</a> lists them all with <b>Open</b> buttons, for any browser.</p>
    </section>

    <section>
      <h2 id="private">What passes through the grid</h2>
      <ul class="doc-list">
        <li><b>Only you get in.</b> The grid lets in your own browser sessions and the devices you allowed; nobody else’s account opens your computer. Only the computer that was added can hold its tunnel.</li>
        <li><b>Nothing is stored on the way.</b> Requests go over HTTPS to the grid, which checks it’s you and forwards them down the tunnel. Your files, logins and tasks stay on your computer.</li>
        <li><b>Gone in one click.</b> Remove the computer (or the device that added it) on your account page and the tunnel closes at once.</li>
        <li><b>Rather keep it on your network?</b> Use Machines over SSH, with <a href="/guides/connect-machines-with-tailscale.html">Tailscale</a> to go anywhere.</li>
      </ul>
    </section>
`,
      faq: [
        ['Do I need SSH, Tailscale or port forwarding?', 'No. The computer dials out to the grid and keeps that connection open, so it works behind any home router or office firewall that lets it browse the web.'],
        ['Does the computer need to stay on?', 'Yes: it runs the agents. Switched off or asleep, it shows Offline and comes back when it’s on with wisp running. For agents that work while every computer is off, use your cloud wisp.'],
        ['Is it free?', 'Yes, during the wisp Cloud preview. A computer you add doesn’t take a cloud seat’s server resources: it runs on your own hardware.'],
        ['Can I use my own grid?', 'Yes. Type your grid’s address instead of grid.trywisp.dev. See Run your own wisp Grid.'],
        ['Can I add it without opening the app?', 'Yes: run wisp computer on in a terminal on it. It prints a code and a link; allow the code in any browser, signed in to the grid, and the computer is added. wisp computer off takes it off.'],
        ['How do I take it off?', 'Machines → Remove from grid on that computer, wisp computer off in a terminal on it, Remove from grid in another computer’s Machines, or Remove on your account page.'],
      ],
      related: ['use-wisp-cloud', 'claude-code-remote-control-alternative', 'use-codex-from-your-phone'],
    },

    {
      slug: 'claude-code-remote-control-alternative',
      cloud: true,
      title: 'Claude Code Remote Control alternative for every agent — wisp',
      h1: 'Beyond Claude Code Remote Control',
      card: 'Remote Control drives one Claude Code process on one awake computer. wisp adds Codex and the rest, every computer, and a cloud box.',
      description: 'Claude Code Remote Control drives Claude Code on a computer that stays awake. When you also run Codex, use several computers or want agents working with every lid shut, here is how wisp compares.',
      lede: 'Claude Code’s Remote Control lets you drive a Claude Code session on your computer from the Claude app or claude.ai, as long as that <code>claude</code> process keeps running and the computer stays awake. If that’s all you need, use it. wisp is for the rest: Codex, Cursor and other agents next to Claude Code, every computer you own in one list, and a cloud box that keeps working with the laptop shut.',
      shot: ['app', 'The wisp queue with Claude Code and Codex tasks from several computers, grouped into Needs you, Working and Done'],
      body: `
    <section>
      <h2 id="rc">What Remote Control does well</h2>
      <p><a href="https://code.claude.com/docs/en/remote-control" target="_blank" rel="noopener">Remote Control</a> (on Pro, Max, Team and Enterprise plans) connects the Claude app and claude.ai/code to Claude Code running on your machine. Run <code>claude remote-control</code> in a project, or <code>/rc</code> in a session, and scan the QR code. Your files, MCP servers and settings stay on your machine, it can push permission prompts to your phone, and server mode can give each session its own git worktree.</p>
      ${sh(`cd ~/code/app
claude remote-control      # press space for a QR code, scan it with the Claude app`)}
    </section>

    <section>
      <h2 id="limits">Where it stops</h2>
      <ul class="doc-list">
        <li><b>Claude Code only.</b> Codex, Cursor, opencode and the other CLIs need their own remote apps, each with its own list of sessions.</li>
        <li><b>The process and the computer stay up.</b> Close the terminal or let the laptop sleep and the session goes offline until you bring it back. On a server you keep it alive with tmux yourself.</li>
        <li><b>A server per computer, kept running by you.</b> Each computer needs <code>claude remote-control</code> started in each project and kept alive; when it exits after a long network outage, you start it again.</li>
        <li><b>You read the conversation.</b> On a phone that means scrolling a transcript to find out what changed and whether the tests passed.</li>
      </ul>
    </section>

    <section>
      <h2 id="wisp">The same, for every agent: wisp</h2>
      <ol class="doc-steps">
        <li><b>Run wisp on each computer</b> (<code>npx wisp-agents</code>) and open <b>Machines</b> → <i>Reach this computer from anywhere</i>. It dials out to <a href="https://grid.trywisp.dev">wisp Cloud</a>, so there’s no port, SSH or Tailscale to set up.</li>
        <li><b>Open any of them from your phone</b>: the wisp Android app, or grid.trywisp.dev in any phone’s browser. Start a task with Claude Code, Codex, Cursor, opencode, Grok, Antigravity or Copilot, in its own worktree.</li>
        <li><b>Read the report, not the transcript.</b> Each finished task shows its headline, the diff, the test run and any question as a button. ntfy or Telegram can tell you when one needs you.</li>
        <li><b>Shut every lid.</b> Your cloud wisp on grid.trywisp.dev runs the same agents on a server, free during the preview, and sleeps when nothing runs.</li>
      </ol>
    </section>

    <section>
      <h2 id="compare">Side by side</h2>
      <div class="table"><table>
        <thead><tr><th></th><th>Remote Control</th><th>wisp</th></tr></thead>
        <tbody>
          <tr><th scope="row">Agents</th><td>Claude Code</td><td>Claude Code, Codex, Cursor, opencode, Grok, Antigravity, Copilot</td></tr>
          <tr><th scope="row">Computers</th><td>The one running <code>claude</code></td><td>Every computer you add, plus a cloud box, in one list</td></tr>
          <tr><th scope="row">Laptop closed</th><td>The session goes offline</td><td>Tasks on your cloud wisp or a desktop keep running</td></tr>
          <tr><th scope="row">On the phone</th><td>The Claude app or claude.ai: the conversation</td><td>wisp in the Android app or any browser: cards, reports, a button per question</td></tr>
          <tr><th scope="row">Cost</th><td>Included in your Claude plan</td><td>Free and MIT on your computers; wisp Cloud free during the preview. Your own agent plans either way</td></tr>
        </tbody>
      </table></div>
      <p class="muted">Remote Control details from Anthropic’s docs, October 2026; check them for changes.</p>
    </section>
`,
      faq: [
        ['Can I use Remote Control and wisp together?', 'Yes. They don’t touch each other: Remote Control drives a claude process you started, while wisp starts its own agents in worktrees. Many people keep Remote Control for a session they’re in the middle of and use wisp to send off new tasks.'],
        ['Does wisp work on iPhone?', 'Through the browser: grid.trywisp.dev lists your cloud wisp and every computer you added, each with an Open button. The native app is Android only for now.'],
        ['Do I need a Claude Max plan?', 'No. wisp runs Claude Code with whatever plan it’s signed in with, and the other agents with their own accounts. wisp doesn’t resell model usage.'],
        ['What if I don’t want a relay at all?', 'Use Machines over SSH, with Tailscale to reach your computers from anywhere. Nothing goes through grid.trywisp.dev then.'],
      ],
      related: ['reach-your-computer-from-your-phone', 'use-codex-from-your-phone', 'remote-coding-agent-apps-compared'],
    },

    {
      slug: 'use-codex-from-your-phone',
      cloud: true,
      title: 'Use OpenAI Codex from your phone, Android or iPhone — wisp',
      h1: 'Use Codex from your phone',
      card: 'Start Codex tasks and answer them from your phone: on your own computer through wisp Cloud, or on a cloud box with the laptop shut.',
      description: 'Run the Codex CLI on your computer or a cloud box and drive it from your phone, Android or iPhone: start tasks, answer approvals and read the diff, with no SSH, port forwarding or Mac to keep awake.',
      lede: 'To use Codex from your phone, it has to run on a computer that stays on, and your phone needs a way in. OpenAI’s Codex Remote pairs the ChatGPT app with the ChatGPT desktop app on a Mac or Windows PC. wisp works with the Codex CLI on any computer, Linux included, or on a cloud box, and you open it from the Android app or any phone browser.',
      shot: ['report', 'A wisp report for a finished Codex task: headline, numbers, the real diff and the test run'],
      body: `
    <section>
      <h2 id="options">Three ways in</h2>
      <ul class="doc-list">
        <li><b>Codex Remote</b> (OpenAI): pair the ChatGPT mobile app with the ChatGPT desktop app on macOS or Windows. The host stays awake and signed in, and setup starts from the desktop app, not from the Codex CLI.</li>
        <li><b>SSH and tmux:</b> run <code>codex</code> inside tmux on a server and attach from a phone SSH app. It works anywhere and gives you a terminal at phone size.</li>
        <li><b>wisp:</b> the Codex CLI runs headless in its own git worktree on your computer or your cloud wisp, and your phone shows wisp’s own page for it.</li>
      </ul>
    </section>

    <section>
      <h2 id="cloud">On a cloud box, with the laptop shut</h2>
      <ol class="doc-steps">
        <li>Open <a href="https://grid.trywisp.dev" data-cloud-cta="guide-steps">grid.trywisp.dev</a> on your phone and press <b>Continue with GitHub</b>.</li>
        <li><b>Sign in to Codex:</b> Settings → <b>Agents</b> → <b>Sign in</b>. wisp runs <code>codex login --device-auth</code> and shows a code; open the link, type it in, done. Do the same for <code>gh</code> if you want pull requests.</li>
        <li><b>Give Codex a task</b>, pick the repo, and lock the phone. Codex keeps working on the server; the report waits for you.</li>
      </ol>
    </section>

    <section>
      <h2 id="own">On your own computer</h2>
      <ol class="doc-steps">
        <li>On the computer with your repos and Codex signed in, run wisp (<code>npx wisp-agents</code>) and open <b>Machines</b> → <i>Reach this computer from anywhere</i>. Allow the code on grid.trywisp.dev.</li>
        <li>On the phone, sign in to wisp Cloud in the Android app, or open grid.trywisp.dev in the browser. The computer is listed as <i>Your computer · via grid</i>: tap <b>Open</b>.</li>
        <li>Start Codex tasks there with that computer’s files and logins. Nothing on it listens on a port: it dialed out.</li>
      </ol>
    </section>

    <section>
      <h2 id="phone">What you do from the phone</h2>
      <ul class="doc-list">
        <li><b>Start tasks</b> with Codex, or send the same one to Codex and Claude Code and compare.</li>
        <li><b>Answer it.</b> When Codex asks or a permission blocks it, the card shows the question with a button per answer; ntfy or Telegram can notify you.</li>
        <li><b>Review and ship.</b> The report shows the diff and the test run; <b>Ship it</b> opens the pull request.</li>
      </ul>
    </section>
`,
      faq: [
        ['Does it work on iPhone?', 'Yes, in the browser: grid.trywisp.dev opens your cloud wisp and every computer you added. The native wisp app is Android only for now.'],
        ['Can the computer run Linux?', 'Yes. wisp runs the Codex CLI on macOS, Linux and Windows (beta); the cloud box is Linux.'],
        ['Which Codex plan do I need?', 'The one you already use: Codex signs in with your ChatGPT account or an API key, and its limits apply. wisp doesn’t resell model usage.'],
        ['Is Codex Remote better?', 'If you live in the ChatGPT desktop app on a Mac or PC that stays awake, it’s the most direct. wisp fits when you use the Codex CLI, Linux, several computers or other agents, or want Codex to keep going with every computer off.'],
      ],
      related: ['use-wisp-cloud', 'claude-code-remote-control-alternative', 'reach-your-computer-from-your-phone'],
    },

    {
      slug: 'remote-coding-agent-apps-compared',
      cloud: true,
      title: 'Happy, Grass, CloudCLI and wisp: remote coding agents compared',
      h1: 'Remote coding agent apps compared',
      card: 'Happy, Grass, CloudCLI and wisp all put your coding agents on your phone. Which agents, which phones, where they run, and what it costs.',
      description: 'Happy, Grass, CloudCLI and wisp let you run Claude Code, Codex and other coding agents from your phone. Which agents and phones each supports, where the agents run, licence and price, side by side.',
      lede: 'Happy, Grass, CloudCLI and wisp all let you reach your coding agents from your phone, and they differ in three ways: which agents they drive, where those agents run (your computer, their cloud or both), and whether you can run all of it yourself. Here they are side by side, with what each is best at.',
      shot: ['app', 'The wisp queue with tasks from this computer, a cloud box and other machines, grouped into Needs you, Working and Done'],
      body: `
    <section>
      <h2 id="table">Side by side</h2>
      <div class="table"><table>
        <thead><tr><th></th><th>Happy</th><th>Grass</th><th>CloudCLI</th><th>wisp</th></tr></thead>
        <tbody>
          <tr><th scope="row">Agents</th><td>Claude Code, Codex</td><td>Claude Code, opencode</td><td>Claude Code, Codex, Cursor CLI</td><td>Claude Code, Codex, Cursor, opencode, Grok, Antigravity, Copilot</td></tr>
          <tr><th scope="row">Phone</th><td>iOS, Android, web</td><td>iOS (Android waitlist)</td><td>Phone browser</td><td>Android app, any phone browser</td></tr>
          <tr><th scope="row">Runs on</th><td>Your computer</td><td>Their VM or your computer</td><td>Your computer, or their hosted box</td><td>Your computers, or a cloud box</td></tr>
          <tr><th scope="row">How you connect</th><td>Encrypted relay</td><td>Their service</td><td>Your network, or their cloud</td><td>Grid tunnel (no open port), or SSH</td></tr>
          <tr><th scope="row">Open source</th><td>Yes, MIT</td><td>Not stated</td><td>Yes, AGPL-3.0</td><td>Yes, MIT, server included</td></tr>
          <tr><th scope="row">Price</th><td>Free</td><td>Free to start (10 agent hours)</td><td>Free self-hosted; cloud from €7/month</td><td>Free; wisp Cloud free during the preview</td></tr>
        </tbody>
      </table></div>
      <p class="muted">From each project’s own page, October 2026. They move fast: check before you choose.</p>
    </section>

    <section>
      <h2 id="each">What each is best at</h2>
      <ul class="doc-list">
        <li><b><a href="https://github.com/slopus/happy" target="_blank" rel="noopener">Happy</a></b> wraps the CLI you already use: <code>happy claude</code> or <code>happy codex</code> instead of <code>claude</code>, and the session follows you to a native phone app, end-to-end encrypted. Best when you want your exact terminal session on your phone.</li>
        <li><b><a href="https://codeongrass.com" target="_blank" rel="noopener">Grass</a></b> gives you an always-on VM and an iPhone app with fast permission notifications. Best when you want a hosted box and use Claude Code or opencode.</li>
        <li><b><a href="https://github.com/siteboon/claudecodeui" target="_blank" rel="noopener">CloudCLI</a></b> (<code>npx @cloudcli-ai/cloudcli</code>) is a web UI over your existing Claude Code, Codex and Cursor sessions, with files and git, on port 3001. Best as a browser IDE for your agents on your own network.</li>
        <li><b>wisp</b> sends tasks off rather than mirroring a session: each runs headless in its own worktree, on any of your computers or a cloud box, and comes back as a report with the diff and tests. Best when you run several agents or computers at once and want one queue for all of it.</li>
      </ul>
    </section>

    <section>
      <h2 id="try">Try wisp in a minute</h2>
      ${sh('npx wisp-agents')}
      <p>Then <b>Machines</b> → <i>Reach this computer from anywhere</i> to open it from your phone, or sign in at <a href="https://grid.trywisp.dev" data-cloud-cta="guide-steps">grid.trywisp.dev</a> for a cloud wisp with the agents installed. To run the whole thing on your own server, see <a href="/guides/self-host-wisp-grid.html">Run your own wisp Grid</a>.</p>
    </section>
`,
      faq: [
        ['Which one can I fully self-host?', 'Happy’s relay server is in its repo; CloudCLI runs on your machine; wisp runs on your computers and its grid (the server behind wisp Cloud) is in the same MIT repo, with sign-in and a sandbox per person.'],
        ['Which keeps working with my laptop closed?', 'The ones with a box that stays on: Grass’s VM, CloudCLI’s cloud, wisp Cloud, or any of them on a desktop or server you leave running.'],
        ['Can I use several at once?', 'Yes. They each start or wrap the agent CLIs on your computer and don’t conflict, as long as two agents don’t edit the same folder. wisp gives every task its own git worktree for that reason.'],
        ['Do any of them include model usage?', 'No: all four use your own Claude, ChatGPT or other accounts, and those plans’ limits apply.'],
      ],
      related: ['claude-code-remote-control-alternative', 'use-codex-from-your-phone', 'self-host-wisp-grid'],
    },

    {
      slug: 'self-host-wisp-grid',
      title: 'Self-host coding agents for your team with wisp Grid',
      h1: 'Run your own wisp Grid',
      card: 'One small Linux server, a GitHub or Google sign-in, and every person gets their own sandboxed wisp.',
      description: 'Run wisp Grid, the server behind wisp Cloud (MIT), on one small Linux server: each person signs in with GitHub or Google and gets their own sandboxed wisp.',
      lede: 'wisp Grid is what runs <a href="https://grid.trywisp.dev">wisp Cloud</a>, and it’s in the wisp repo (MIT). Put it on one small Linux server and everyone you let in gets their own wisp at <code>name.wisp.example.com</code>: signed in with GitHub, Google or your company’s OpenID Connect, sandboxed from each other, asleep when idle. grid.trywisp.dev runs on a Hetzner CAX21 (4 Arm vCPUs, 8 GB) for about €12 a month, which is enough for 4 people with agents running at once.',
      figure: `<figure class="doc-shot doc-diagram" aria-label="People sign in at your grid, and each gets their own sandboxed wisp on one server">
  <svg class="wide" viewBox="0 0 960 300" aria-hidden="true">
    <rect x="20" y="60" width="200" height="74" rx="14" class="box"/>
    <text x="120" y="93" text-anchor="middle" class="name">You</text>
    <text x="120" y="117" text-anchor="middle" class="sub">GitHub · Google · SSO</text>
    <rect x="20" y="166" width="200" height="74" rx="14" class="box"/>
    <text x="120" y="199" text-anchor="middle" class="name">Your team</text>
    <text x="120" y="223" text-anchor="middle" class="sub">desktop · phone · browser</text>
    <path d="M220 97 C 290 97, 300 150, 350 150 M220 203 C 290 203, 300 150, 350 150" class="link"/>
    <path d="M338 142 L352 150 L338 158" class="link"/>
    <rect x="360" y="20" width="580" height="260" rx="22" class="zone"/>
    <text x="650" y="52" text-anchor="middle" class="sub">one Linux server · wisp grid serve</text>
    <rect x="390" y="80" width="160" height="170" rx="14" class="box"/>
    <text x="470" y="112" text-anchor="middle" class="name">ada</text>
    <text x="470" y="140" text-anchor="middle" class="sub">sandbox</text>
    <text x="470" y="178" text-anchor="middle" class="mono">her logins</text>
    <rect x="570" y="80" width="160" height="170" rx="14" class="box"/>
    <text x="650" y="112" text-anchor="middle" class="name">bob</text>
    <text x="650" y="140" text-anchor="middle" class="sub">sandbox</text>
    <text x="650" y="178" text-anchor="middle" class="mono">his logins</text>
    <rect x="750" y="80" width="160" height="170" rx="14" class="box"/>
    <text x="830" y="112" text-anchor="middle" class="name">cy</text>
    <text x="830" y="140" text-anchor="middle" class="sub">asleep</text>
    <text x="830" y="178" text-anchor="middle" class="mono">wakes on use</text>
  </svg>
  <svg class="tall" viewBox="0 0 340 470" aria-hidden="true">
    <rect x="10" y="10" width="150" height="70" rx="14" class="box"/>
    <text x="85" y="42" text-anchor="middle" class="name">You</text>
    <text x="85" y="64" text-anchor="middle" class="sub">GitHub · Google</text>
    <rect x="180" y="10" width="150" height="70" rx="14" class="box"/>
    <text x="255" y="42" text-anchor="middle" class="name">Your team</text>
    <text x="255" y="64" text-anchor="middle" class="sub">any device</text>
    <path d="M85 80 C 85 120, 170 110, 170 140 M255 80 C 255 120, 170 110, 170 140" class="link"/>
    <path d="M162 128 L170 142 L178 128" class="link"/>
    <rect x="20" y="150" width="300" height="306" rx="20" class="zone"/>
    <text x="170" y="180" text-anchor="middle" class="sub">one Linux server</text>
    <rect x="45" y="200" width="250" height="64" rx="12" class="box"/>
    <text x="170" y="238" text-anchor="middle" class="name">ada · sandbox</text>
    <rect x="45" y="280" width="250" height="64" rx="12" class="box"/>
    <text x="170" y="318" text-anchor="middle" class="name">bob · sandbox</text>
    <rect x="45" y="360" width="250" height="64" rx="12" class="box"/>
    <text x="170" y="398" text-anchor="middle" class="name">cy · asleep</text>
  </svg>
</figure>`,
      body: `
    <section>
      <h2 id="try">Try it on your computer first</h2>
      ${sh('npx wisp-agents grid dev --fake-agents')}
      <p>Open <code>http://wisp.localhost:8080</code> and sign in with any email (dev sign-in). <code>--fake-agents</code> runs tasks with wisp’s test agents, so nothing needs an account.</p>
    </section>

    <section>
      <h2 id="install">1. Install it on a server</h2>
      <p>Debian 13 or Ubuntu 24.04, with ports 80 and 443 open. Copy the wisp repo there and run, as root:</p>
      ${sh('DOMAIN=wisp.example.com ./grid/deploy/install.sh')}
      <p>It installs Node.js 22, Docker with gVisor, Caddy and some swap, builds the image each person’s wisp runs in (git, <code>gh</code>, Claude Code, Codex, opencode), and sets up the firewall and the service. Then:</p>
      ${sh('sudo -u wisp node bin/wisp.js grid init --domain wisp.example.com --data /var/lib/wisp-grid')}
    </section>

    <section>
      <h2 id="dns">2. Point DNS at it</h2>
      <p>Two <code>A</code> records to the server’s address: <code>wisp</code> and <code>*.wisp</code> (for <code>wisp.example.com</code>). Caddy gets a certificate for each name the first time it’s asked for, after checking with the grid that the name belongs to someone.</p>
    </section>

    <section>
      <h2 id="signin">3. Set up sign-in</h2>
      <ol class="doc-steps">
        <li><b>GitHub:</b> github.com → Settings → Developer settings → OAuth Apps → New. Callback URL: <code>https://wisp.example.com/auth/github/callback</code>.</li>
        <li><b>Google:</b> Google Cloud → APIs &amp; Services → Credentials → OAuth client ID (Web). Redirect URI: <code>https://wisp.example.com/auth/google/callback</code>.</li>
        <li>Put each client id in <code>/var/lib/wisp-grid/grid.json</code> and each secret in its own file under <code>secrets/</code> (<code>chmod 600</code>).</li>
        <li>Decide who gets in: <code>"allow": { "accounts": ["github:you"], "domains": ["example.com"], "githubOrgs": ["your-org"] }</code>.</li>
        <li>Turn on the sandbox: <code>"hostd": { "driver": "container" }</code>.</li>
      </ol>
      ${sh('sudo -u wisp node bin/wisp.js grid doctor --data /var/lib/wisp-grid\nsudo systemctl enable --now wisp-grid')}
    </section>

    <section>
      <h2 id="isolation">How people are kept apart</h2>
      <ul class="doc-list">
        <li>Each person’s wisp runs in its own Docker container with gVisor, a user-space kernel between the agents and the host’s, with no capabilities and limits on memory, CPU and processes.</li>
        <li>Only its own home folder persists. The firewall blocks traffic between containers, to the host, to the cloud metadata service and to mail servers.</li>
        <li>Sign-in uses PKCE, state and checked ID tokens; each person’s cookie only works on their own address; devices sign in with a code and can be removed from the account page.</li>
        <li>Secrets the grid keeps are encrypted per person under a master key you can rotate (<code>wisp grid rotate-key</code>). Agents’ logins never leave the person’s own folder.</li>
      </ul>
    </section>
`,
      faq: [
        ['How big a server do I need?', 'About 2 GB of memory per person with an agent running. A 4-core, 8 GB machine with swap handles 4 people at once.'],
        ['Does it need KVM or bare metal?', 'No. gVisor runs on ordinary cloud VMs, Arm or x86.'],
        ['Can people use the desktop and phone apps with my grid?', 'Yes. In Settings → Cloud, or on the phone app’s first screen, they type your grid’s address instead of grid.trywisp.dev.'],
        ['Where is the full reference?', 'grid/README.md in the wisp repo: commands, configuration, secrets and isolation.'],
      ],
      related: ['use-wisp-cloud', 'run-coding-agents-on-multiple-machines', 'connect-machines-with-tailscale'],
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
      <p>Panels open as a <code>dialog</code>, a side <code>drawer</code>, pinned on home (<code>feed</code>, under the prompt box), or inside an open <code>card</code>. To restyle or hide something, a spell names a part (<code>card.title</code>, <code>launcher.input</code>, <code>topbar.machines</code>, …) and sets a short list of allowed CSS properties, props such as <code>density</code> or <code>monospace</code>, or the order of the card head.</p>
      <p>The split view (tasks in a sidebar, the open one beside it; on a phone the open one is a page with Back) is a spell’s too: the <code>sidebar</code> part takes <code>width</code>, <code>side</code> (<code>left</code>, the default, or <code>right</code>) and <code>details</code> (<code>full</code> shows the model, machine and project on every row), <code>split.main</code> takes a <code>readWidth</code>, <code>split.home</code> a <code>greeting</code> over the prompt box, <code>split.details</code> (the open task’s details column, with its PR and actions) a <code>width</code>, and the <code>sidebar.top</code>, <code>split.head</code> and <code>split.details</code> slots take buttons.</p>
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
        ['Which agents can cast spells?', 'Any harness wisp runs: Claude Code, Codex, opencode, Cursor, Antigravity, Grok or Copilot. The agent works in an empty folder of its own and uses wisp’s spell tools to read the reference and check its spell.'],
        ['Can a spell I get from someone else run code on my computer?', 'Only if it says so: a spell whose buttons run commands is marked Runs commands and lists each command, and asks before the first run. Spell scripts run in a sandbox with no network or file access.'],
        ['Can I write a spell by hand?', 'Yes. Write the JSON, then run wisp spell install ./my.spell.json: wisp checks it the same way it checks a cast spell and tells you, in plain words, what it does or what is wrong.'],
        ['What if I ask for something spells can’t do?', 'The agent says so in its report and does the closest thing spells can. Spells can only use the slots, parts, actions and data sources in wisp’s reference, so they can’t reach further than that.'],
      ],
      related: ['run-coding-agents-in-the-background', 'multi-agent-coding', 'run-claude-code-and-codex-in-parallel'],
    },

    {
      slug: 'use-work-and-personal-claude-code-accounts',
      title: 'Use your work and personal Claude Code accounts in one place — wisp',
      h1: 'Use your work and personal Claude Code accounts',
      card: 'Your work and personal Claude Code or Codex accounts in one app: pick one per task, and wisp asks when one runs out.',
      description: 'Sign in to a second Claude Code or Codex account, say your own plan and your employer’s, and pick which one each task runs on. Each keeps its own limits; wisp never switches on its own.',
      lede: 'Claude Code keeps its login in one folder, and <code>CLAUDE_CONFIG_DIR</code> points it at another, so a second account is a second folder. wisp sets that up for you: add the account in Settings → Agents, pick it per task, and when one reaches its limit the task asks you what to do.',
      shot: ['limit', 'A wisp task whose Work account reached its usage limit: Wait until the reset, Continue on Personal, Hand to Codex or Get extra usage'],
      body: `
    <section>
      <h2 id="manual">The manual way</h2>
      ${sh(`# a second login in a folder of its own
CLAUDE_CONFIG_DIR=~/.claude-personal claude auth login

# then run each session on the account you mean
claude                                        # your usual account
CLAUDE_CONFIG_DIR=~/.claude-personal claude   # the other one`)}
      <p>Codex works the same way with <code>CODEX_HOME</code>. Things to know: the second folder starts empty, so your settings, skills, MCP servers and past sessions aren’t there, and you have to remember which shell runs which account.</p>
    </section>

    <section>
      <h2 id="with-wisp">With wisp</h2>
      <ol class="doc-steps">
        <li><b>Start wisp.</b> ${installButton()}</li>
        <li><b>Add the account.</b> Settings → Agents → <b>Add another Claude account</b> (or Codex). Name it, say whether it’s personal or work, and sign in with the CLI’s own sign-in: a link and a code, no terminal. wisp never sees your password.</li>
        <li><b>Everything but the login is shared.</b> The new account’s folder (<code>~/.wisp/accounts/claude/&lt;id&gt;</code>) links to your usual one for settings, skills, MCP servers and transcripts. The login stays separate.</li>
        <li><b>Pick the account per task.</b> The runner picker has an <i>Account</i> row under Thinking, and the reply box can switch a task to the other account from its next follow-up. wisp remembers your pick per harness, and the task’s details say which account ran it.</li>
      </ol>
    </section>

    <section>
      <h2 id="limits">When an account reaches its limit</h2>
      <p>Each account keeps its own usage limits, and wisp doesn’t combine them. When one runs out, the task stops and asks: <b>wait</b> until the reset (wisp sends the follow-up then), <b>continue</b> on another of your accounts in the same conversation, <b>hand</b> the task to another agent like <a href="/agents/codex.html">Codex</a>, or get <b>extra usage</b> from the provider. Moving a conversation between a work and a personal account says so first, since its code goes with it.</p>
      <p>wisp never switches accounts on its own, and tasks that run without you (crew members, schedules, subagents) stay on the account you picked.</p>
    </section>

    <section>
      <h2 id="allowed">Which accounts to add</h2>
      <p>Only accounts that are yours: your own plan, or a seat your employer gave you. Sharing a login with someone else is against Anthropic’s and OpenAI’s terms and can get the account closed. Before you use a work account on personal projects, or the other way round, check your employer’s rules. For heavy automated use, the providers ask you to use an API key, which wisp supports too.</p>
    </section>
`,
      faq: [
        ['Which agents can have more than one account?', 'Claude Code and Codex, the two whose login lives in one folder you can point elsewhere (CLAUDE_CONFIG_DIR, CODEX_HOME).'],
        ['Does wisp switch to my other account when I hit a limit?', 'No. The task asks you: wait for the reset, continue on another of your accounts, hand it to another agent, or get extra usage from the provider.'],
        ['Does the second account see my MCP servers and skills?', 'Yes. Its folder links to your usual one for everything except the login, and its settings file copies your MCP servers without who is signed in.'],
        ['Can my team share one Claude account through wisp?', 'No. Each person signs in with their own account; Anthropic’s and OpenAI’s terms don’t allow sharing a login.'],
      ],
      related: ['run-multiple-claude-code-agents-in-parallel', 'claude-code-vs-codex', 'run-coding-agents-in-the-background'],
    },

    {
      slug: 'share-crew-members',
      title: 'Share an AI coding agent with your team: wisp crew members',
      h1: 'Share a crew member with your team',
      card: 'A CI watcher or PR reviewer you tuned, as a file or a link: they import it, pick a project, and it starts paused.',
      description: 'Share a wisp crew member, a long-lived coding agent with a brief, schedule and skills, as a .crew.json file, a secret gist or a spell. Teammates import it in one step.',
      lede: 'A crew member in wisp is a long-lived agent with a name, a brief, a schedule and its own skills: a CI watcher, a PR reviewer. Once one works well, share it. <b>Share…</b> gives a <code>.crew.json</code> file, a secret gist or a spell, and your teammate imports it with a review of what it does. It arrives paused, in a project they pick.',
      figure: `<figure class="doc-shot"><pre data-lang="json"><code>${esc(JSON.stringify({ wispCrew: 1, members: [{ key: TEMPLATES[1].key, name: TEMPLATES[1].name, role: TEMPLATES[1].role, avatar: TEMPLATES[1].avatar, brief: TEMPLATES[1].brief, cron: TEMPLATES[1].cron, on: [], mode: 'plan', kit: [{ kind: 'skill', name: 'read-ci-logs', description: 'When a CI run failed', body: '1. gh run view <id> --log-failed\n2. …' }] }] }, null, 2))}</code></pre><figcaption>scout.crew.json: who the member is. Never a folder, a computer or what they did.</figcaption></figure>`,
      body: `
    <section>
      <h2 id="share">Share one</h2>
      <ol class="doc-steps">
        <li>Open the member and press <b>Share…</b> (its ⋯ menu, right-click, or ⌘K → <i>Share Scout…</i>).</li>
        <li>Choose what goes: their skills and instructions (on), their notebook (off: it holds what they learned about your code), and the crew members they delegate to.</li>
        <li><b>Copy</b> it for a chat, <b>Download</b> the <code>.crew.json</code>, or <b>Create a gist</b>: a secret gist on your GitHub account, after you confirm. <b>As a spell</b> saves a spell that brings them.</li>
      </ol>
      <p>Before anything leaves, wisp scans the brief, notebook and skills for API keys, tokens and private keys, and won’t share one it finds; it tells you the line.</p>
      ${sh('wisp crew export scout > scout.crew.json\nwisp crew export scout --team --gist      # with their delegates, as a secret gist')}
    </section>

    <section>
      <h2 id="import">Import one</h2>
      <p>Drop the file on wisp, or paste it or the link into <b>Import…</b> (the last chip under <i>Start from</i> when you add a member). The review shows each member with the name they get (a clash becomes <i>Scout 2</i>), the harness they’ll use here, their brief and skills, and the project they work in. One that starts when CI fails needs a project. They join paused: press Resume when you’re ready.</p>
      ${sh('wisp crew import gist:3f2a9c…\nwisp crew import https://trywisp.dev/crew/ci.crew.json')}
      <p>Or ask any agent in wisp: <i>add the member from gist:3f2a9c…</i>.</p>
    </section>

    <section>
      <h2 id="gallery">Ready-made members</h2>
      <p>The members wisp offers under <i>Start from</i>, as files you can import:</p>
      <ul class="doc-list">${TEMPLATES.map((t) => `<li><b>${esc(t.name)} · ${esc(t.role)}</b> (<a href="/crew/${t.key}.crew.json">${t.key}.crew.json</a>): ${esc(t.brief)}</li>`).join('')}</ul>
    </section>

    <section>
      <h2 id="spells">For a team: a spell that keeps them up to date</h2>
      <p>A spell can bring crew members (<code>crew</code> in the spell). The spell owns who they are and updates them when you publish a new version; each person picks the project and keeps the notebook. When an update changes what a member does, wisp pauses them and shows the change on Resume.</p>
    </section>
`,
      faq: [
        ['What does a shared member include?', 'Their name, face, role, brief, schedule, what else starts them, mode, harness and delegates, and if you tick them, their skills and instructions and notebook. Never their project folder, computer, log or jobs.'],
        ['Is the gist public?', 'No. wisp creates a secret gist with your gh login and asks first. It isn’t listed on your profile, but anyone with its link can read it.'],
        ['What if my teammate doesn’t have the same harness?', 'The review says so, and the member runs on Auto, which picks a harness they have.'],
        ['Can a shared member run on its own straight away?', 'No. Imported members start paused, and a member from a spell shows you what it does before its first Resume.'],
      ],
      related: ['customize-wisp-with-spells', 'run-coding-agents-in-the-background', 'multi-agent-coding'],
    },
  ];
}
