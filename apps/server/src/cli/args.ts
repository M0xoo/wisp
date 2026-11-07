// The `wisp` command line: its usage text, its flags and which word is a command. Pure and cheap (node:
// built-ins only), because bin/wisp.ts reads it before deciding whether anything else has to load.
import os from 'node:os';
import path from 'node:path';

export const HELP = `usage:
  wisp                          open wisp
  wisp "task"                   launch a task in this folder
  wisp add [path]               add a project
  wisp ls                       list sessions        (--state running,waiting,review,done|needs  --limit N  --all: archived too)
  wisp show <id>                state + latest presentation as markdown
  wisp wait <id>                block until it finishes or asks you something
  wisp reply <id> "text"        follow up (answers a pending question)   (--queue  --mode plan|edits|auto
                                --agent ID  --model ID  --effort LEVEL: switch harness / model from here on)
  wisp btw <id> "question"      ask on the side without interrupting the run; prints the answer
  wisp stop <id>                stop a run
  wisp ship <id>                commit, push and open a PR for a worktree session   (--draft)
  wisp merge <id>               squash-merge its PR and sync your local base branch
  wisp run <recipe> [values…]   run a saved recipe; values fill its {params} in order, or key=value
  wisp recipes                  list recipes
  wisp usage                    spend and outcomes   (--days 7|30|90)
  wisp spell                    list spells (changes to wisp itself: buttons, panels, blocks, looks)
  wisp spell cast "<change>"    an agent writes a spell for it; keep it in the app   (--wait)
  wisp spell install <file|url> add a spell someone sent (https, gist:<id>); off until --on
  wisp spell on|off|rm <id>     turn a spell on or off, or remove it   (wisp spell off --all)
  wisp spell export <id>        print the spell file to share
  wisp crew                     list your crew
  wisp crew import <file|url>   add members someone shared (.crew.json, https, gist:<id>); paused, in this folder (--cwd)
  wisp crew export <name…>      print their .crew.json   (--notebook  --team: who they delegate to  --no-kit  --gist: a secret gist)
  wisp computer                 is this computer on your wisp Grid? its address there
  wisp computer on              add it, so your phone and other computers reach it   (--grid HOST, default grid.trywisp.dev;
                                signs in first: allow the code in your browser)
  wisp computer off             take it off the grid
  wisp mcp                      run the MCP server (stdio) for other agents and editors
  wisp skill [install]          print / install the wisp agent skill   (--agent claude|codex|opencode|all  --project)
  wisp grid dev|init|serve|doctor  wisp Grid: wisp for many people on your server   (wisp grid help)
  wisp -- "ls the repo"         a task that starts with a command name

launch options: --mode plan|edits|auto  --agent claude|codex|opencode|cursor|antigravity|grok|copilot  --model ID  --effort LEVEL
                --cwd DIR  --also DIR (repeatable)  --wait  --json  --no-worktree  --compare agent[:model],…
                --try subagents=haiku|sonnet|task  --try skills=off  run it twice on --agent, the second with
                that changed (repeatable or comma separated); Compare says what differed
                --yes  go ahead although it takes a usage window past your Ask near the limit line
options:        --port N  --browser  --no-open  --json  --version`;

