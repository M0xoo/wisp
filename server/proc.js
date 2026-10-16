// Cross-platform process launching. On macOS/Linux this is a thin wrapper over spawn(). On
// Windows, CLIs installed through npm (claude, codex, opencode…) are `.cmd` shims, which
// spawn() can't start without a shell. Wrapping them in cmd.exe would mangle arguments wisp
// passes (JSON, newlines in the system prompt), so npm shims are unwrapped into
// `node <script>` and only unknown batch files go through cmd.exe, with careful escaping.

import { spawn as nodeSpawn, execFile as nodeExecFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Find `bin` on PATH the way cmd.exe would (PATHEXT). Returns an absolute path or null.
// A copied env object loses Windows' case-insensitive keys, so PATH may be spelled "Path".
export function whichWindows(bin, env = process.env) {
  const p = path.win32;
  const exts = (env.PATHEXT || env.Pathext || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase());
  // .ps1 isn't in PATHEXT, but some installers (Cursor) only drop a PowerShell script.
  const names = p.extname(bin) ? [bin] : [...exts.map((e) => bin + e), bin + '.ps1'];
  const dirs = /[\\/]/.test(bin) ? [''] : (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const full = dir ? p.join(dir, name) : name;
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {}
    }
  }
  return null;
}

// npm/pnpm/yarn `.cmd` shims end by running node on a script, or by running the target directly:
//   ... & "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
//   "%~dp0\node.exe"  "%~dp0\..\opencode-ai\bin\opencode" %*
//   "%dp0%\node_modules\some-cli\bin\tool.exe"   %*
// Returns { script } or { exe }, relative to the shim's folder, or null if it isn't recognisable.
export function parseCmdShim(text) {
  const line = String(text).split(/\r?\n/).map((l) => l.trim()).findLast((l) => /%\*$/.test(l));
  if (!line) return null;
  const quoted = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const fromDp0 = (s) => s?.match(/^%~?dp0%?\\?(.+)$/i)?.[1] ?? null;
  const target = fromDp0(quoted.at(-1));
  if (!target) return null;
  const prog = quoted.length > 1 ? quoted.at(-2) : '';
  if (/^%_prog%$|(^|\\)node(\.exe)?$/i.test(prog) || /\.[cm]?js$/i.test(target)) return { script: target };
  if (/\.(exe|com)$/i.test(target)) return { exe: target };
  return null;
}

// cmd.exe escaping, as in cross-spawn: quote for CommandLineToArgvW, then caret-escape cmd's
// metacharacters (twice when the target is itself a batch file, which re-parses its line).
const META = /([()\][%!^"`<>&|;, *?])/g;
export const escapeCmdCommand = (s) => String(s).replace(META, '^$1');
export function escapeCmdArgument(arg, doubleEscape = false) {
  let s = String(arg);
  s = s.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  s = s.replace(/(?=(\\+?)?)\1$/, '$1$1');
  s = `"${s}"`.replace(META, '^$1');
  return doubleEscape ? s.replace(META, '^$1') : s;
}

// Resolve `bin args` into something spawn() can run directly on this platform.
// Returns { command, args, verbatim }; verbatim => pass windowsVerbatimArguments.
export function resolveCommand(bin, args = [], { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return { command: bin, args, verbatim: false };
  const file = whichWindows(bin, env);
  if (!file) return { command: bin, args, verbatim: false }; // let spawn report ENOENT
  const ext = path.win32.extname(file).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { command: file, args, verbatim: false };
  if (ext === '.ps1') {
    return { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], verbatim: false };
  }
  if (ext === '.cmd' || ext === '.bat') {
    let shim = null;
    try {
      shim = parseCmdShim(fs.readFileSync(file, 'utf8'));
    } catch {}
    const dir = path.win32.dirname(file);
    if (shim?.exe) {
      const exe = path.win32.resolve(dir, shim.exe);
      if (fs.existsSync(exe)) return { command: exe, args, verbatim: false };
    }
    if (shim?.script) {
      const script = path.win32.resolve(dir, shim.script);
      if (fs.existsSync(script)) {
        const localNode = path.win32.join(dir, 'node.exe');
        return { command: fs.existsSync(localNode) ? localNode : whichWindows('node', env) || 'node', args: [script, ...args], verbatim: false };
      }
    }
    // Unknown batch file: go through cmd.exe. Newlines can't survive cmd's parser.
    const line = [escapeCmdCommand(file), ...args.map((a) => escapeCmdArgument(String(a).replace(/\r?\n/g, ' '), true))].join(' ');
    return { command: env.ComSpec || env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
  }
  return { command: file, args, verbatim: false };
}

export function spawn(bin, args, opts = {}) {
  const r = resolveCommand(bin, args, { env: opts.env || process.env });
  return nodeSpawn(r.command, r.args, { ...opts, windowsHide: true, windowsVerbatimArguments: r.verbatim });
}

export function execFile(bin, args, opts, cb) {
  const r = resolveCommand(bin, args, { env: opts?.env || process.env });
  return nodeExecFile(r.command, r.args, { ...opts, windowsHide: true, windowsVerbatimArguments: r.verbatim }, cb);
}

// Stop a child and everything it started. On Windows, kill() only ends the direct child
// (e.g. node, leaving the agent's own subprocesses running), so use taskkill /T.
export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    const r = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    if (r.status === 0) return;
  }
  child.kill('SIGTERM');
}

// Is `bin` runnable from PATH?
export function onPath(bin, env = process.env) {
  if (process.platform === 'win32') return !!whichWindows(bin, env);
  return (env.PATH || '').split(path.delimiter).some((d) => {
    try {
      fs.accessSync(path.join(d, bin), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
