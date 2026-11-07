// The UI vocabulary a spell names: where things go (slots), what can be restyled (parts) and with
// which props, design tokens, icons, and the settings a spell may set while it is on. The defaults
// are v1's (web/js/spell-schema.js), so every spell made before plugins still checks; the shell and
// the settings owners add theirs through the `plugins.vocabulary` point.

import type { Vocabulary } from '@wisp-plugin/plugins-api';
import { V1_PARTS } from './v1-parts.ts';

export const SLOTS: Readonly<Record<string, string>> = {
  topbar: "The top bar, next to Automations and Search: a labelled button with an optional count.",
  float: "Floating buttons, stacked in a bottom corner of the window. Buttons with the same group fold into one that fans out.",
  palette: "An item in the ⌘K palette.",
  "feed.top": "Above the feed: a panel pinned there (panels only).",
  "launcher.bar": "In the prompt box bar, before Send.",
  "launcher.chips": "Chips under the prompt box (chips and buttons).",
  "composer.bar": "In a card's follow-up box bar, before Send.",
  "composer.chips": "Chips above a card's follow-up box (quick replies).",
  "card.head": "A chip in a card's head, before the time.",
  "card.hover": "A small icon button on a card head, shown on hover.",
  "card.menu": "An item in a card's right-click menu.",
  "card.top": "A panel at the top of an open card (panels only).",
  "card.bottom": "A panel at the bottom of an open card, above the follow-up box (panels only).",
  "sidebar.top": "Split view: a button at the top of the task list, next to New task.",
  "split.head": "Split view: a button in the open task's header, next to its title (acts on that task).",
  "split.details": "Split view: a button in the open task's details column, under its actions (acts on that task).",
  "term.head": "A button in the header of a task's terminal (take over in wisp), before End (acts on that task).",
  "panel.head": "The side panel beside the open task (Changes, PR, Shell, Preview, Watch): a button in its head (acts on that task).",
  "crew.page": "A crew member's thread: a button in its header, next to Pause.",
  "crew.rail": "The crew rail beside the task list (side by side): an icon button above Org and Add a crew member.",
  "org.head": "The Org page (who on the crew hands work to whom): a button in its header, before Add member.",
  "plan.head": "A scheduled task's page (opened from its row under Scheduled): a button in its header, before Start now.",
  "stuff.head": "My Stuff (what you and your agents kept from tasks): a button in its header, before Add files.",
  "split.panes": "Split view's home: a button on the Panes heading (the apps pinned on home).",
  "split.upcoming": "Split view's home: a button on the Coming up heading (scheduled tasks, reminders, follow-ups, check-ins).",
  "goal.band": "The open task's goal band: a button on its second line, after the last check (acts on that task).",
  "machine.head": "Settings → This Mac (This PC, This computer): a button at the top of the pane, beside when it was last read.",
};

export const CARD_SLOTS: ReadonlySet<string> = new Set(['composer.bar', 'composer.chips', 'card.head', 'card.hover', 'card.menu', 'card.top', 'card.bottom', 'split.head', 'split.details', 'term.head', 'panel.head', 'goal.band']);

// Where a button may go (chips and panels have their own).
export const BUTTON_SLOTS: readonly string[] = ['topbar', 'float', 'palette', 'launcher.bar', 'launcher.chips', 'composer.bar', 'composer.chips', 'card.hover', 'card.menu', 'sidebar.top', 'split.head', 'split.details', 'term.head', 'panel.head', 'crew.page', 'org.head', 'plan.head', 'stuff.head', 'split.upcoming', 'split.panes', 'goal.band', 'crew.rail', 'machine.head'];

export const THEMES: readonly string[] = ['system', 'light', 'dark'];

// The reply box is where a question or approval is answered: hidden, it still shows then.
export const ANSWER_BOX: readonly string[] = ['composer', 'composer.input'];

