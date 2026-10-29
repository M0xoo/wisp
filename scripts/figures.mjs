// Motion figures for the guides: small scenes that show how a thing works, one step at a time,
// with a sentence under them saying what just happened. docs/guide.js plays them (while on screen,
// never for reduced motion) and docs/guide.css draws them.
//
// A part shows from step `at` until step `until`; `v` is a comma list of --v values per step (bars),
// `text` a |-list of texts per step, `add` "step:class" pairs. Keep scenes to plain HTML so they
// reflow on a phone: chains and fans turn vertical under 640px.

const A = ({ at, until, v, text, add } = {}) =>
  (at != null ? ` data-at="${at}"` : '') +
  (until != null ? ` data-until="${until}"` : '') +
  (v != null ? ` data-v="${v}"` : '') +
  (text != null ? ` data-text="${text}"` : '') +
  (add ? ` data-add="${add}"` : '');

const node = (inner, o = {}) => `<div class="mf-node${o.cls ? ` ${o.cls}` : ''}"${A(o)}>${inner}</div>`;
const head = (title, sub = '') => `<span class="mf-hd"><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</span>`;
const chip = (text, cls = '', o = {}) => `<span class="mf-chip${cls ? ` ${cls}` : ''}"${A(o)}>${text}</span>`;
const swap = (...items) => `<span class="mf-swap">${items.join('')}</span>`;
// Cards that take turns in one place, so nothing leaves a hole when it goes.
const slot = (...items) => `<div class="mf-slot">${items.join('')}</div>`;
const row = (...items) => `<div class="mf-row">${items.join('')}</div>`;
const mono = (text, o = {}) => `<span class="mf-mono${o.cls ? ` ${o.cls}` : ''}"${A(o)}>${text}</span>`;
const bar = (v, cls = '') => `<span class="mf-bar${cls ? ` ${cls}` : ''}"><i${A({ v })}></i></span>`;
// A line between two parts. pk: steps a dot travels it ([at, until]); back: from the far end.
const wire = ({ pk = [], back = [], label = '', cls = '', add } = {}) =>
  `<span class="mf-wire${cls ? ` ${cls}` : ''}"${A({ add })}>${pk.map(([at, until]) => `<i class="pk"${A({ at, until })}></i>`).join('')}${back.map(([at, until]) => `<i class="pk back"${A({ at, until })}></i>`).join('')}${label ? `<em>${label}</em>` : ''}</span>`;
const fan = (src, lanes, { pk = [], back = [] } = {}) =>
  `<div class="mf-fan">${src}${wire({ pk, back, cls: 'mf-feed' })}<div class="mf-lanes">${lanes.join('')}</div></div>`;
const lane = (inner, { pk = [], back = [], add } = {}) => `<div class="mf-lane"${A({ add })}>${wire({ pk, back })}${inner}</div>`;
const tap = (text, o = {}) => `<span class="mf-btn"${A(o)}>${text}</span>`;

// say: [[step, sentence], …]; each sentence shows until the next one.
function fig({ label, steps, ms = 1500, stage, say, cls = '' }) {
  const lines = say.map(([at], i) => [at, say[i + 1]?.[0]]);
  const sr = `${label} ${say.map(([, t]) => t.replace(/<[^>]+>/g, '')).join(' ')}`;
  return `<figure class="mfig${cls ? ` ${cls}` : ''}" data-steps="${steps}" data-ms="${ms}">
  <div class="mf-stage" role="img" aria-label="${sr.replace(/"/g, '&quot;')}">${stage}</div>
  <figcaption>
    <button class="mf-play" type="button" aria-label="Pause the animation" title="Pause the animation"><svg viewBox="0 0 16 16" aria-hidden="true"><path class="i-pause" d="M5 3.5v9M11 3.5v9"/><path class="i-play" d="M5.5 3.5v9l7-4.5z"/></svg></button>
    <span class="mf-says" aria-hidden="true">${say.map(([, t], i) => `<span class="mf-say"${A({ at: lines[i][0], until: lines[i][1] })}>${t}</span>`).join('')}</span>
    <span class="mf-dots">${say.map(([, t], i) => `<button type="button" data-step="${lines[i][0]}"${lines[i][1] != null ? ` data-end="${lines[i][1]}"` : ''} aria-label="Step ${i + 1}: ${t.replace(/<[^>]+>/g, '').replace(/"/g, '&quot;')}"></button>`).join('')}</span>
  </figcaption>