export const COMMANDS = ['add', 'ls', 'list', 'show', 'wait', 'reply', 'btw', 'stop', 'mcp', 'skill', 'ship', 'merge', 'run', 'recipes', 'usage', 'spell', 'spells', 'crew', 'grid', 'computer'] as const;
export type Command = (typeof COMMANDS)[number];
export const LS_STATES = ['running', 'waiting', 'review', 'done'] as const;
// The grid CLI's GRID_COMMANDS (not imported: every command would load the grid). A test keeps them equal.
export const GRID_SUB: ReadonlySet<string> = new Set(['dev', 'init', 'serve', 'doctor', 'rotate-key', 'backup', 'users', 'waitlist', 'help']);
// v1 session ids are 12 hex characters; v2 ones are UUIDs. Either makes `wisp ship <id>` the command.
const SESSION_ID = /^([a-f0-9]{12}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export interface CompareRun {
  agent: string;
  model?: string | undefined;
}

export interface Flags {
  open: boolean;
  browser: boolean;
  port: number;
  /** --port was on the command line (not just WISP_PORT): scripted commands then skip discovery */
  portGiven: boolean;
  mode: string | null;
  agent: string | null;
  model: string | null;
  effort: string | null;
  cwd: string | null;
  also: string[];
  json: boolean;
  wait: boolean;
  yes: boolean;
  queue: boolean | undefined;
  state: string | null;
  limit: number | null;
  project: boolean;
  worktree: boolean | undefined;
  compare: CompareRun[] | null;
  try: string[];
  draft: boolean;
  days: number | null;
  on: boolean;
  all: boolean;
  grid: string | null;
  notebook: boolean;
  team: boolean;
  kit: boolean;
  gist: boolean;
}

export interface Parsed {
  /** `version` and `help` answer at once, before anything else loads */
  action: 'run' | 'version' | 'help';
  flags: Flags;
  words: string[];
  /** after `--`: 'task' when it came first (the words are a task even if the first is a command name) */
  literal: false | 'task' | true;
  command: Command | null;
  /** the arguments with every `--flag=value` split in two (the grid CLI parses its own from these) */
  argv: string[];
}

/** A flag that needs a value and got none (v1 crashed on it with a stack trace). */
export class UsageError extends Error {}

export function defaultFlags(env: Record<string, string | undefined> = process.env): Flags {
  return {
    open: true, browser: false, port: Number(env['WISP_PORT']) || 4477, portGiven: false, mode: null, agent: null, model: null, effort: null,
    cwd: null, also: [], json: false, wait: false, yes: false, queue: undefined, state: null, limit: null, project: false, worktree: undefined,
    compare: null, try: [], draft: false, days: null, on: false, all: false, grid: null, notebook: false, team: false, kit: true, gist: false,
  };
}

const expand = (p: string): string => path.resolve(p.replace(/^~(?=$|[\\/])/, os.homedir()));
const compareList = (v: string): CompareRun[] =>
  v.split(',').filter(Boolean).map((x) => ({ agent: x.split(':')[0] ?? '', model: x.split(':').slice(1).join(':') || undefined }));

type Setter = (f: Flags, value: () => string) => void;
// [names, needs a value, set]. Short names as v1 had them.
const TABLE: Array<[string[], Setter]> = [
  [['--no-open'], (f) => void (f.open = false)],
  [['--browser', '-b'], (f) => void (f.browser = true)],
  [['--port', '-p'], (f, v) => void ((f.port = Number(v())), (f.portGiven = true))],
  [['--mode', '-m'], (f, v) => void (f.mode = v())],
  [['--agent', '-a'], (f, v) => void (f.agent = v())],
  [['--model'], (f, v) => void (f.model = v())],
  [['--effort'], (f, v) => void (f.effort = v())],
  [['--cwd', '-C'], (f, v) => void (f.cwd = expand(v()))],
  [['--also'], (f, v) => void f.also.push(expand(v()))],
  [['--state'], (f, v) => void (f.state = v())],
  [['--limit'], (f, v) => void (f.limit = Number(v()))],
  [['--json'], (f) => void (f.json = true)],
  [['--wait', '-w'], (f) => void (f.wait = true)],
  [['--yes', '-y'], (f) => void (f.yes = true)],
  [['--queue'], (f) => void (f.queue = true)],
  [['--project'], (f) => void (f.project = true)],
  [['--no-worktree'], (f) => void (f.worktree = false)],
  [['--worktree'], (f) => void (f.worktree = true)],
  [['--compare'], (f, v) => void (f.compare = compareList(v()))],
  [['--try'], (f, v) => void f.try.push(v())],
  [['--draft'], (f) => void (f.draft = true)],
  [['--on'], (f) => void (f.on = true)],
  [['--all'], (f) => void (f.all = true)],
  [['--days'], (f, v) => void (f.days = Number(v()))],
  [['--grid'], (f, v) => void (f.grid = v())],
  [['--notebook'], (f) => void (f.notebook = true)],
  [['--team'], (f) => void (f.team = true)],
  [['--no-kit'], (f) => void (f.kit = false)],
  [['--gist'], (f) => void (f.gist = true)],
];
const SETTERS = new Map(TABLE.flatMap(([names, set]) => names.map((n) => [n, set] as const)));

// Newer commands are also common first words of a task ("ship the docs", "usage of X"), so they only
// count when the rest fits; `wisp run` falls back to a task when no recipe has that name.
const FITS: Partial<Record<Command, (w: string[]) => boolean>> = {
  grid: (w) => !w[1] || GRID_SUB.has(w[1]),
  ship: (w) => SESSION_ID.test(w[1] ?? ''),
  merge: (w) => SESSION_ID.test(w[1] ?? ''),
  btw: (w) => SESSION_ID.test(w[1] ?? ''),
  usage: (w) => w.length === 1,
  recipes: (w) => w.length === 1,
  computer: (w) => w.length === 1 || (w.length === 2 && ['on', 'off', 'status'].includes(w[1] ?? '')),
  run: (w) => w.length > 1,
  crew: (w) => w.length === 1 || (w[1] === 'ls' && w.length === 2) || (['import', 'export'].includes(w[1] ?? '') && w.length > 2),
};

const isCommand = (w: string | undefined): w is Command => (COMMANDS as readonly string[]).includes(w ?? '');

export function commandOf(words: string[], literal: Parsed['literal']): Command | null {
  const first = words[0];
  if (literal === 'task' || !isCommand(first)) return null;
  return (FITS[first]?.(words) ?? true) ? first : null;
}

export function parseArgs(input: readonly string[], env: Record<string, string | undefined> = process.env): Parsed {
  const argv = [...input];
  const flags = defaultFlags(env);
  const words: string[] = [];
  let literal: Parsed['literal'] = false;
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i] ?? '';
    // --state=review is --state review (it used to become a word, and the filter was dropped).
    if (!literal && /^--[a-z-]+=/.test(a)) {
      argv.splice(i + 1, 0, a.slice(a.indexOf('=') + 1));
      a = a.slice(0, a.indexOf('='));
      argv[i] = a;
    }
    if (literal) words.push(a);
    else if (a === '--') literal = words.length === 0 ? 'task' : true;
    else if (a === '--version' || a === '-v') return { action: 'version', flags, words, literal, command: null, argv };
    else if (a === '--help' || a === '-h') return { action: 'help', flags, words, literal, command: null, argv };
    else {
      const set = SETTERS.get(a);
      if (!set) words.push(a);
      else
        set(flags, () => {
          const v = argv[++i];
          if (v === undefined) throw new UsageError(`${a} needs a value — see wisp --help`);
          return v;
        });
    }
  }
  return { action: 'run', flags, words, literal, command: commandOf(words, literal), argv };
}
