// Open a command in the user's terminal app so they can take over an agent session interactively
// (v1 server/terminal.js). terminalPlan() is pure (platform and PATH lookups are injected) so every
// platform's command line can be tested anywhere; openInTerminal() runs the plan through proc.

import { escapeCmdArgument, escapeCmdCommand } from '@wisp/native';
import type { Env } from './env.ts';
import type { Later } from './order.ts';

interface TerminalEntry {
  id: string;
  label: string;
  os?: readonly string[];
}

// os: which platforms list the entry (all if omitted).
const ALL_TERMINALS: readonly TerminalEntry[] = [
  { id: 'auto', label: 'Auto-detect' },
  { id: 'wisp', label: 'In wisp', os: ['darwin', 'linux'] },
  { id: 'terminal', label: 'Terminal.app', os: ['darwin'] },
  { id: 'iterm', label: 'iTerm', os: ['darwin'] },
  { id: 'warp', label: 'Warp', os: ['darwin'] },
  { id: 'cmux', label: 'cmux', os: ['darwin'] },
  { id: 'wt', label: 'Windows Terminal', os: ['win32'] },
  { id: 'powershell', label: 'PowerShell', os: ['win32'] },
  { id: 'cmd', label: 'Command Prompt', os: ['win32'] },
  { id: 'ghostty', label: 'Ghostty', os: ['darwin', 'linux'] },
  { id: 'kitty', label: 'kitty', os: ['darwin', 'linux'] },
  { id: 'wezterm', label: 'WezTerm' },
  { id: 'gnome-terminal', label: 'GNOME Terminal', os: ['linux'] },
  { id: 'konsole', label: 'Konsole', os: ['linux'] },
  { id: 'xfce4-terminal', label: 'Xfce Terminal', os: ['linux'] },
  { id: 'alacritty', label: 'Alacritty', os: ['linux'] },
  { id: 'xterm', label: 'xterm', os: ['linux'] },
  { id: 'custom', label: 'Custom command' },
];

export const terminalsFor = (platform: string): { id: string; label: string }[] =>
  ALL_TERMINALS.filter((t) => !t.os || t.os.includes(platform === 'darwin' || platform === 'win32' ? platform : 'linux')).map(({ id, label }) => ({ id, label }));

export const shq = (s: string): string => `'${String(s).replace(/'/g, `'\\''`)}'`;
const psq = (s: string): string => `'${String(s).replace(/'/g, "''")}'`; // PowerShell single-quoted string
const asStr = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; // AppleScript string

const CMUX_APP = '/Applications/cmux.app';
const CMUX_CLI = `${CMUX_APP}/Contents/Resources/bin/cmux`;
const LINUX_ORDER = ['ghostty', 'kitty', 'wezterm', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'alacritty', 'x-terminal-emulator', 'xterm'];

export interface Lookups {
  platform: string;
  env: Env;
  /** is this program on PATH */
  has?: (bin: string) => boolean;
  exists?: (path: string) => boolean;
}

export function detectTerminal({ platform, env, has = () => false, exists = () => false }: Lookups): string {
  if (platform === 'darwin') {
    if (env['TERM_PROGRAM'] === 'iTerm.app' && exists('/Applications/iTerm.app')) return 'iterm';
    // cmux is built on Ghostty and reports TERM_PROGRAM=ghostty, so check it first.
    if ((env['CMUX_WORKSPACE_ID'] || env['__CFBundleIdentifier'] === 'com.cmuxterm.app') && exists(CMUX_APP)) return 'cmux';
    if (env['TERM_PROGRAM'] === 'ghostty' && exists('/Applications/Ghostty.app')) return 'ghostty';
    return 'terminal';
  }
  if (platform === 'win32') return env['WT_SESSION'] || has('wt') ? 'wt' : 'powershell';
  return LINUX_ORDER.find((t) => has(t)) ?? 'xterm';
}

/** Take over in the page by default where it can run one (no pty on Windows). */
export const defaultTerminal = (platform: string): string => (platform === 'win32' ? 'auto' : 'wisp');

