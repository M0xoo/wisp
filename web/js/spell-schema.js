// Spells: what a spell may add to wisp, change in it or hide, in one DOM-free table that the
// server (validation, the Cast a spell agent's schema tool) and the page (applying spells) share.
//
// A spell never sees wisp's DOM. It names slots (places to add things) and parts (things to
// restyle or hide) from this list, and wisp maps them to its markup. Renaming a class in wisp
// means updating the selector here, not breaking every spell.

export const SPELL_VERSION = 1;

// Where buttons, chips and panels can be added.
export const SLOTS = {
  topbar: 'The top bar, next to Automations and Search: a labelled button with an optional count.',
  float: 'Floating buttons, stacked in a bottom corner of the window. Buttons with the same group fold into one that fans out.',
  palette: 'An item in the ⌘K palette.',
  'feed.top': 'Above the feed: a panel pinned there (panels only).',
  'launcher.bar': 'In the prompt box bar, before Send.',
  'launcher.chips': 'Chips under the prompt box (chips and buttons).',
  'composer.bar': "In a card's follow-up box bar, before Send.",
  'composer.chips': 'Chips above a card\'s follow-up box (quick replies).',
  'card.head': "A chip in a card's head, before the time.",
  'card.hover': 'A small icon button on a card head, shown on hover.',
  'card.menu': "An item in a card's right-click menu.",
  'card.top': 'A panel at the top of an open card (panels only).',
  'card.bottom': 'A panel at the bottom of an open card, above the follow-up box (panels only).',
  'sidebar.top': 'Split view: a button at the top of the task list, next to New task.',
  'split.head': "Split view: a button in the open task's header, next to its title (acts on that task).",
  'split.details': "Split view: a button in the open task's details column, under its actions (acts on that task).",
  'term.head': "A button in the header of a task's terminal (take over in wisp), before End (acts on that task).",
  'panel.head': "The side panel beside the open task (Shell, PR): a button next to its tabs (acts on that task).",
  'crew.page': "A crew member's thread: a button in its header, next to Pause.",
  'split.upcoming': "Split view's home: a button on the Coming up heading (scheduled tasks, reminders, follow-ups, check-ins).",
  'goal.band': "The open task's goal band: a button on its second line, after the last check (acts on that task).",
};

export const CARD_SLOTS = new Set(['composer.bar', 'composer.chips', 'card.head', 'card.hover', 'card.menu', 'card.top', 'card.bottom', 'split.head', 'split.details', 'term.head', 'panel.head', 'goal.band']);

// Light or dark: system follows the OS (the page's `prefers-color-scheme`).
export const THEMES = ['system', 'light', 'dark'];
// Split view (the only layout) puts the list beside the open task from this width; narrower, and
// in the phone app, they stack: the list, and the open task as a page over it with Back.
export const SPLIT_MIN_WIDTH = 900;