// The pieces of a card head, for `parts["card.head"].order`.
export const CARD_HEAD_ORDER: readonly string[] = ['pill', 'pr', 'model', 'machine', 'project', 'time', 'spells'];

// Props a part publishes (anything else is refused). int is 1–40, px is a size in pixels.
export const PART_PROPS: Readonly<Record<string, Readonly<Record<string, string | readonly string[]>>>> = {
  'launcher.input': { placeholder: 'string', rows: 'int', maxRows: 'int', monospace: 'bool', fontSize: 'int' },
  'composer.input': { placeholder: 'string', rows: 'int', maxRows: 'int', monospace: 'bool', fontSize: 'int' },
  card: { density: ['compact', 'comfortable'], swipeRight: ['done', 'later', 'archive', 'delete', 'off'], swipeLeft: ['done', 'later', 'archive', 'delete', 'off'] },
  'card.sub': { lines: 'int' },
  sidebar: { width: 'px', side: ['left', 'right'], details: ['minimal', 'full'], crewRail: 'bool' },
  'split.main': { readWidth: 'px' },
  'split.details': { width: 'px' },
  'split.home': { greeting: 'string' },
  'crew.page': { swipe: 'bool' },
  'crew.record': { tips: 'bool' },
  'section.crew': { rows: 'int' },
  'org.chart': { movable: 'bool' },
  'stuff.page': { view: ['grid', 'list'], group: ['time', 'task'], cardWidth: 'px' },
  tips: { count: 'int' },
  'split.upcoming': { count: 'int' },
  'split.panes': { height: 'px', columns: 'int', widths: 'string' },
  'split.spare': { hours: 'int' },
  term: { fontSize: 'int' },
  panel: { width: 'px', tab: ['changes', 'pr', 'shell', 'preview', 'watch', 'browser'], swipe: 'bool' },
  'panel.changes': { generated: 'bool', autoOpen: 'bool' },
  'panel.pr': { bots: 'bool' },
};
export const PROP_RANGE: Readonly<Record<string, readonly [number, number]>> = { int: [1, 40], px: [160, 1600] };

// Design tokens a spell may set.
export const TOKENS: readonly string[] = ['--accent', '--accent-ink', '--accent-soft', '--bg', '--bg-2', '--surface', '--surface-2', '--ink', '--ink-2', '--muted', '--faint', '--line', '--line-2', '--good', '--bad', '--warn', '--info', '--radius', '--sans', '--mono', '--display', '--shadow-1', '--shadow-2'];

// Icons from the page's sprite.
export const ICONS: readonly string[] = ['check', 'x', 'skip', 'minus', 'plus', 'chevron', 'arrow', 'external', 'expand', 'file', 'folder', 'dots', 'copy', 'download', 'branch', 'github', 'info', 'warn', 'ask', 'comment', 'lock', 'pen', 'spark', 'wizard', 'stop', 'merge', 'send', 'enter', 'queue', 'clip', 'terminal', 'done', 'archive', 'trash', 'settings', 'read', 'search', 'web', 'agent', 'plan', 'tool', 'stats', 'rerun', 'replay', 'transcript', 'text', 'back', 'update', 'menu', 'bolt', 'clock', 'laptop', 'server', 'cloud', 'thumb-up', 'thumb-down', 'play', 'split', 'feed', 'bell', 'sun', 'moon', 'phone', 'tablet', 'rotate', 'pause', 'grip', 'crew', 'org', 'user', 'target', 'plug', 'fork', 'bookmark', 'bug', 'panel', 'shell', 'stuff', 'star', 'image', 'grid', 'app', 'eye', 'share', 'pin', 'judge', 'box', 'issue', 'discuss', 'camera', 'video', 'mic'];

