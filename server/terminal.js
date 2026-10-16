// Open a command in the user's terminal so they can take over an agent session interactively.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';

export const TERMINALS = [
  { id: 'auto', label: 'Auto-detect' },
  { id: 'terminal', label: 'Terminal.app', mac: true },
  { id: 'iterm', label: 'iTerm', mac: true, app: '/Applications/iTerm.app' },
  { id: 'ghostty', label: 'Ghostty', app: '/Applications/Ghostty.app', bin: 'ghostty' },
  { id: 'warp', label: 'Warp', mac: true, app: '/Applications/Warp.app' },
  { id: 'kitty', label: 'kitty', app: '/Applications/kitty.app', bin: 'kitty' },
  { id: 'wezterm', label: 'WezTerm', app: '/Applications/WezTerm.app', bin: 'wezterm' },
  { id: 'custom', label: 'Custom command' },
];

export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const has = (bin) => {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

function detect() {
  if (process.platform === 'darwin') {
    if (process.env.TERM_PROGRAM === 'iTerm.app' && fs.existsSync('/Applications/iTerm.app')) return 'iterm';
    if (process.env.TERM_PROGRAM === 'ghostty' && fs.existsSync('/Applications/Ghostty.app')) return 'ghostty';
    return 'terminal';
  }
  for (const t of ['ghostty', 'kitty', 'wezterm']) if (has(t)) return t;
  return 'x-terminal-emulator';
}

const osa = (script) => spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
const asStr = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// argv: the agent's resume command, e.g. ['claude', '--resume', 'abc'].
export function openInTerminal({ cwd, argv, terminal = 'auto', custom = '' }) {
  const cmd = argv.map(shq).join(' ');
  const line = `cd ${shq(cwd)} && ${cmd}`;
  const t = terminal === 'auto' ? detect() : terminal;
  const mac = process.platform === 'darwin';

  switch (t) {
    case 'terminal':
      return osa(`tell application "Terminal"\nactivate\ndo script ${asStr(line)}\nend tell`);
    case 'iterm':
      return osa(`tell application "iTerm"\nactivate\nset w to (create window with default profile)\ntell current session of w to write text ${asStr(line)}\nend tell`);
    case 'warp':
      // Warp has no scripting API; open a tab in the folder and type via System Events.
      spawn('open', ['-a', 'Warp', cwd], { detached: true, stdio: 'ignore' }).unref();
      return setTimeout(() => osa(`tell application "System Events" to keystroke ${asStr(cmd)} & return`), 1200);
    case 'ghostty':
      if (mac) return spawn('open', ['-na', 'Ghostty', '--args', `--working-directory=${cwd}`, '-e', ...argv], { detached: true, stdio: 'ignore' }).unref();
      return spawn('ghostty', [`--working-directory=${cwd}`, '-e', ...argv], { detached: true, stdio: 'ignore' }).unref();
    case 'kitty':
      if (mac) return spawn('open', ['-na', 'kitty', '--args', '--directory', cwd, ...argv], { detached: true, stdio: 'ignore' }).unref();
      return spawn('kitty', ['--directory', cwd, ...argv], { detached: true, stdio: 'ignore' }).unref();
    case 'wezterm':
      return spawn(mac ? '/Applications/WezTerm.app/Contents/MacOS/wezterm' : 'wezterm', ['start', '--cwd', cwd, '--', ...argv], { detached: true, stdio: 'ignore' }).unref();
    case 'custom': {
      if (!custom) throw new Error('Set a custom terminal command in settings, e.g.  alacritty --working-directory {cwd} -e {cmd}');
      const full = custom.replaceAll('{cwd}', shq(cwd)).replaceAll('{cmd}', cmd).replaceAll('{line}', shq(line));
      return spawn('sh', ['-c', full], { detached: true, stdio: 'ignore' }).unref();
    }
    default:
      return spawn('x-terminal-emulator', ['-e', 'sh', '-c', `${line}; exec $SHELL`], { detached: true, stdio: 'ignore' }).unref();
  }
}