// Parts: things a spell can restyle, give props or hide. Selectors are wisp's own markup.
// Never here: questions, approvals, waiting pills, the spell review and Settings → Spells.
export const PARTS = {
  topbar: '#topbar',
  'topbar.brand': '#topbar .brand',
  'topbar.projects': '#projects',
  'topbar.machines': '#machinesBtn',
  // In a browser tab only: the invite to the desktop app, and its card.
  'topbar.getapp': '#getAppBtn',
  'getapp.card': '.getapp',
  'topbar.automations': '#autoBtn',
  'topbar.search': '#searchBtn',
  'palette.tags': '.palette .pal-tags', // a task's topics (wisp_tag) on its row in ⌘K
  // You, the round avatar in the top bar's corner, and its menu: your account on the grid, then
  // Machines, Automations, Get the app and Settings (the topbar.* parts of those name its rows).
  'topbar.account': '#meBtn',
  'account.menu': '#meMenu',
  'topbar.settings': '#settingsBtn',
  'topbar.view': '#viewBtn',
  feed: '#feed',
  // The task list's sections; every heading folds its section.
  'section.needs': '#secNeeds',
  'section.working': '#secWorking',
  'section.scheduled': '#secScheduled', // tasks and reminders set for later, and done tasks with follow-ups to come
  'scheduled.row': '#secScheduled .plan-row',
  'section.forLater': '#secForLater', // finished tasks (and crew jobs) saved to look at again
  'section.done': '#secDone',
  'section.heading': '#feed .f-group > h4',
  // The crew: named agents pinned above Working (both layouts), each row a member with its spirit;
  // a member's page, and the editor that adds one.
  'section.crew': '#secCrew',
  'crew.row': '#secCrew .cr-row',
  'crew.avatar': '.cr-av',
  'crew.strip': '#secCrew .cr-strip', // the quiet members folded into one row of faces
  // A member's thread: the main pane in split view, in place in the feed.
  'crew.page': '.crew-view',
  'crew.thread': '.crew-view .cv-thread',
  'crew.details': '.crew-view .cv-about',
  'crew.compose': '.crew-view .cv-dock',
  'crew.editor': '.crew-edit',
  // Its skills and instructions files (the section in its details), and the editor for one.
  'crew.kit': '.crew-view .cv-kit',
  'crew.record': '.crew-record', // Track record: a member's stats (right-click → Track record…) or the whole crew's
  'crew.record.subject': '.crew-record .rec-subject', // its title: picks a member or the whole crew
  'crew.compare': '.crew-record .rec-compare', // the whole crew, ranked by usage
  'crew.kitEditor': '.kit-edit',
  // Its notebook, opened to read and write in full (Edit beside Notebook).
  'crew.notebookEditor': '.nb-edit',
  // Generate: the dialog that has a member build its kit, and the files it proposed, under that job.
  'crew.kitGenerate': '.kit-gen',
  'crew.offer': '.crew-view .cv-offer',
  'turn.kitOffer': '#feed .t-offers', // kit files an agent proposed for a crew member, under its answer
  'crew.editor.events': '.crew-edit .ce-events', // its "Also starts when" chips
  // Sharing (crew-share.js): Share (a file, JSON, a gist or a spell) and Import with its review. Not
  // the review a spell's member needs before it resumes, nor the note saying which spell it's from:
  // a spell mustn't hide what gates its own members.
  'crew.share': '.crew-share',
  'crew.import': '.crew-import',
  'section.archived': '#secArchived',
  toTop: '#toTop',
  launcher: '#launcher',
  'launcher.input': '#prompt',
  'launcher.projects': '#launcher .l-projects',
  'launcher.attach': '#attach',
  'launcher.where': '#whereBtn',
  'launcher.mode': '#mode',
  'launcher.harness': '#runner',
  // Auto's preview on the harness pill (what it will run for this prompt), and its popover: the
  // whole panel, the other picks it weighed and the one it suggests trying.
  'launcher.autoPreview': '#autoPv',
  'autoPreview.panel': '.auto-pop',
  'autoPreview.alternatives': '.auto-pop .ap-alt',
  'autoPreview.suggest': '.auto-pop .ap-sug',
  // Settings → Auto: the benchmark sources Auto starts from, and each row's Never / Prefer toggles.
  'router.sources': '.router-modal .ro-sources',
  'router.rules': '.router-modal .ro-rule',
  // Accounts (a harness with more than one subscription): the account on a harness · model button
  // (launcher, follow-up box), and the Account row under Thinking in the harness picker.
  'runner.account': '.rb-a',
  'picker.accounts': '.picker .pk-acct',
  // The Thinking slider in the harness picker (its fill and wisps grow with the level).
  'picker.thinking': '.picker .pk-think',
  'launcher.compare': '#compareBtn',
  'launcher.team': '#teamBtn',
  // The Delegate popover (launcher and follow-ups): the lead strip, and each delegate's place chip.
  'delegate.panel': '.team-pop',
  'delegate.lead': '.team-pop .tp-lead',
  'delegate.place': '.team-pop .tp-row .tp-place',
  // A task's delegates at work (one row each, a crew member's opens its job), their reports' link to
  // that job, and the line on a crew job saying which task it came from (a link back to it).
  'delegate.live': '.team-live .tl-row',
  'delegate.open': '.sub-task .sub-open',
  'task.from': '.ask .ask-from',
  'launcher.worktree': '#wtBtn',
  // Goal (Done when): the launcher's toggle and its line under the prompt.
  'launcher.goal': '#goalBtn',
  'launcher.goalLine': '#launcher .l-goal',
  // The open task's goal band: the condition, the progress track, the last check; the row's pill.
  'goal.band': '#feed .item.open .goal-band',
  'goal.text': '#feed .item.open .goal-band .gb-text',
  'goal.track': '#feed .item.open .goal-band .gb-track',
  'goal.check': '#feed .item.open .goal-band .gb-check',
  'card.goal': '#feed .goal-pill',
  'launcher.send': '#launch',
  'launcher.later': '#launchLater',
  'launcher.when': '#launcher .l-when',
  'launcher.recipes': '#launcher .l-recipes',
  'launcher.fab': '#promptFab',
  composer: '.composer',
  'composer.input': '.composer .reply',
  'composer.attach': '.composer .c-attach',
  'composer.mode': '.composer .c-mode',
  'composer.harness': '.composer .c-runner',
  'composer.place': '.composer .c-place',
  'composer.team': '.composer .c-team',
  'composer.hint': '.composer .c-hint',
  'composer.ship': '.composer .c-ship',
  'composer.done': '.composer .c-done',
  'composer.queue': '.composer .c-queue',
  // Later: the follow-ups scheduled on a task (rows above the box), Send later, the time read from the box.
  'composer.later': '.composer .cq.later',
  'composer.sendLater': '.composer .c-later',
  'composer.when': '.composer .when-chip',
  'composer.send': '.composer .send',
  'composer.btwTip': '.w-tip',
  // Comments on an answer (features/comments.js): the waiting ones over the box, the button on a
  // block, the bubble over selected words, the note card, the marks, and the sent ones on a prompt.
  'composer.comments': '.composer .cmt-tray',
  'answer.comment': '.cmt-add',
  'answer.commentBubble': '.cmt-bubble',
  'answer.commentCard': '.cmt-card',
  'answer.commentMark': '.cmt-mark',
  'turn.comments': '#feed .ask-notes',
  card: '#feed .item',
  'card.head': '#feed .it-head',
  'card.dot': '#feed .it-head .q-dot',
  'card.title': '#feed .it-title',
  'card.sub': '#feed .it-sub',
  'card.live': '#feed .q-live',
  'card.side': '#feed .it-side',
  'card.pr': '#feed .it-side .pill.pr',
  // Another open task changes the same files: the pill, and the warning above the follow-up box.
  'card.overlap': '#feed .it-side .pill.overlap',
  'card.overlapNote': '#feed .overlap-strip',
  'card.model': '#feed .it-side .model-logo',
  'card.machine': '#feed .it-side .q-machine',
  'card.project': '#feed .it-side .q-proj',
  'card.time': '#feed .it-side .q-time',
  'card.later': '#feed .it-side .later-pill', // the next scheduled follow-up's time
  'card.quickDone': '#feed .it-quick',
  'card.quickLater': '#feed .it-later', // Save for later / Unsave beside Mark done
  'card.choices': '#feed .it-choices',
  'card.swipe': '#feed .it-swipe', // the band under a row being swiped in the phone app
  'card.body': '#feed .it-body',
  // Forks (Fork…): the fork's link to the task it came from, the original's count of its forks,
  // a turn's Fork from this turn button and the line where a fork's own turns start.
  'card.forkedFrom': '#feed .it-meta .m.fork-from',
  'card.forks': '#feed .it-meta .m.forks',
  'turn.fork': '#feed .tb-fork',
  'turn.forkStart': '#feed .fork-line',
  // Split view only (body.split): the task list on one side, the open task on the other.
  sidebar: 'body.split .feed-wrap',
  // The top bar is the sidebar's head. The foot is gone: what it held (you on the grid, Get the app,
  // Settings) and the nav (Machines, Automations) are in the avatar's menu, so these name those.
  'sidebar.foot': '#meBtn',
  'sidebar.new': '#splitNew',
  'sidebar.nav': '#splitNav',
  'sidebar.account': '#splitMe',
  'sidebar.grip': '#splitGrip',
  'split.main': '#splitMain',
  'split.home': '#splitHome',
  'split.greeting': '#splitHome .sh-hello',
  'split.next': '#splitHome .sh-next:not(.sh-coming)',
  'split.upcoming': '#splitHome .sh-coming', // Coming up: what runs next, soonest first
  'split.upcoming.more': '#splitHome .sh-coming .sh-more', // Show all / Show fewer, past the first `count`
  'split.upcoming.day': '#splitHome .sh-coming .sh-day', // a day's heading in the full list (Today, Tomorrow, Fri 31 Oct)
  'split.feedback': '#splitHome .sh-fb', // Hit a bug, or an idea: opens Send feedback (hidden when feedback is off)
  // Split view's home: tips under the prompt box (after Needs you), each linking to its guide on trywisp.dev.
  tips: '#splitHome .sh-tips',
  'tips.setup': '#splitHome .sh-tips .tip-setup', // pinned on top until a harness can run here; opens Settings → Agents
  'tips.grid': '#splitHome .sh-tips .tip-grid', // pinned until this computer is on a wisp Grid (opens Machines); on a cloud computer, its address until opened once
  'tips.tools': '#splitHome .sh-tips .tip-tool', // pinned until git and gh are installed and gh is signed in to GitHub; opens Settings → Agents
  'split.head': '#splitHead',
  'split.title': '#splitHead .sh-title',
  // Stacked (narrow windows, the phone app): Back to the list, on a task's page and on home.
  'split.back': '.split-main .sh-back',
  'split.body': 'body.split #feed .item.open > .it-body',
  // The open task's details column, fixed on the right while its body scrolls: what the card head
  // says (state, PR, harness, project, time), how it runs (branch, mode, …), its PR and its actions.
  'split.details': 'body.split #feed .item.open > .it-body > .it-bar',
  'split.pr': 'body.split #feed .item.open .it-bar > .pr-strip',
  // The account a task runs on (a harness with more than one): its initial on the harness logo.
  'details.account': 'body.split #feed .item.open .it-props .model-logo .acc-i',
  // The open task's share of its plan's usage windows (4% of weekly · 18% of 5-hour).
  'details.plan': 'body.split #feed .item.open .it-props > .plan-used',
  // A turn that hit its account's usage limit: the card under its hero (Wait until…, Continue on
  // another account, Hand to another harness, Get extra usage).
  'split.actions': 'body.split #feed .item.open .it-bar > .it-actions',
  // Take over in wisp: the task's terminal (a sheet, over the open task in split view, full
  // screen on a phone), its header, the screen and the phone's row of keys (Esc, Tab, Ctrl, arrows).
  term: '#term .tm-box',
  'term.head': '#term .tm-head',
  'term.screen': '#term .tm-screen',
  'term.keys': '#term .tm-keys',
  // The side panel beside the open task: its tabs, the line saying where the task's folder is
  // (computer, branch, what's not shipped), the shell in that folder, and the PR tab's parts. The
  // PR's verdict and Merge aren't parts: a spell can't hide what decides a merge.
  panel: '#sidePanel',
  'panel.tabs': '#sidePanel .pn-tabs',
  'panel.place': '#sidePanel .pn-place',
  'panel.shell': '#sidePanel .pn-shell',
  'panel.pr': '#sidePanel .pn-pr',
  'panel.checks': '#sidePanel .pn-checks',
  'panel.conversation': '#sidePanel .pn-talk',
  'panel.files': '#sidePanel .pn-files',
  // Settings: the dialog, its list of sections, and the head with the pane's name and close button.
  'settings': '.modal.sx',
  'settings.nav': '.sx-nav',
  'settings.head': '.sx-top',
  // Settings → General: which releases wisp updates to (stable, beta or nightly).
  'settings.updates': '.sx-updates',
  // Settings → Machines: whether other devices can reach this computer over SSH.
  'settings.reachable': '.sx-reach',
  // Machines: the three-step explainer, and the password box when a machine won't let this one in.
  'machines.howto': '.mc-howto',
  'machines.letin': '.mc-letin',
  // wisp Grid in Machines: this computer on your grid, or signing in to one.
  'machines.cloud': '.mc-grid',
  'machines.grid.here': '.gh-row',
  'machines.grid.previews': '.gh-pv', // Show local pages in previews, under this computer on the grid
  // The pill on each machine saying where it comes from (Over SSH, Cloud, Your computer · via grid).
  'machines.kind': '.mc-kind',
  // Settings → Cloud: your cloud computers, and signing in to a wisp Grid.
  'settings.cloud': '.sx-cloud',
  'settings.cloud.computer': '.cl-card',
  'settings.cloud.signin': '.cl-signin',
  'settings.cloud.add': '.cl-add', // Add an account, once you have one (opens the sign-in)
  // Settings → Connect, on a cloud computer: how to open it through its grid.
  'settings.connect': '.sx-connect',
  // Settings → Agents: signing in to a harness (its link, code and paste box).
  'settings.agent.signin': '.sx-login',
  // Settings → Agents: a harness's accounts (each with its ⋯ menu) and Add another account.
  'settings.accounts': '.sx-accts',
  // Settings → Connectors: your MCP servers, each row, and the servers found in the harnesses' own configs.
  'settings.connectors': '.cx-box',
  'connectors.row': '.cx-row',
  'connectors.import': '.cx-found',
  // Settings → Usage: Plan budget, each account's 5-hour and weekly windows, Ask near the limit and Wait for the reset.
  'settings.budget': '.sx-budget',
  // …its Automations stop at row, and Where it went: the tasks that used most of an account's longest window.
  'settings.autoStop': '.sx-budget .sx-row:has(.us-stop)',
  'budget.where': '.sx-budget .bg-where',
  // The harness picker: how full a window at or past your Ask near the limit line is (server/guard.js).
  // The hold row and the held card aren't parts: they need you, like a due reminder.
  'harness.usage': '.rp-usage',
  // The image viewer: a picture from a reply or an attachment, full screen to zoom into, and its zoom buttons.
  viewer: '.lb',
  'viewer.bar': '.lb-bar',
  // Its previous / next buttons, when the reply has more than one picture.
  'viewer.nav': '.lb-nav',
  // The Copy image, Download and Show in folder buttons on a picture in a reply (on hover; always there on a touch screen).
  'image.tools': '.b-image .img-tools',
  // A video in a reply: the player, and its Download and Show in folder buttons.
  video: '.b-video',
  'video.tools': '.b-video .img-tools',
  // A live web page in a reply, framed as a phone, tablet or browser window: its address and size
  // switcher, the stage it sits on (max-height sets how tall it may get), and the line under it.
  preview: '.b-preview',
  'preview.head': '.b-preview .pv-head',
  'preview.stage': '.b-preview .pv-stage',
  'preview.foot': '.b-preview .pv-foot',
  // A markdown file in a reply (the doc block): the card, its page of the file's opening (max-height
  // sets how much shows), and the full-screen reader with its contents column.
  doc: '.b-doc',
  'doc.preview': '.b-doc .doc-page',
  'doc.reader': '.dr',
  'doc.contents': '.dr-toc',
  // Another wisp task in a reply (the task block): the card, and its Open label.
  task: '.b-task',
  'task.open': '.b-task .tk-open',
  // An interactive block in an answer (an agent's or a spell's app) and its title row. Not the
  // strip that asks before sending what the app offers: that one always shows.
  'block.app': '.b-app',
  'block.app.head': '.b-app .app-head',
  // Toasts: the stack, each card, its glyph, its action button, the ring that runs down while it
  // shows, and Clear all over the fanned-out stack.
  toasts: '#toasts',
  toast: '#toasts .toast',
  'toast.glyph': '#toasts .t-glyph',
  'toast.action': '#toasts .t-act',
  'toast.timer': '#toasts .t-time',
  'toast.clear': '#toasts .toasts-clear',
};

