// The tips under the prompt box, each with the trywisp.dev guide section that explains it (v1
// web/js/tips-data.js). The text lives in the catalogue (`home.tip.<id>`, with **bold**, `code`
// and _italic_ marked in it); this file holds which tips there are, in order, and where each links.

const SITE = 'https://trywisp.dev';
const G = (slug: string, at = ''): string => `${SITE}/guides/${slug}.html${at && `#${at}`}`;
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
const PHONE = 'reach-your-computer-from-your-phone';

export interface Tip {
  readonly id: string;
  readonly href: string;
  /** points at a New task control the first run keeps behind More options */
  readonly full?: boolean;
}

export const TIPS: readonly Tip[] = [
  { id: 'goal', href: G(GOALS, 'the-check'), full: true },
  { id: 'goalCmd', href: G(GOALS, 'done-when') },
  { id: 'vs', href: G(PARALLEL, 'with-wisp'), full: true },
  { id: 'compare', href: G(VS, 'run-the-comparison') },
  { id: 'auto', href: G(VS, 'let-results-pick') },
  { id: 'limit', href: G(MANY, 'how-many') },
  { id: 'worktrees', href: G(MANY, 'why-worktrees') },
  { id: 'keyN', href: G(MANY, 'with-wisp') },
  { id: 'keyT', href: G(MANY, 'with-wisp') },
  { id: 'ship', href: G(MANY, 'with-wisp') },
  { id: 'delegate', href: G(TEAM, 'team') },
  { id: 'delegateMachine', href: G(TEAM, 'team') },
  { id: 'preset', href: G(TEAM, 'team') },
  { id: 'mcp', href: G(TEAM, 'from-another-agent') },
  { id: 'runOn', href: G(MACHINES, 'one-prompt-several-machines') },
  { id: 'machines', href: G(MACHINES, 'how-it-works') },
  { id: 'battery', href: G(MOVE, 'with-wisp') },
  { id: 'switch', href: G(MOVE, 'switch-agent') },
  { id: 'rerun', href: G(MOVE, 'with-wisp') },
  { id: 'tailscale', href: G('connect-machines-with-tailscale') },
  { id: 'phone', href: G(PHONE, 'add') },
  { id: 'laptop', href: G('run-claude-code-24-7-without-a-vps') },
  { id: 'cloud', href: G('use-wisp-cloud') },
  { id: 'modes', href: G(BG, 'start') },
  { id: 'away', href: G(BG, 'away') },
  { id: 'btw', href: G(BG, 'away') },
  { id: 'recipes', href: G(BG, 'triggers') },
  { id: 'triggers', href: G(BG, 'triggers') },
  { id: 'checkpoints', href: G(BG, 'headless-gaps') },
  { id: 'cli', href: G(BG, 'start') },
  { id: 'api', href: `${SITE}/integrations.html#webhooks` },
  { id: 'spell', href: G(SPELLS, 'cast') },
  { id: 'spells', href: G(SPELLS, 'what') },
  { id: 'share', href: G(SPELLS, 'share') },
  { id: 'safe', href: G(SPELLS, 'trouble') },
  { id: 'harnesses', href: `${SITE}/agents/` },
  { id: 'grid', href: G('self-host-wisp-grid') },
  { id: 'accounts', href: G(ACCOUNTS, 'with-wisp') },
  { id: 'accountLimit', href: G(ACCOUNTS, 'limits') },
];

/** The phone app's tips, for its computers screen: what a first-time user can do from the phone. */
export const PHONE_TIPS: readonly Tip[] = [
  { id: 'p.cloud', href: G('use-wisp-cloud', 'phone') },
  { id: 'p.computer', href: G(PHONE, 'phone') },
  { id: 'p.lock', href: G(BG, 'away') },
  { id: 'p.newTask', href: G(PHONE, 'phone') },
  { id: 'p.needs', href: G(BG, 'away') },
  { id: 'p.swipe', href: G(PHONE, 'phone') },
  { id: 'p.auto', href: G(VS, 'let-results-pick') },
  { id: 'p.parallel', href: G(MANY, 'why-worktrees') },
  { id: 'p.goal', href: G(GOALS, 'the-check') },
  { id: 'p.ship', href: G(MANY, 'with-wisp') },
  { id: 'p.signedIn', href: `${SITE}/agents/` },
  { id: 'p.private', href: G(PHONE, 'private') },
];

/** The tips to show: `count` of them from `at`, skipping those that point past a first run's controls. */
export function tipsAt(at: number, count: number, firstRun: boolean): Tip[] {
  const shown = firstRun ? TIPS.filter((x) => !x.full) : TIPS;
  const n = Math.max(1, Math.min(count, shown.length));
  return Array.from({ length: n }, (_, i) => shown[(at + i) % shown.length]).filter((x): x is Tip => x !== undefined);
}

/** Where the next set starts: each visit and each More tips moves on by one set. */
export const nextAt = (at: number, count: number): number => (at + count) % TIPS.length;
