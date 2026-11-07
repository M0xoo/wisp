// Making a command runnable on Windows (ported from v1 server/proc.js). CLIs installed through npm
// (claude, codex, opencode…) are `.cmd` shims, which can't be started without a shell; wrapping
// them in cmd.exe would mangle what wisp passes (JSON, newlines in a system prompt). So npm shims
// are unwrapped into `node <script>`, and only unknown batch files go through cmd.exe, escaped.
// Off Windows every function here is a pass-through.

import fs from 'node:fs';
import path from 'node:path';

type Env = Readonly<Record<string, string | undefined>>;

export interface Resolved {
  command: string;
  args: string[];
  /** the args are already quoted for cmd.exe: pass them as written */
  verbatim: boolean;
}

const isFile = (file: string): boolean => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** `bin` on PATH the way cmd.exe finds it (PATHEXT). A copied env may spell PATH "Path". */
export function whichWindows(bin: string, env: Env): string | null {
  const p = path.win32;
  const exts = (env['PATHEXT'] ?? env['Pathext'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase());
  // .ps1 isn't in PATHEXT, but some installers (Cursor) only drop a PowerShell script.
  const names = p.extname(bin) ? [bin] : [...exts.map((e) => bin + e), `${bin}.ps1`];
  const dirs = /[\\/]/.test(bin) ? [''] : (env['PATH'] ?? env['Path'] ?? '').split(';').filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const full = dir ? p.join(dir, name) : name;
      if (isFile(full)) return full;
    }
  }
  return null;
}

export type Shim = { script: string } | { exe: string };

/**
 * npm/pnpm/yarn `.cmd` shims end by running node on a script, or the target directly:
 *   ... & "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
 *   "%~dp0\node.exe"  "%~dp0\..\opencode-ai\bin\opencode" %*
 *   "%dp0%\node_modules\some-cli\bin\tool.exe"   %*
 * The target is relative to the shim's folder; null when the shim isn't recognisable.
 */
export function parseCmdShim(text: string): Shim | null {
  const line = text.split(/\r?\n/).map((l) => l.trim()).findLast((l) => /%\*$/.test(l));
  if (!line) return null;
  const quoted = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
  const target = /^%~?dp0%?\\?(.+)$/i.exec(quoted.at(-1) ?? '')?.[1];
  if (!target) return null;
  const prog = quoted.length > 1 ? (quoted.at(-2) ?? '') : '';
  if (/^%_prog%$|(^|\\)node(\.exe)?$/i.test(prog) || /\.[cm]?js$/i.test(target)) return { script: target };
  if (/\.(exe|com)$/i.test(target)) return { exe: target };
  return null;
}

// cmd.exe escaping, as in cross-spawn: quote for CommandLineToArgvW, then caret-escape cmd's
// metacharacters (twice when the target is itself a batch file, which re-parses its line).
const META = /([()\][%!^"`<>&|;, *?])/g;
export const escapeCmdCommand = (s: string): string => s.replace(META, '^$1');
export function escapeCmdArgument(arg: string, doubleEscape = false): string {
  let s = arg;
  s = s.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  s = s.replace(/(?=(\\+?)?)\1$/, '$1$1');
  s = `"${s}"`.replace(META, '^$1');
  return doubleEscape ? s.replace(META, '^$1') : s;
}

function fromShim(file: string, args: readonly string[], env: Env): Resolved | null {
  let shim: Shim | null = null;
  try {
    shim = parseCmdShim(fs.readFileSync(file, 'utf8'));
  } catch {}
  const dir = path.win32.dirname(file);
  if (shim && 'exe' in shim) {
    const exe = path.win32.resolve(dir, shim.exe);
    if (fs.existsSync(exe)) return { command: exe, args: [...args], verbatim: false };
  }
  if (shim && 'script' in shim) {
    const script = path.win32.resolve(dir, shim.script);
    if (fs.existsSync(script)) {
      const localNode = path.win32.join(dir, 'node.exe');
      const node = fs.existsSync(localNode) ? localNode : (whichWindows('node', env) ?? 'node');
      return { command: node, args: [script, ...args], verbatim: false };
    }
  }
  return null;
}

/** `bin args` as something a process can be started from directly on this platform. */
export function resolveCommand(bin: string, args: readonly string[], { platform = process.platform, env = process.env }: { platform?: string; env?: Env } = {}): Resolved {
  if (platform !== 'win32') return { command: bin, args: [...args], verbatim: false };
  const file = whichWindows(bin, env);
  if (!file) return { command: bin, args: [...args], verbatim: false }; // the spawn reports it missing
  const ext = path.win32.extname(file).toLowerCase();
  if (ext === '.ps1') {
    return { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], verbatim: false };
  }
  if (ext !== '.cmd' && ext !== '.bat') return { command: file, args: [...args], verbatim: false };
  const shim = fromShim(file, args, env);
  if (shim) return shim;
  // An unknown batch file: through cmd.exe. Newlines can't survive cmd's parser.
  const line = [escapeCmdCommand(file), ...args.map((a) => escapeCmdArgument(a.replace(/\r?\n/g, ' '), true))].join(' ');
  return { command: env['ComSpec'] ?? env['COMSPEC'] ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

/** Is `bin` runnable from PATH (or, with a slash, as a path)? Used to fail a spawn the same way on both backends. */
export function findExecutable(bin: string, env: Env, platform: string = process.platform): string | null {
  if (platform === 'win32') return whichWindows(bin, env);
  const runnable = (file: string): boolean => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };
  if (bin.includes('/')) return runnable(bin) ? bin : null;
  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (dir && runnable(path.join(dir, bin))) return path.join(dir, bin);
  }
  return null;
}