// The pieces of a card head, for `parts["card.head"].order`.
export const CARD_HEAD_ORDER = { pill: '.pill:not(.pr)', pr: '.pill.pr', model: '.model-logo', machine: '.q-machine', project: '.q-proj', time: '.q-time', spells: '.sp-chip' };

// Props a part publishes (anything else is refused).
export const PART_PROPS = {
  'launcher.input': { placeholder: 'string', rows: 'int', maxRows: 'int', monospace: 'bool', fontSize: 'int' },
  'composer.input': { placeholder: 'string', rows: 'int', maxRows: 'int', monospace: 'bool', fontSize: 'int' },
  // swipeRight / swipeLeft: what swiping a row does in the phone app (done / later unless set)
  card: { density: ['compact', 'comfortable'], swipeRight: ['done', 'later', 'archive', 'delete', 'off'], swipeLeft: ['done', 'later', 'archive', 'delete', 'off'] },
  'card.sub': { lines: 'int' },
  sidebar: { width: 'px', side: ['left', 'right'], details: ['minimal', 'full'] }, // side: left unless set
  'split.main': { readWidth: 'px' },
  'split.details': { width: 'px' },
  'split.home': { greeting: 'string' },
  'crew.record': { tips: 'bool' }, // the suggestion line under a member's numbers (on)
  'section.crew': { rows: 'int' }, // full rows shown when nobody's busy (2); the rest fold
  tips: { count: 'int' },
  'split.upcoming': { count: 'int' },
  term: { fontSize: 'int' },
  panel: { width: 'px', tab: ['shell', 'pr'] }, // tab: the one a task opens on, until you pick another
  'panel.pr': { bots: 'bool' }, // bots' comments shown, not folded under one row (off)
};