// Settings a spell may set (while on). Telemetry, feedback, the update channel and anything secret
// are not here; acceptChannels can only be forced off (a spell can come through the grid's tunnel).
export const SETTINGS: Readonly<Record<string, readonly string[] | 'string'>> = {
  theme: ['system', 'light', 'dark'],
  editor: ['vscode', 'cursor', 'windsurf', 'zed', 'idea', 'none'],
  terminal: ['auto', 'wisp', 'terminal', 'iterm', 'warp', 'cmux', 'wt', 'powershell', 'cmd', 'ghostty', 'kitty', 'wezterm', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'alacritty', 'xterm'],
  transcript: ['on', 'off'],
  worktree: ['on', 'off'],
  worktreeCleanup: ['off', '3', '7', '14', '30'],
  worktreeMax: ['off', '20', '40', '80'],
  worktreeOnDone: ['ask', 'remove', 'keep'],
  followUp: ['queue', 'interrupt'],
  mode: ['plan', 'edits', 'auto'],
  agent: 'string',
  model: 'string',
  effort: 'string',
  learn: ['on', 'off'],
  fixConflicts: ['on', 'off'],
  notify: ['on', 'off'],
  apps: ['on', 'off'],
  watch: ['on', 'off'],
  terminalSessions: ['on', 'off'],
  blocks: ['on', 'off'],
  readTimes: ['on', 'off'],
  limitWait: ['on', 'off'],
  autoStop: ['off', '50', '75', '90'],
  autoStopClaude: ['same', 'off', '50', '75', '90'],
  autoStopCodex: ['same', 'off', '50', '75', '90'],
  memoryFloor: ['off', '10', '15', '20', '25'],
  cpuCeiling: ['off', '100', '150', '200'],
  maxRuns: ['off', '4', '6', '8', '12', '16', 'auto'],
  batteryHold: ['off', '20', '40'],
  liveLimits: ['on', 'off'],
  drainWatch: ['on', 'off'],
  spareCard: ['on', 'off'],
  windowNotice: ['on', 'off'],
  subagentModel: ['', 'haiku', 'sonnet'],
  harnessAsk: ['on', 'off'],
  leanRuns: ['off', 'on', 'all'],
  review: ['off', 'other', 'claude', 'codex', 'antigravity', 'copilot', 'opencode', 'cursor', 'grok'],
  maskEnvFiles: ['on', 'off'],
  projectAsk: ['on', 'off'],
  limitHold: ['off', '80', '90', '95'],
  webhookTriggers: ['on', 'off'],
  acceptChannels: ['off'],
  panes: 'string',
};

/** Every name, the defaults merged with what plugins contributed. */
export interface Vocab {
  slots: Readonly<Record<string, string>>;
  parts: ReadonlySet<string>;
  partProps: Readonly<Record<string, Readonly<Record<string, string | readonly string[]>>>>;
  tokens: readonly string[];
  icons: readonly string[];
  settings: Readonly<Record<string, readonly string[] | 'string'>>;
}

export const V1_VOCAB: Vocab = { slots: SLOTS, parts: new Set(V1_PARTS), partProps: PART_PROPS, tokens: TOKENS, icons: ICONS, settings: SETTINGS };

export function mergeVocab(extra: readonly Vocabulary[], base: Vocab = V1_VOCAB): Vocab {
  if (!extra.length) return base;
  const partProps: Record<string, Readonly<Record<string, string | readonly string[]>>> = { ...base.partProps };
  for (const v of extra) for (const [part, props] of Object.entries(v.partProps ?? {})) partProps[part] = { ...partProps[part], ...props };
  return {
    slots: Object.assign({}, base.slots, ...extra.map((v) => v.slots ?? {})),
    parts: new Set([...base.parts, ...extra.flatMap((v) => v.parts ?? [])]),
    partProps,
    tokens: [...new Set([...base.tokens, ...extra.flatMap((v) => v.tokens ?? [])])],
    icons: [...new Set([...base.icons, ...extra.flatMap((v) => v.icons ?? [])])],
    settings: Object.assign({}, base.settings, ...extra.map((v) => v.settings ?? {})),
  };
}