</figure>`;
}

// ---------- the scenes ----------

export const FIGURES = {
  // Claude Code and Codex in parallel: one prompt, a worktree each, compare, keep one.
  parallel: fig({
    label: 'One prompt goes to Claude Code and Codex, each in its own worktree; their tests are compared and one is kept.',
    steps: 6,
    stage: fan(
      node(`${head('One prompt', 'from origin/main')}${mono('fix the flaky auth test')}${row(chip('Claude Code'), chip('vs', 'accent'), chip('Codex'))}`, { cls: 'src' }),
      [
        lane(node(`${row(head('Claude Code', '../app-claude · try/claude'), swap(chip('Working', 'go', { at: 2, until: 4 }), chip('341 passed', 'ok', { at: 4 })))}${bar('0,0,.45,.8,1')}${row(chip('16m · $0.94'), chip('Keep this', 'accent pop', { at: 5 }))}`, { at: 1 }), { pk: [[1, 2]], add: '5:win' }),
        lane(node(`${row(head('Codex', '../app-codex · try/codex'), swap(chip('Working', 'go', { at: 2, until: 4 }), chip('2 failing', 'bad', { at: 4 })))}${bar('0,0,.6,1,1', 'done-early')}${row(chip('11m · $0.38'), chip('Worktree removed', '', { at: 5 }))}`, { at: 1 }), { pk: [[1, 2]], add: '5:dim' }),
      ],
      { pk: [[1, 2]] },
    ),
    say: [
      [0, 'You type the task once and click <b>vs</b>.'],
      [1, 'wisp makes a worktree and a branch per agent, from <code>origin/main</code>.'],
      [2, 'Both agents work at the same time, each in its own folder.'],
      [4, 'Compare lines them up: the project’s tests, time, cost and the diff.'],
      [5, '<b>Keep this</b> keeps the winner and deletes the other worktree.'],
    ],
  }),

  // Agents on several machines over SSH, one queue on the laptop.
  machines: fig({
    label: 'A laptop sends one prompt to three machines over SSH; each runs its agent and reports back into the laptop’s queue, even while the laptop is closed.',
    steps: 6,
    stage: fan(
      node(`${head('Your laptop', 'one queue')}${swap(chip('Run on: 3 machines', '', { at: 0, until: 2 }), chip('3 working', 'go', { at: 2, until: 4 }), chip('Lid closed', 'warn', { at: 4, until: 5 }), chip('3 reports waiting', 'ok', { at: 5 }))}`, { cls: 'src', add: '4:dim' }),
      [
        lane(node(`${row(head('devbox', 'Linux · Claude Code'), swap(chip('Starting wisp', '', { at: 1, until: 2 }), chip('Working', 'go', { at: 2, until: 3 }), chip('Done', 'ok', { at: 3 })))}`), { pk: [[1, 2]], back: [[3, 4]] }),
        lane(node(`${row(head('gpu-box', 'Ubuntu · Codex'), swap(chip('Starting wisp', '', { at: 1, until: 2 }), chip('Working', 'go', { at: 2, until: 5 }), chip('Done', 'ok', { at: 5 })))}`), { pk: [[1, 2]], back: [[5, 6]] }),
        lane(node(`${row(head('mac-mini', 'macOS · Claude Code'), swap(chip('Starting wisp', '', { at: 1, until: 2 }), chip('Working', 'go', { at: 2, until: 4 }), chip('Done', 'ok', { at: 4 })))}`), { pk: [[1, 2]], back: [[4, 5]] }),
      ],
      { pk: [[1, 2]] },
    ),
    say: [
      [0, 'One prompt, three machines picked in <b>Run on</b>.'],
      [1, 'wisp signs in with your SSH key and starts itself there, on <code>127.0.0.1</code>.'],
      [2, 'Each machine runs its agent in a worktree of its own.'],
      [3, 'Reports come back through the SSH tunnel into one queue.'],
      [4, 'Close the laptop: the machines keep working.'],
      [5, 'Open it again and the reports are waiting.'],
    ],
  }),

  // Tailscale: laptop and phone reach the machine over SSH inside the tailnet.
  tailscale: fig({
    label: 'A laptop and a phone reach a machine over SSH inside a private tailnet; wisp installs Node.js and starts itself there on 127.0.0.1.',
    steps: 5,
    stage: `<div class="mf-chain">
      <div class="mf-stack">${node(head('Laptop', 'wisp · Machines'))}${node(head('Phone', 'wisp app'))}</div>
      ${wire({ cls: 'stub' })}
      <div class="mf-zone"><span class="mf-label">your tailnet · private, encrypted</span>${wire({ pk: [[1, 2]], label: 'ssh you@devbox', add: '1:lit' })}</div>
      ${wire({ cls: 'stub' })}
      ${node(`${head('devbox', 'macOS or Linux')}${mono('sshd :22')}${chip('Node.js 22 in ~/.wisp/node', 'ok', { at: 2 })}${chip('wisp on 127.0.0.1:4477', 'ok', { at: 3 })}${chip('Connected', 'accent pop', { at: 4 })}`)}
    </div>
    <div class="mf-foot">${chip('Nothing open to the internet', '', { at: 4 })}</div>`,
    say: [
      [0, 'Laptop, phone and the machine sign in to the same tailnet.'],
      [1, 'wisp connects by the machine’s tailnet name, over SSH.'],
      [2, 'No Node.js there? wisp installs it, no admin needed.'],
      [3, 'wisp starts on the machine and listens only on its own <code>127.0.0.1</code>.'],
      [4, 'Only SSH is reachable, and only inside your tailnet.'],
    ],
  }),

  // Moving a task: branch, uncommitted work and turns travel as a bundle.
  move: fig({
    label: 'A task on a laptop is packed (branch, uncommitted files, earlier turns) into a git bundle, carried to a dev box, and continued there by Codex.',
    steps: 7,
    stage: `<div class="mf-chain">
      ${node(`${row(head('MacBook', 'Stripe v2 · Claude Code'), swap(chip('Stopped', '', { until: 5 }), chip('Continues on devbox', '', { at: 5 })))}
        ${mono('branch wisp/stripe-v2', { at: 1 })}${mono('3 uncommitted files', { at: 2 })}${mono('4 earlier turns', { at: 3 })}`, { add: '5:dim' })}
      ${wire({ pk: [[4, 5]], label: 'git bundle', add: '4:lit' })}
      ${node(`${row(head('devbox', 'Stripe v2 · Codex'), swap(chip('From MacBook', '', { at: 5, until: 6 }), chip('Working', 'go', { at: 6 })))}
        ${mono('same branch, new worktree', { at: 5 })}${mono('files still uncommitted', { at: 5 })}${mono('turns written ahead of your follow-up', { at: 6 })}`, { at: 4 })}
    </div>`,
    say: [
      [0, 'A task stopped mid-way on the laptop. You pick <b>devbox</b> and <b>Codex</b> and send a follow-up.'],
      [1, 'wisp packs the branch,'],
      [2, 'the uncommitted and untracked files,'],
      [3, 'and what happened so far.'],
      [4, 'All of it travels as one git bundle. Your own checkout isn’t touched.'],
      [5, 'On the dev box: a worktree on the same branch, the changes still uncommitted.'],
      [6, 'Codex starts on your follow-up with the earlier turns in front of it.'],
    ],
  }),

  // Why worktrees: one folder collides, a worktree each doesn't.
  worktrees: fig({
    label: 'Two Claude Code sessions in one folder overwrite each other’s files; with a worktree each, both work on their own branch and their tests pass.',
    steps: 4,
    cls: 'mf-pairfig',
    stage: `<div class="mf-pair">
      <div class="mf-panel"><span class="mf-label">One folder</span>
        <div class="mf-zone tight"><span class="mf-label">app/</span>
          ${row(chip('Claude #1'), wire({ pk: [[1, 2]] }), mono('auth.ts', { add: '2:clash' }))}
          ${row(chip('Claude #2'), wire({ pk: [[1, 2]] }), mono('auth.ts', { add: '2:clash' }))}
        </div>
        ${chip('#2 overwrote #1’s edit', 'bad', { at: 2 })}${chip('Tests run on half-finished code', 'bad', { at: 3 })}
      </div>
      <div class="mf-panel"><span class="mf-label">A worktree each</span>
        <div class="mf-zone tight"><span class="mf-label">app-auth/ · fix/auth</span>${row(chip('Claude #1'), wire({ pk: [[1, 2]] }), mono('auth.ts'))}</div>
        <div class="mf-zone tight"><span class="mf-label">app-stripe/ · feat/stripe</span>${row(chip('Claude #2'), wire({ pk: [[1, 2]] }), mono('billing.ts'))}</div>
        ${chip('Each edit on its own branch', 'ok', { at: 2 })}${chip('Each test run sees its own code', 'ok', { at: 3 })}
      </div>
    </div>`,
    say: [
      [0, 'Two Claude Code sessions, two ways to give them room.'],
      [1, 'Both start editing.'],
      [2, 'In one folder they write over each other. In worktrees they can’t.'],
      [3, 'And each worktree’s tests run against its own changes only.'],
    ],
  }),

  // Claude Code vs Codex: the scoreboard fills in.
  versus: fig({
    label: 'Claude Code and Codex run the same task; time, cost and files tick up, Codex finishes first, the tests decide, and one run is kept.',
    steps: 6,
    stage: `<div class="mf-pair">
      ${['claude', 'codex'].map((k) => {
        const c = k === 'claude';
        return node(`${row(head(c ? 'Claude Code' : 'Codex', c ? 'try/claude' : 'try/codex'), swap(chip('Working', 'go', { until: c ? 4 : 3 }), chip('Finished', '', { at: c ? 4 : 3 })))}
        <dl class="mf-stats">
          <div><dt>Time</dt><dd${A({ text: c ? '0m|4m|9m|13m|16m' : '0m|3m|7m|11m' })}></dd></div>
          <div><dt>Cost</dt><dd${A({ text: c ? '$0.00|$0.22|$0.51|$0.74|$0.94' : '$0.00|$0.11|$0.26|$0.38' })}></dd></div>
          <div><dt>Files</dt><dd${A({ text: c ? '0|2|4|5|6' : '0|1|2|3' })}></dd></div>
          <div><dt>Asked you</dt><dd${A({ text: c ? '0|0|1|1' : '0' })}></dd></div>
        </dl>
        ${swap(chip(c ? '341 passed' : '339 passed, 2 failing', c ? 'ok' : 'bad', { at: 4 }))}
        ${chip(c ? 'Keep this' : 'Archived', c ? 'accent pop' : '', { at: 5 })}`, { add: c ? '5:win' : '5:dim' });
      }).join('')}
    </div>`,
    say: [
      [0, 'Same task, same repo, a branch each.'],
      [1, 'Time, cost and files tick up per agent.'],
      [3, 'Codex finishes first and costs less.'],
      [4, 'The project’s own tests decide, not the agents’ claims.'],
      [5, 'You keep the diff you’d merge, and the other is archived.'],
    ],
  }),

  // A lead delegating to a team.
  delegate: fig({
    label: 'A Claude Code lead hands tests to two Codex members, docs to opencode and a refactor to Claude Code on a GPU box; their edits come back into the lead’s one diff.',
    steps: 6,
    stage: fan(
      node(`${head('Lead · Claude Code', 'plans, reviews, ships')}${swap(chip('Planning', 'go', { until: 1 }), chip('delegate ×4', 'accent', { at: 1, until: 2 }), chip('Waiting on its team', '', { at: 2, until: 4 }), chip('Reviewing', 'go', { at: 4, until: 5 }), chip('+412 −88 · one PR', 'ok', { at: 5 }))}`, { cls: 'src' }),
      [
        lane(node(row(head('codex#1', 'Codex · tests/auth'), swap(chip('Working', 'go', { at: 2, until: 4 }), chip('Report', 'ok', { at: 4 })))), { pk: [[1, 2]], back: [[4, 5]] }),
        lane(node(row(head('codex#2', 'Codex · tests/billing'), swap(chip('Working', 'go', { at: 2, until: 4 }), chip('Report', 'ok', { at: 4 })))), { pk: [[1, 2]], back: [[4, 5]] }),
        lane(node(row(head('docs', 'opencode · README, changelog'), swap(chip('Working', 'go', { at: 2, until: 3 }), chip('Report', 'ok', { at: 3 })))), { pk: [[1, 2]], back: [[3, 4]] }),
        lane(node(row(head('heavy', 'Claude Code · on gpu-box'), swap(chip('Copy of the lead’s work', '', { at: 1, until: 2 }), chip('Working', 'go', { at: 2, until: 4 }), chip('Patch back', 'ok', { at: 4 })))), { pk: [[1, 2]], back: [[4, 5]] }),
      ],
      { pk: [[1, 2]] },
    ),
    say: [
      [0, 'The lead reads the task and plans the change.'],
      [1, 'One <code>delegate</code> call hands out four parts.'],
      [2, 'The members work in parallel: with the lead, or on your other machines.'],
      [3, 'Each comes back with a report and the files it changed.'],
      [5, 'Their edits are the lead’s: one diff, one checkpoint list, one pull request.'],
    ],
  }),

  // Background: three headless tasks, one question from the phone, reports in the morning.
  background: fig({
    label: 'Three tasks run headless; one asks a question that is answered from the phone; each ends with a notification and a one-screen report.',
    steps: 6,
    cls: 'mf-pairfig',
    stage: `<div class="mf-pair">
      <div class="mf-panel"><span class="mf-label" ${A({ text: '18:02 · your queue|19:40 · your queue|19:41 · your queue|21:15 · your queue|23:58 · your queue|07:30 · your queue' })}></span>
        ${['auth-fix', 'deps-audit', 'bump-node'].map((t, i) => node(row(head(t, ['Claude Code · Edits', 'Codex · Plan', 'opencode · Full auto'][i]), swap(
          ...(i === 0 ? [chip('Working', 'go', { until: 1 }), chip('Needs you', 'warn', { at: 1, until: 2 }), chip('Working', 'go', { at: 2, until: 4 }), chip('Done', 'ok', { at: 4 })]
            : i === 1 ? [chip('Working', 'go', { until: 3 }), chip('Done', 'ok', { at: 3 })]
              : [chip('Working', 'go', { until: 2 }), chip('Done', 'ok', { at: 2 })]),
        )), { cls: 'slim', add: i === 0 ? '1:hot,2:cool' : '' })).join('')}
      </div>
      <div class="mf-phone">
        <span class="mf-label">your phone</span>
        ${slot(node(`${head('auth-fix asks', 'Keep the v1 token format for old clients?')}${row(tap('Keep v1', { add: '2:tapped' }), tap('Drop it'))}`, { at: 1, until: 3, cls: 'note' }), node(head('auth-fix · Done', '12 files · 341 tests pass · Ship it'), { at: 4, cls: 'note' }))}
        ${node(head('bump-node · Done', 'Node 22 · 9 files · tests pass'), { at: 2, cls: 'note' })}
        ${node(head('deps-audit · Report', '3 outdated, 1 advisory · nothing changed'), { at: 3, cls: 'note' })}
      </div>
    </div>`,
    say: [
      [0, '18:02 · three tasks start headless, a worktree each. You go home.'],
      [1, '19:40 · one needs a decision. It asks instead of guessing.'],
      [2, 'You answer from the phone and the run picks up where it paused.'],
      [3, 'Each finished task sends one notification.'],
      [5, '07:30 · a one-screen report each: headline, diff, tests. No transcripts.'],
    ],
  }),

  // A goal: rounds, checks and the one ping.
  goal: fig({
    label: 'A task with a goal: the agent works a round, wisp runs the tests and reads the diff, sends it back with what is missing, until the goal is met.',
    steps: 8,
    ms: 1400,
    stage: `<div class="mf-goal">
      ${row(`<span class="mf-done-when"><b>Done when</b> every test in <code>test/auth</code> passes</span>`, `<span class="mf-round"${A({ text: 'Round 0|Round 1|Round 1|Round 2|Round 2|Round 3|Round 3|Round 3' })}></span>`)}
      ${bar('0,0,.3,.3,.7,.7,1,1', 'goalbar')}
      <div class="mf-chain">
        ${node(`${head('The agent', 'any harness')}${chip('', 'go', { text: 'Waiting|Working|Done for now|Working|Done for now|Working|Done for now|Done' })}`)}
        ${wire({ pk: [[2, 3], [4, 5], [6, 7]], add: '2:lit' })}
        ${node(`${head('wisp checks', 'outside the agent')}${mono('', { text: 'tests: not run yet|tests: not run yet|38 of 41 pass|38 of 41 pass|40 of 41 pass|40 of 41 pass|41 of 41 pass' })}${mono('diff read by a read-only model', { at: 2 })}`)}
        ${wire({ pk: [[2, 3], [4, 5], [6, 7]] })}
        ${node(`${head('Verdict')}${swap(chip('–', '', { until: 2 }), chip('Not yet · 3 failing', 'bad', { at: 2, until: 4 }), chip('Not yet · 1 failing', 'bad', { at: 4, until: 6 }), chip('Met', 'ok', { at: 6 }))}${chip('Needs you · one ping', 'accent pop', { at: 7 })}`)}
      </div>
      <div class="mf-return">${wire({ back: [[3, 4], [5, 6]], label: 'back to the agent with what’s missing' })}</div>
    </div>`,
    say: [
      [0, 'You write what has to be true, not what to do.'],
      [1, 'The agent works its round and stops when it thinks it’s done.'],
      [2, 'wisp runs the tests itself, and a read-only model reads the diff.'],
      [3, 'Not yet: the task goes back with what’s missing and the next step.'],
      [6, 'Met, on evidence the checker saw for itself.'],
      [7, 'Only now does it land in <b>Needs you</b>, with one notification.'],
    ],
  }),

  // 24/7: the laptop's run stops at the lid; the cloud's keeps going.
  overnight: fig({
    label: 'The same task on a laptop and on wisp Cloud: the laptop’s run stops when the lid closes at 18:40; the cloud run keeps going and the report is ready at 02:14.',
    steps: 6,
    stage: `<div class="mf-tl">
      <div class="mf-clock"${A({ text: '18:00|18:40|21:00|00:30|02:14|07:30' })}></div>
      <div class="mf-track"><span class="mf-tname"><b>Laptop</b><small>Claude Code in a terminal</small></span>
        <span class="mf-lane-bar"><i class="mf-seg"${A({ v: '0,.045' })}></i><span class="mf-mark" style="--x:.045"${A({ at: 1 })}>lid closes · run stops</span></span></div>
      <div class="mf-track"><span class="mf-tname"><b>wisp Cloud</b><small>your box on a server</small></span>
        <span class="mf-lane-bar"><i class="mf-seg"${A({ v: '0,.045,.2,.43,.55' })}></i><span class="mf-mark ok" style="--x:.55"${A({ at: 4 })}>02:14 · report ready</span></span></div>
      <div class="mf-axis"><span>18:00</span><span>21:00</span><span>00:00</span><span>03:00</span><span>06:00</span><span>09:00</span></div>
      <div class="mf-foot">${chip('Read on your phone · Ship it', 'accent pop', { at: 5 })}</div>
    </div>`,
    say: [
      [0, '18:00 · the same task starts on the laptop and on wisp Cloud.'],
      [1, '18:40 · the lid closes, and the laptop’s run stops with it.'],
      [2, 'The cloud box doesn’t have a lid. It keeps going.'],
      [4, '02:14 · done. The report waits for you.'],
      [5, '07:30 · you read it on your phone over coffee.'],
    ],
  }),

  // wisp Cloud: sign in, connect agents, close the laptop.
  cloud: fig({
    label: 'Your laptop, phone and browser open your own wisp on grid.trywisp.dev; it runs tasks with the laptop closed and sleeps when idle.',
    steps: 6,
    stage: `<div class="mf-chain">
      <div class="mf-stack">${node(head('Laptop', 'Machines'), { add: '4:dim' })}${node(`${head('Phone', 'wisp app')}${chip('Report ready', 'ok', { at: 4 })}`)}${node(head('Browser', 'any computer'))}</div>
      ${wire({ pk: [[1, 2], [3, 4]], add: '1:lit' })}
      <div class="mf-zone"><span class="mf-label">grid.trywisp.dev · GitHub or Google</span>
        ${node(`${row(head('you.grid.trywisp.dev', 'a gVisor sandbox of its own'), swap(chip('Asleep', '', { until: 1 }), chip('Starting', 'go', { at: 1, until: 2 }), chip('Ready', '', { at: 2, until: 3 }), chip('2 tasks running', 'go', { at: 3, until: 5 }), chip('Asleep · wakes in seconds', '', { at: 5 })))}
          ${row(chip('Claude Code', 'ok', { at: 2 }), chip('Codex', 'ok', { at: 2 }), chip('gh', 'ok', { at: 2 }))}`)}
      </div>
    </div>`,
    say: [
      [0, 'Your own wisp on a server, asleep until something needs it.'],
      [1, 'Sign in with GitHub or Google and it starts in a few seconds.'],
      [2, 'Claude Code, Codex and <code>gh</code> sign in with a code. The logins stay in your box.'],
      [3, 'Give it tasks, then close the laptop.'],
      [4, 'They keep running. The report reaches your phone.'],
      [5, 'Nothing running and nobody looking: it goes back to sleep.'],
    ],
  }),

  // Reach your computer: it dials out, the grid passes your requests down the line.
  reach: fig({
    label: 'Your desktop dials out to grid.trywisp.dev and holds a tunnel open; your phone signs in, and the grid passes its requests down the tunnel to the desktop.',
    steps: 5,
    stage: `<div class="mf-chain">
      <div class="mf-stack">${node(head('Phone', 'wisp app'), { add: '2:hot,4:cool' })}${node(head('Laptop', 'Machines'))}</div>
      ${wire({ pk: [[2, 3]] })}
      ${node(`${head('grid.trywisp.dev', 'checks it’s you')}${chip('Nothing stored on the way', '', { at: 3 })}`, { cls: 'zoneish' })}
      ${wire({ pk: [[3, 4]], back: [[1, 2]], label: 'tunnel', add: '1:lit' })}
      ${node(`${head('Your desktop', 'behind your home router')}${mono('Claude Code · Codex')}${chip('No open port', '', { at: 1 })}${chip('Opened from your phone', 'accent pop', { at: 4 })}`)}
    </div>`,
    say: [
      [0, 'Your desktop runs wisp at home, behind a router.'],
      [1, 'It dials out to the grid and keeps the line open, so no port needs opening.'],
      [2, 'Your phone signs in as you.'],
      [3, 'The grid checks it’s you and passes the request down the tunnel.'],
      [4, 'You’re in the desktop’s wisp, with its files, logins and agents.'],
    ],
  }),

  // Remote Control vs wisp: one process on one computer, or every agent everywhere.
  remote: fig({
    label: 'Remote Control drives one claude process on one computer, which goes offline when the laptop sleeps; wisp reaches every agent on every computer, and tasks elsewhere keep going.',
    steps: 4,
    cls: 'mf-pairfig',
    stage: `<div class="mf-pair">
      <div class="mf-panel"><span class="mf-label">Remote Control</span>
        ${row(chip('Claude app'), wire({ pk: [[1, 2]] }), node(`${head('Laptop', 'one claude process')}${swap(chip('Working', 'go', { until: 2 }), chip('Offline', 'bad', { at: 2 }))}`, { cls: 'slim', add: '2:dim' }))}
      </div>
      <div class="mf-panel"><span class="mf-label">wisp</span>
        ${fan(node(head('Phone', 'app or browser'), { cls: 'src' }), [
          lane(node(row(head('Laptop', 'Claude Code'), swap(chip('Working', 'go', { until: 2 }), chip('Asleep', '', { at: 2 }))), { cls: 'slim', add: '2:dim' }), { pk: [[1, 2]] }),
          lane(node(row(head('Desktop', 'Codex · Cursor'), swap(chip('Working', 'go', { until: 3 }), chip('Report', 'ok', { at: 3 }))), { cls: 'slim' }), { pk: [[1, 2]] }),
          lane(node(row(head('Cloud box', 'Claude Code · opencode'), swap(chip('Working', 'go', { until: 3 }), chip('Report', 'ok', { at: 3 }))), { cls: 'slim' }), { pk: [[1, 2]] }),
        ], { pk: [[1, 2]] })}
      </div>
    </div>`,
    say: [
      [0, 'Both put a coding agent on your phone.'],
      [1, 'Remote Control drives one <code>claude</code> process. wisp reaches every agent on every computer you add.'],
      [2, 'The laptop sleeps: that session goes offline. Tasks elsewhere keep going.'],
      [3, 'You come back to reports, not a transcript to scroll.'],
    ],
  }),

  // Codex from the phone: a permission, a tap, a report, a PR.
  codexPhone: fig({
    label: 'On the phone, a Codex task asks to install a package, you tap Allow, it finishes with a report and tests passing, and Ship it opens a pull request.',
    steps: 6,
    cls: 'mf-pairfig',
    stage: `<div class="mf-pair">
      <div class="mf-phone"><span class="mf-label">your phone</span>
        ${node(`${row(head('Rate limit /login', 'Codex · on your desktop'), swap(chip('Working', 'go', { until: 2 }), chip('Needs you', 'warn', { at: 2, until: 4 }), chip('Working', 'go', { at: 4, until: 5 }), chip('Done', 'ok', { at: 5 })))}`)}
        ${slot(node(`${head('Allow this command?', 'npm install express-rate-limit')}${row(tap('Allow', { add: '3:tapped' }), tap('Deny'))}`, { at: 2, until: 4, cls: 'note' }),
        node(`${head('Rate limit on /login', '5 tries a minute per IP')}${row(chip('+64 −3 · 2 files'), chip('48 passed', 'ok'))}${row(tap('Ship it'), chip('PR #42 opened', 'accent pop', { at: 5 }))}`, { at: 4, cls: 'note' }))}
      </div>
      <div class="mf-panel"><span class="mf-label">where Codex runs</span>
        ${node(`${head('Your computer or a cloud box', 'codex exec, in its own worktree')}${mono('wisp starts it headless')}${mono('the phone gets cards, not a terminal')}`, { cls: 'slim' })}
      </div>
    </div>`,
    say: [
      [0, 'A Codex task you started from the phone, running on your desktop.'],
      [2, 'It needs to install a package. The card asks you, with a button per answer.'],
      [3, 'One tap, and Codex carries on.'],
      [4, 'Done: the headline, the diff and the test run, sized for a phone.'],
      [5, '<b>Ship it</b> opens the pull request.'],
    ],
  }),

  // wisp Grid: people sign in, each gets a sandbox, idle ones sleep.
  grid: fig({
    label: 'People sign in to your grid with GitHub, Google or OpenID Connect; each gets their own sandboxed wisp on one server, and idle ones sleep until used.',
    steps: 6,
    stage: `<div class="mf-zone wide"><span class="mf-label">one Linux server · wisp grid serve</span>${fan(
      node(`${head('Sign in', 'GitHub · Google · OIDC')}${mono('wisp.example.com')}`, { cls: 'src' }),
      [
        lane(node(row(head('ada.wisp.example.com', 'gVisor sandbox · her logins'), swap(chip('Asleep', '', { until: 1 }), chip('Starting', 'go', { at: 1, until: 2 }), chip('2 tasks', 'go', { at: 2, until: 5 }), chip('Asleep', '', { at: 5 }))), { cls: 'slim' }), { pk: [[1, 2]] }),
        lane(node(row(head('bob.wisp.example.com', 'gVisor sandbox · his logins'), swap(chip('Asleep', '', { until: 2 }), chip('Starting', 'go', { at: 2, until: 3 }), chip('1 task', 'go', { at: 3 }))), { cls: 'slim' }), { pk: [[2, 3]] }),
        lane(node(row(head('cy.wisp.example.com', 'gVisor sandbox'), swap(chip('Asleep', '', { until: 4 }), chip('Waking', 'go', { at: 4, until: 5 }), chip('Schedule ran', 'ok', { at: 5 }))), { cls: 'slim' }), { pk: [[4, 5]] }),
      ],
      { pk: [[1, 2], [2, 3], [4, 5]] },
    )}</div>
    <div class="mf-foot">${chip('No traffic between sandboxes', '', { at: 3 })}${chip('Secrets encrypted per person', '', { at: 3 })}</div>`,
    say: [
      [0, 'Everyone’s wisp sleeps until they need it.'],
      [1, 'Ada signs in with GitHub. Her sandbox starts in seconds.'],
      [2, 'Bob too. Neither can see or reach the other.'],
      [4, 'Cy’s schedule is due: her wisp wakes for it, with nobody signed in.'],
      [5, 'Ada’s done for the day, so hers goes back to sleep.'],
    ],
  }),

  // Two accounts: the limit asks you; wisp never switches by itself.
  accounts: fig({
    label: 'A task on the Work account reaches its usage limit and stops to ask; you choose Continue on Personal, and the same conversation goes on with the other account.',
    steps: 6,
    stage: `<div class="mf-card">
      ${row(head('Migrate billing to Stripe v2', 'Claude Code · Opus'), swap(chip('Work', '', { until: 5 }), chip('Personal', 'accent', { at: 5 })))}
      <div class="mf-meter">${row(`<small${A({ text: 'Work · 5-hour limit|Work · 5-hour limit|Work · 5-hour limit|Work · limit reached|Work · limit reached|Personal · 5-hour limit' })}></small>`, `<small${A({ text: '55%|72%|91%|100%|100%|8%' })}></small>`)}${bar('.55,.72,.91,1,1,.08', 'meter')}</div>
      ${swap(chip('Working', 'go', { until: 3 }), chip('Needs you', 'warn', { at: 3, until: 5 }), chip('Working · same conversation', 'go', { at: 5 }))}
      ${slot(node(`${head('Work reached its limit', 'It resets at 18:00. What should this task do?')}
        <div class="mf-btns">${tap('Wait until 18:00')}${tap('Continue on Personal', { add: '4:tapped' })}${tap('Hand to Codex')}${tap('Get extra usage')}</div>`, { at: 3, until: 5, cls: 'note' }),
        node(head('You chose: Continue on Personal', 'Your pick, not wisp’s. Work’s tasks wait for 18:00.'), { at: 5, cls: 'note' }))}
    </div>`,
    say: [
      [0, 'A task runs on your Work account.'],
      [1, 'Its usage climbs toward the plan’s limit.'],
      [3, 'At the limit the task stops and asks you.'],
      [4, 'You pick. Here: continue on Personal.'],
      [5, 'Same conversation, the other account. wisp never makes that call for you.'],
    ],
  }),

  // Sharing a crew member: a file, a scan, a review, paused until you resume.
  crew: fig({
    label: 'A crew member is shared as a file after a scan for secrets; the teammate reviews it, picks a project, and it waits paused until they resume it.',
    steps: 6,
    stage: `<div class="mf-chain">
      ${node(`${row(head('Scout', 'CI watcher · yours'), chip('Weekdays 9:00'))}${mono('brief · 2 skills · Plan mode')}${mono('notebook stays with you', { at: 1 })}`)}
      ${wire({ pk: [[2, 3]], label: 'scout.crew.json', add: '2:lit' })}
      ${node(`${row(head('Scout', 'in your teammate’s wisp'), swap(chip('Review', '', { at: 3, until: 4 }), chip('Paused', 'warn', { at: 4, until: 5 }), chip('Resumed', 'ok', { at: 5 })))}
        ${mono('runs on Auto: no Codex here', { at: 3 })}${mono('project: api-server', { at: 4 })}`, { at: 2 })}
    </div>
    <div class="mf-foot">${chip('Scanned: no keys or tokens', 'ok', { at: 1 })}</div>`,
    say: [
      [0, 'A crew member you tuned: a brief, a schedule, its skills.'],
      [1, '<b>Share…</b> leaves the notebook out and scans everything for keys first.'],
      [2, 'It goes as a file, a secret gist or a spell.'],
      [3, 'Your teammate sees what it does, and what changes on their machine.'],
      [4, 'It arrives paused, in the project they pick.'],
      [5, 'It starts working when they press <b>Resume</b>.'],
    ],
  }),
};