// What a prop type accepts: int is 1–40, px is a size in pixels.
export const PROP_RANGE = { int: [1, 40], px: [160, 1600] };

// CSS a spell may set on a part (camelCase or kebab-case), and what values look like.
export const STYLE_PROPS = [
  'color', 'background', 'background-color', 'border', 'border-color', 'border-width', 'border-style', 'border-radius',
  'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right', 'margin', 'margin-top', 'margin-bottom',
  'gap', 'font-size', 'font-weight', 'font-family', 'font-style', 'line-height', 'letter-spacing', 'text-transform',
  'box-shadow', 'opacity', 'order', 'display', 'flex-direction', 'align-items', 'justify-content', 'min-height', 'max-height', 'width', 'max-width',
];
const STYLE_VALUE = /^[#a-z0-9\s.,%()+\-/'"]*$/i;
const BANNED_VALUE = /url\s*\(|image-set|@import|expression\s*\(|\\|;|[{}<>]|attr\s*\(/i;

export const kebab = (k) => String(k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

// '' when the declaration is fine, else why not.
export function styleProblem(prop, value) {
  const p = kebab(prop);
  if (!STYLE_PROPS.includes(p)) return `${p} isn't a property spells can set`;
  const v = String(value ?? '');
  if (v.length > 120) return `${p}: value too long`;
  if (BANNED_VALUE.test(v) || !STYLE_VALUE.test(v)) return `${p}: value not allowed (no url(), imports or special characters)`;
  if (p === 'display' && !['none', 'flex', 'grid', 'block', 'inline-flex', 'inline-block'].includes(v.trim())) return 'display must be none, flex, grid, block, inline-flex or inline-block';
  return '';
}

// Design tokens from web/css/tokens.css a spell may set.
export const TOKENS = ['--accent', '--accent-ink', '--accent-soft', '--bg', '--bg-2', '--surface', '--surface-2', '--ink', '--ink-2', '--muted', '--faint', '--line', '--line-2', '--good', '--bad', '--warn', '--info', '--radius', '--sans', '--mono', '--display', '--shadow-1', '--shadow-2'];

// Icons from the page's sprite (#i-<name>).
export const ICONS = ['check', 'x', 'skip', 'minus', 'plus', 'chevron', 'arrow', 'external', 'expand', 'file', 'folder', 'dots', 'copy', 'download', 'branch', 'github', 'info', 'warn', 'ask', 'comment', 'lock', 'pen', 'spark', 'wizard', 'stop', 'merge', 'send', 'enter', 'queue', 'clip', 'terminal', 'done', 'archive', 'trash', 'settings', 'read', 'search', 'web', 'agent', 'plan', 'tool', 'stats', 'rerun', 'replay', 'transcript', 'text', 'back', 'update', 'menu', 'bolt', 'clock', 'laptop', 'server', 'cloud', 'thumb-up', 'thumb-down', 'play', 'split', 'feed', 'bell', 'sun', 'moon', 'phone', 'tablet', 'rotate', 'pause', 'crew', 'user', 'target', 'plug', 'fork', 'bookmark', 'bug', 'panel', 'shell'];

// What a button, chip, command, slash command or hook can do. kind: what the review says about it.
//   safe: changes nothing outside the page · acts: does something for you, only when you click
//   runs: runs a command on your computer
export const ACTIONS = {
  open: { kind: 'safe', doc: '{ "open": "https://…/{pr.number}" } open one http(s) link (a {field} template)' },
  openAll: { kind: 'safe', doc: '{ "openAll": { "data": "prs", "field": "url" } } open every link in a data source (at most 20). Or { "fn": "name" }: a script function returning links, each of which must appear in the spell\'s data' },
  panel: { kind: 'safe', doc: '{ "panel": "id" } open one of this spell\'s panels' },
  insert: { kind: 'safe', doc: '{ "insert": "text" } put text into the box at the caret (prompt box or follow-up box)' },
  copy: { kind: 'safe', doc: '{ "copy": "{branch}" } copy text' },
  toast: { kind: 'safe', doc: '{ "toast": "text" } show a short message' },
  setLaunch: { kind: 'safe', doc: '{ "setLaunch": { "agent": "codex", "model": "", "effort": "high", "mode": "plan" } } set the prompt box pickers' },
  send: { kind: 'acts', doc: '{ "send": "text" } send a follow-up to the card\'s task right away' },
  reply: { kind: 'acts', doc: '{ "reply": "text" } same as send, used by hooks' },
  launchWith: { kind: 'acts', doc: '{ "launchWith": { "agent": "codex", "mode": "plan", "effort": "high", "text": "optional prefix" } } launch what is in the prompt box with these settings' },
  launch: { kind: 'acts', doc: '{ "launch": { "prompt": "…", "agent": "", "mode": "plan", "cwd": "" } } start a new task (cwd empty = the current project)' },
  rerun: { kind: 'acts', doc: '{ "rerun": { "agent": "codex", "model": "", "effort": "", "mode": "plan", "prompt": "optional, defaults to the task\'s first request" } } run the card\'s task again as a new task on another harness' },
  fork: { kind: 'acts', doc: '{ "fork": { "prompt": "Try it with a lookup table instead", "agent": "", "model": "", "effort": "", "mode": "" } } fork the card\'s task from its latest turn: a new task with its conversation and a copy of its work, on its own branch, that does what prompt says (agent, model, effort, mode: optional, the task\'s own by default)' },
  recipe: { kind: 'acts', doc: '{ "recipe": "name" } run a recipe' },
  ship: { kind: 'acts', doc: '{ "ship": true } open Ship it for the card\'s task' },
  done: { kind: 'acts', doc: '{ "done": true } mark the card\'s task done' },
  archive: { kind: 'acts', doc: '{ "archive": true } archive the card\'s task' },
  forLater: { kind: 'acts', doc: '{ "forLater": true } save the card\'s task for later (a finished one; it leaves Needs you for For later)' },
  notify: { kind: 'acts', doc: '{ "notify": "text" } a desktop notification / toast (hooks: your phone, if linked)' },
  webhook: { kind: 'runs', doc: '{ "webhook": "https://…" } POST the task summary as JSON to a URL (hooks)' },
  exec: { kind: 'runs', doc: '{ "exec": "npm run e2e" } run a shell command in the task\'s folder (asks you the first time)' },
};

// Hook events (server side), with what `if` can test.
export const EVENTS = {
  'turn.finished': 'A turn ended normally (the agent reported).',
  'turn.failed': 'A turn ended with an error.',
  'session.started': 'A new task started.',
  'session.waiting': 'A task is waiting for your answer.',
};
export const HOOK_IF = ['status', 'testsFailed', 'agent', 'project', 'hasPr', 'mode'];
export const HOOK_ACTIONS = new Set(['reply', 'done', 'archive', 'forLater', 'notify', 'webhook']);

// Settings a spell may set (while on). Telemetry, feedback, the update channel (a shared spell
// mustn't move you onto nightlies) and anything secret are not here.
export const SETTINGS = {
  theme: THEMES,
  editor: ['vscode', 'cursor', 'windsurf', 'zed', 'idea', 'none'],
  // Take over in: wisp (a terminal in the page), auto, or a terminal app (not a custom command).
  terminal: ['auto', 'wisp', 'terminal', 'iterm', 'warp', 'cmux', 'wt', 'powershell', 'cmd', 'ghostty', 'kitty', 'wezterm', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'alacritty', 'xterm'],
  transcript: ['on', 'off'],
  worktree: ['on', 'off'],
  followUp: ['queue', 'interrupt'],
  mode: ['plan', 'edits', 'auto'],
  agent: 'string',
  model: 'string',
  effort: 'string',
  learn: ['on', 'off'],
  fixConflicts: ['on', 'off'],
  notify: ['on', 'off'],
  // Interactive answers: agents may answer with an `app` block (a small sandboxed page).
  apps: ['on', 'off'],
  // "in 5 min …" / "remind me … in 1 h" in a prompt schedules it (web/js/when.js).
  readTimes: ['on', 'off'],
  // Goals: how many rounds a new goal gets before it stops (server/goal.js).
  goalRounds: ['3', '5', '10', '20'],
  // At a usage limit: wait for the window's reset and carry on in the same conversation, or ask.
  limitWait: ['on', 'off'],
  // Automations stop at: check-ins, triggers, goal rounds and agents' follow-ups wait once an
  // account is past this percent of a usage window, until it resets (server/budget.js).
  autoStop: ['off', '50', '75', '90'],
  // Ask near the limit: before a run would take a 5-hour or weekly window past this share (server/guard.js).
  limitHold: ['off', '80', '90', '95'],
};

// GET routes a `wisp` data source may read (patterns, :x = one segment).
export const WISP_DATA = ['/sessions', '/sessions/:id', '/usage', '/usage/tools', '/projects', '/recipes', '/triggers', '/machines', '/agents', '/preferences', '/spells'];

// `gh` data sources: read-only subcommands only.
export const GH_READ = { pr: ['list', 'view', 'status', 'checks', 'diff'], search: ['prs', 'issues', 'repos', 'commits'], issue: ['list', 'view', 'status'], run: ['list', 'view'], repo: ['view', 'list'], release: ['list', 'view'], workflow: ['list', 'view'], api: null };
const GH_WRITE_FLAGS = /^(-X|--method|-f|-F|--field|--raw-field|--input)(=|$)/;

// '' when the gh args are read-only, else why not.
export function ghProblem(args) {
  if (!Array.isArray(args) || !args.length || args.some((a) => typeof a !== 'string')) return 'gh needs a list of string arguments';
  const [cmd, sub] = args;
  if (!(cmd in GH_READ)) return `gh ${cmd} isn't allowed (read-only commands only)`;
  if (cmd === 'api') {
    if (args.some((a) => GH_WRITE_FLAGS.test(a))) return 'gh api may only read (no -X, -f, -F or --input)';
    return '';
  }
  if (!GH_READ[cmd].includes(sub)) return `gh ${cmd} ${sub || ''} isn't allowed (read-only commands only)`.replace(/\s+\(/, ' (');
  return '';
}

// '' when the path is a readable wisp route, else why not.
export function wispPathProblem(p) {
  const s = String(p || '');
  if (!s.startsWith('/')) return 'a wisp data path starts with / (e.g. /sessions)';
  const route = s.split('?')[0].replace(/^\/api(?=\/)/, '');
  const parts = route.split('/').filter(Boolean);
  const ok = WISP_DATA.some((pat) => {
    const segs = pat.split('/').filter(Boolean);
    return segs.length === parts.length && segs.every((x, i) => x.startsWith(':') || x === parts[i]);
  });
  return ok ? '' : `${route} isn't readable by spells (one of ${WISP_DATA.join(', ')})`;
}

// Built-in presentation blocks (a spell's agent block type can't reuse these names).
export const BUILTIN_BLOCKS = ['hero', 'markdown', 'steps', 'stats', 'files', 'diff', 'tests', 'commits', 'graph', 'tree', 'code', 'compare', 'flow', 'chart', 'terminal', 'checklist', 'callout', 'image', 'video', 'preview', 'doc', 'task', 'question', 'blocked', 'actions', 'next', 'spell', 'app'];

// {field} templates over a context object (dotted paths): "PR #{pr.number}". Missing → ''.
export function fillTemplate(tpl, ctx = {}) {
  return String(tpl ?? '').replace(/\{([a-zA-Z_][\w.]*)\}/g, (_, key) => {
    const v = key.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), ctx);
    return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

// Does a card-scoped `when` match a session summary?
//   { hasPr, state: [...], status: [...], agent: [...], project: [...], unread, running }
export function whenMatches(when, s) {
  if (!when) return true;
  if (!s) return false;
  const list = (v) => (Array.isArray(v) ? v : [v]);
  if (when.hasPr !== undefined && !!(s.pr || s.prs?.length) !== !!when.hasPr) return false;
  if (when.prState !== undefined && !list(when.prState).includes(s.pr?.state)) return false;
  if (when.state !== undefined && !list(when.state).includes(s.state)) return false;
  if (when.status !== undefined && !list(when.status).includes(s.status)) return false;
  if (when.agent !== undefined && !list(when.agent).includes(s.agent)) return false;
  if (when.project !== undefined && !list(when.project).some((p) => p === s.project || p === s.projectId)) return false;
  if (when.unread !== undefined && !!s.unread !== !!when.unread) return false;
  if (when.hasBranch !== undefined && !!s.branch !== !!when.hasBranch) return false;
  return true;
}

// The function names a spell's script exports (`export function name`, `export const name =`).
export function scriptExports(src = '') {
  const out = new Set();
  for (const m of String(src).matchAll(/export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of String(src).matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) out.add(m[1]);
  return [...out];
}

// The script as a classic script defining its functions on `__spell` (what the sandbox runs).
export function scriptBody(src = '') {
  const names = scriptExports(src);
  const body = String(src).replace(/export\s+(?=(?:async\s+)?function|const|let|var)/g, '');
  return `${body}\n;return { ${names.join(', ')} };`;
}
