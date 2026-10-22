// Open a command in the user's terminal so they can take over an agent session interactively.
//
// terminalPlan() is pure (platform and PATH lookups are injected) so every platform's command
// line can be tested anywhere; openInTerminal() runs the plan.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { escapeCmdArgument, escapeCmdCommand, onPath } from './proc.js';
import { shq } from './util.js';

// os: which platforms list the entry (all if omitted).
const ALL_TERMINALS = [
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

export const terminalsFor = (platform = process.platform) => ALL_TERMINALS.filter((t) => !t.os || t.os.includes(platform === 'darwin' || platform === 'win32' ? platform : 'linux')).map(({ id, label }) => ({ id, label }));
export const TERMINALS = terminalsFor();

export { shq };
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`; // PowerShell single-quoted string
const asStr = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; // AppleScript string

const CMUX_APP = '/Applications/cmux.app';
const CMUX_CLI = `${CMUX_APP}/Contents/Resources/bin/cmux`;

const LINUX_ORDER = ['ghostty', 'kitty', 'wezterm', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'alacritty', 'x-terminal-emulator', 'xterm'];

export function detectTerminal({ platform = process.platform, env = process.env, has = (b) => onPath(b, env), exists = fs.existsSync } = {}) {
  if (platform === 'darwin') {
    if (env.TERM_PROGRAM === 'iTerm.app' && exists('/Applications/iTerm.app')) return 'iterm';
    // cmux is built on Ghostty and reports TERM_PROGRAM=ghostty, so check it first.
    if ((env.CMUX_WORKSPACE_ID || env.__CFBundleIdentifier === 'com.cmuxterm.app') && exists(CMUX_APP)) return 'cmux';
    if (env.TERM_PROGRAM === 'ghostty' && exists('/Applications/Ghostty.app')) return 'ghostty';
    return 'terminal';
  }
  if (platform === 'win32') return env.WT_SESSION || has('wt') ? 'wt' : 'powershell';
  return LINUX_ORDER.find((t) => has(t)) || 'xterm';
}

// Take over in the page (server/pty.js) instead of a terminal app: when asked to, or on auto where
// there's no desktop to open one on (a wisp Grid, a Linux server reached over SSH).
export function inWisp(terminal = 'auto', { platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') return false;
  if (terminal === 'wisp') return true;
  return terminal === 'auto' && (!!env.WISP_GRID_URL || (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY));
}

// Returns a list of steps: { command, args, options? } to spawn, { osa } to run as AppleScript,
// or { delay } in ms. argv is the agent's resume command, e.g. ['claude', '--resume', 'abc'].
export function terminalPlan({ cwd, argv, terminal = 'auto', custom = '', platform = process.platform, env = process.env, has, exists } = {}) {
  const t = terminal === 'auto' ? detectTerminal({ platform, env, has, exists }) : terminal;
  const mac = platform === 'darwin';
  const win = platform === 'win32';
  const cmd = argv.map(shq).join(' ');
  const line = `cd ${shq(cwd)} && ${cmd}`;
  // Linux terminals: run the command, then leave an interactive shell open in the project.
  const keepOpen = ['sh', '-c', `${cmd}; exec "\${SHELL:-sh}"`];
  // Windows: `& 'codex' 'resume' 'id'` works for .exe, .cmd and .ps1 alike.
  const ps = `& ${argv.map(psq).join(' ')}`;
  const cmdLine = [escapeCmdCommand(argv[0]), ...argv.slice(1).map((a) => escapeCmdArgument(a, true))].join(' ');
  const detached = { cwd, detached: true, stdio: 'ignore' };

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
      const cli = (has || ((b) => onPath(b, env)))('cmux') ? 'cmux' : CMUX_CLI;
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
      return [{ command: env.ComSpec || env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/k', `"${cmdLine}"`], options: { ...detached, windowsVerbatimArguments: true } }];
    case 'ghostty':
      if (mac) return [{ command: 'open', args: ['-na', 'Ghostty', '--args', `--working-directory=${cwd}`, '-e', ...argv] }];
      return [{ command: 'ghostty', args: [`--working-directory=${cwd}`, '-e', ...keepOpen] }];
    case 'kitty':
      if (mac) return [{ command: 'open', args: ['-na', 'kitty', '--args', '--directory', cwd, ...argv] }];
      return [{ command: 'kitty', args: ['--directory', cwd, ...keepOpen] }];
    case 'wezterm':
      return [{ command: mac ? '/Applications/WezTerm.app/Contents/MacOS/wezterm' : 'wezterm', args: ['start', '--cwd', cwd, '--', ...(win ? ['powershell.exe', '-NoExit', '-Command', ps] : mac ? argv : keepOpen)], ...(win ? { options: detached } : {}) }];
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
        return [{ command: env.ComSpec || env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', `"${full}"`], options: { ...detached, windowsVerbatimArguments: true } }];
      }
      const full = custom.replaceAll('{cwd}', shq(cwd)).replaceAll('{cmd}', cmd).replaceAll('{line}', shq(line));
      return [{ command: 'sh', args: ['-c', full], options: detached }];
    }
    case 'wisp':
      throw new Error('In wisp: the page opens the terminal (server/pty.js), not a terminal app.');
    default: // x-terminal-emulator (Debian/Ubuntu alternatives), xterm
      return [{ command: t, args: ['-e', ...keepOpen], options: detached }];
  }
}

export function openInTerminal(opts) {
  const steps = terminalPlan(opts);
  let wait = 0;
  for (const step of steps) {
    if (step.delay) {
      wait += step.delay;
      continue;
    }
    const run = () => {
      const [command, args] = step.osa ? ['osascript', ['-e', step.osa]] : [step.command, step.args];
      const child = spawn(command, args, { cwd: opts.cwd, detached: true, stdio: 'ignore', ...step.options });
      child.on('error', () => {}); // a missing terminal shouldn't crash the server
      child.unref();
    };
    if (wait) setTimeout(run, wait);
    else run();
  }
}