/** In the page instead of an app: when asked to, or on auto where there's no desktop (a Grid, a headless Linux). */
export function inWisp(terminal: string, { platform, env }: Pick<Lookups, 'platform' | 'env'>): boolean {
  if (platform === 'win32') return false;
  if (terminal === 'wisp') return true;
  return terminal === 'auto' && (!!env['WISP_GRID_URL'] || (platform === 'linux' && !env['DISPLAY'] && !env['WAYLAND_DISPLAY']));
}

export interface StepOptions {
  cwd?: string;
  detached?: boolean;
  stdio?: 'ignore';
  windowsVerbatimArguments?: boolean;
}
export type Step = { command: string; args: string[]; options?: StepOptions } | { osa: string } | { delay: number };

export interface PlanArgs extends Lookups {
  cwd: string;
  argv: readonly string[];
  terminal?: string;
  custom?: string;
}

/** The steps that open argv (the agent's resume command) in cwd, in the chosen terminal. */
// size-ok: one case per terminal app, as v1's terminalPlan; splitting it would scatter the table
export function terminalPlan({ cwd, argv, terminal = 'auto', custom = '', platform, env, has, exists }: PlanArgs): Step[] {
  const t = terminal === 'auto' ? detectTerminal({ platform, env, ...(has && { has }), ...(exists && { exists }) }) : terminal;
  const mac = platform === 'darwin';
  const win = platform === 'win32';
  const cmd = argv.map(shq).join(' ');
  const line = `cd ${shq(cwd)} && ${cmd}`;
  // Linux terminals: run the command, then leave an interactive shell open in the project.
  const keepOpen = ['sh', '-c', `${cmd}; exec "\${SHELL:-sh}"`];
  // Windows: `& 'codex' 'resume' 'id'` works for .exe, .cmd and .ps1 alike.
  const ps = `& ${argv.map(psq).join(' ')}`;
  const cmdLine = [escapeCmdCommand(argv[0] ?? ''), ...argv.slice(1).map((a) => escapeCmdArgument(a, true))].join(' ');
  const detached: StepOptions = { cwd, detached: true, stdio: 'ignore' };
  const comspec = env['ComSpec'] || env['COMSPEC'] || 'cmd.exe';

  switch (t) {
    case 'terminal':
      return [{ osa: `tell application "Terminal"\nactivate\ndo script ${asStr(line)}\nend tell` }];
    case 'iterm':
      return [{ osa: `tell application "iTerm"\nactivate\nset w to (create window with default profile)\ntell current session of w to write text ${asStr(line)}\nend tell` }];
    case 'warp':
      // Warp has no scripting API; open a tab in the folder and type via System Events.
      return [{ command: 'open', args: ['-a', 'Warp', cwd] }, { delay: 1200 }, { osa: `tell application "System Events" to keystroke ${asStr(cmd)} & return` }];
    case 'cmux': {
      // `cmux new-workspace` talks to cmux's socket, which by default only accepts processes started
      // inside cmux. When it's refused (or cmux isn't running), open the folder as a new workspace
      // and type the command, like Warp.
      const cli = has?.('cmux') ? 'cmux' : CMUX_CLI;
      const typeIt = `tell application "System Events" to keystroke ${asStr(cmd)} & return`;
      const script = '"$1" new-workspace --cwd "$2" --command "$3" >/dev/null 2>&1 && open -a cmux || { open -a cmux "$2" && sleep 1.5 && osascript -e "$4"; }';
      return [{ command: '/bin/sh', args: ['-c', script, 'sh', cli, cwd, cmd, typeIt], options: detached }];
    }
    case 'wt':
      // `;` separates wt subcommands, so it can't appear unescaped in the command line.
      return [{ command: 'wt.exe', args: ['-d', cwd, 'powershell.exe', '-NoExit', '-Command', ps.replace(/;/g, '\\;')], options: detached }];
    case 'powershell':
      // detached gives the child its own console window on Windows.
      return [{ command: 'powershell.exe', args: ['-NoExit', '-Command', ps], options: detached }];
    case 'cmd':
      return [{ command: comspec, args: ['/d', '/s', '/k', `"${cmdLine}"`], options: { ...detached, windowsVerbatimArguments: true } }];
    case 'ghostty':
      if (mac) return [{ command: 'open', args: ['-na', 'Ghostty', '--args', `--working-directory=${cwd}`, '-e', ...argv] }];
      return [{ command: 'ghostty', args: [`--working-directory=${cwd}`, '-e', ...keepOpen] }];
    case 'kitty':
      if (mac) return [{ command: 'open', args: ['-na', 'kitty', '--args', '--directory', cwd, ...argv] }];
      return [{ command: 'kitty', args: ['--directory', cwd, ...keepOpen] }];
    case 'wezterm': {
      const step: Step = { command: mac ? '/Applications/WezTerm.app/Contents/MacOS/wezterm' : 'wezterm', args: ['start', '--cwd', cwd, '--', ...(win ? ['powershell.exe', '-NoExit', '-Command', ps] : mac ? argv : keepOpen)] };
      return [win ? { ...step, options: detached } : step];
    }
    case 'gnome-terminal':
      return [{ command: 'gnome-terminal', args: [`--working-directory=${cwd}`, '--', ...keepOpen] }];
    case 'konsole':
      return [{ command: 'konsole', args: ['--workdir', cwd, '-e', ...keepOpen] }];
    case 'xfce4-terminal':
      return [{ command: 'xfce4-terminal', args: [`--working-directory=${cwd}`, '-x', ...keepOpen] }];
    case 'alacritty':
      return [{ command: 'alacritty', args: ['--working-directory', cwd, '-e', ...keepOpen] }];
    case 'custom': {
      if (!custom) throw new Error('Set a custom terminal command in settings, e.g.  alacritty --working-directory {cwd} -e {cmd}');
      if (win) {
        const full = custom.replaceAll('{cwd}', `"${cwd}"`).replaceAll('{cmd}', cmdLine).replaceAll('{line}', `cd /d "${cwd}" ^&^& ${cmdLine}`);
        return [{ command: comspec, args: ['/d', '/s', '/c', `"${full}"`], options: { ...detached, windowsVerbatimArguments: true } }];
      }
      const full = custom.replaceAll('{cwd}', shq(cwd)).replaceAll('{cmd}', cmd).replaceAll('{line}', shq(line));
      return [{ command: 'sh', args: ['-c', full], options: detached }];
    }
    case 'wisp':
      throw new Error('In wisp: the page opens the terminal, not a terminal app.');
    default: // x-terminal-emulator (Debian/Ubuntu alternatives), xterm
      return [{ command: t, args: ['-e', ...keepOpen], options: detached }];
  }
}

/** The part of proc that starts a terminal app: detached, its own console, never killed with wisp. */
export interface AppSpawner {
  spawn(bin: string, args: readonly string[], opts: { cwd: string; detached: true; tree: false; stdin: 'ignore'; verbatim?: boolean }): { exited: Promise<unknown> };
}

/** Run the plan. A missing terminal app never crashes the server: its error is swallowed. */
export function openInTerminal(plan: readonly Step[], cwd: string, proc: AppSpawner, later: Later): void {
  let wait = 0;
  for (const step of plan) {
    if ('delay' in step) {
      wait += step.delay;
      continue;
    }
    const run = (): void => {
      const [bin, args] = 'osa' in step ? ['osascript', ['-e', step.osa]] : [step.command, step.args];
      const verbatim = 'options' in step && step.options?.windowsVerbatimArguments === true;
      try {
        proc.spawn(bin, args, { cwd: ('options' in step && step.options?.cwd) || cwd, detached: true, tree: false, stdin: 'ignore', ...(verbatim && { verbatim }) }).exited.catch(() => {});
      } catch {
        // the app isn't there: the route already answered, nothing to tell
      }
    };
    if (wait) later(wait, run);
    else run();
  }
}
