// The fallback PTY, ported from v1 server/pty.js: Node has no pseudo-terminal of its own and the
// server takes no dependencies, so a small Python helper (pty.fork) runs the program on one, relays
// stdin and stdout, and talks on fd 3: it reads "rows cols" lines to resize, and writes "pid N" once
// the program runs and "exit CODE SIGNAL" when it ends. Without Python, script(1) gives a terminal
// that keeps the size it started with.

import { spawnSync } from 'node:child_process';
import { findExecutable } from '../resolve-command.ts';

export const HELPER = `
import os, pty, select, signal, struct, sys, fcntl, termios
rows, cols = int(sys.argv[1]), int(sys.argv[2])
def size(fd, r, c):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
def tell(line):
    try:
        os.write(3, (line + '\\n').encode())
    except OSError:
        pass
pid, fd = pty.fork()
if pid == 0:
    # The size goes on before the program starts: set only by the parent, it raced the program's
    # first look (stty size said 0 0 on a busy machine).
    try:
        size(0, rows, cols)
    except OSError:
        pass
    try:
        os.close(3)
    except OSError:
        pass
    try:
        os.execvp(sys.argv[3], sys.argv[3:])
    except OSError as e:
        sys.stderr.write('wisp: %s: %s\\r\\n' % (sys.argv[3], e.strerror))
        os._exit(127)
size(fd, rows, cols)
tell('pid %d' % pid)
# Typed input waits here until the terminal takes it: blocking on a write to it while the program
# blocks on printing (nobody reading its output) would hang both.
os.set_blocking(fd, False)
def put(f, data):
    while data:
        n = os.write(f, data)
        data = data[n:]
ctl = b''
typed = b''
watch = [fd, 0, 3]
while True:
    try:
        ready, writable, _ = select.select(watch, [fd] if typed else [], [])
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except BlockingIOError:
            data = None
        except OSError:
            data = b''
        if data == b'':
            break
        if data:
            put(1, data)
    if fd in writable:
        try:
            typed = typed[os.write(fd, typed[:4096]):]
        except BlockingIOError:
            pass
        except OSError:
            typed = b''
    if 0 in ready:
        data = os.read(0, 65536)
        if not data:
            os.kill(pid, signal.SIGHUP)
            break
        typed += data
    if 3 in ready:
        data = os.read(3, 1024)
        if not data:
            watch.remove(3)
        ctl += data
        while b'\\n' in ctl:
            line, ctl = ctl.split(b'\\n', 1)
            try:
                r, c = map(int, line.split())
                size(fd, r, c)
            except (ValueError, OSError):
                pass
_, status = os.waitpid(pid, 0)
if os.WIFSIGNALED(status):
    tell('exit - ' + signal.Signals(os.WTERMSIG(status)).name)
    sys.exit(128 + os.WTERMSIG(status))
tell('exit %d -' % os.WEXITSTATUS(status))
sys.exit(os.WEXITSTATUS(status))
`;

type Env = Readonly<Record<string, string | undefined>>;
type Run = (cmd: string, args: string[], opts: { stdio: 'ignore'; timeout?: number }) => { status: number | null };

const found = new Map<string, string | null>();

/**
 * A Python 3 that can run the helper, or null. On a Mac without the developer tools,
 * /usr/bin/python3 is only a stub that offers to install them, so it counts only once they're there.
 */
export function python({ platform = process.platform, env = process.env as Env, run = spawnSync as Run }: { platform?: string; env?: Env; run?: Run } = {}): string | null {
  const key = `${platform}\0${env['WISP_PYTHON'] ?? ''}\0${env['PATH'] ?? ''}`;
  const cached = found.get(key);
  if (cached !== undefined) return cached;
  let bin = env['WISP_PYTHON'] ?? (findExecutable('python3', env, platform) ? 'python3' : null);
  if (bin) {
    const stub = platform === 'darwin' && !env['WISP_PYTHON'] && run('/usr/bin/xcode-select', ['-p'], { stdio: 'ignore' }).status !== 0;
    if (stub || run(bin, ['-c', 'import pty, termios'], { stdio: 'ignore', timeout: 5000 }).status !== 0) bin = null;
  }
  found.set(key, bin);
  return bin;
}

const shq = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export interface PtyPlan {
  command: string;
  args: string[];
  /** the Python helper resizes and reports on fd 3; script(1) does neither */
  helper: boolean;
}

/**
 * macOS script(1) dies on a socket for stdin ("tcgetattr/ioctl: Operation not supported on
 * socket"), and Node's stdio pipes are socketpairs, as are macOS FIFOs. A shell pipe is a real
 * pipe, so `cat` feeds script through one; when script ends, cat is killed so the shell doesn't
 * wait on it, and script's status is the exit status. (v1's script fallback failed this way.)
 */
export const DARWIN_SCRIPT = `f=$(mktemp) || exit 127; sh -c 'echo $$ > "$0"; exec cat' "$f" | { script -q /dev/null sh -c "$1"; s=$?; kill "$(cat "$f")" 2>/dev/null; rm -f "$f"; exit $s; }`;

/** How to start argv on a terminal of cols × rows. */
export function ptyCommand(argv: readonly string[], { cols, rows, platform = process.platform, py }: { cols: number; rows: number; platform?: string; py: string | null }): PtyPlan {
  if (py) return { command: py, args: ['-c', HELPER, String(rows), String(cols), ...argv], helper: true };
  const line = `stty rows ${rows} cols ${cols} 2>/dev/null; exec ${argv.map(shq).join(' ')}`;
  if (platform === 'darwin') return { command: 'sh', args: ['-c', DARWIN_SCRIPT, 'sh', line], helper: false };
  return { command: 'script', args: ['-qfec', line, '/dev/null'], helper: false }; // util-linux
}

/** One fd-3 line from the helper. */
export type HelperNote = { pid: number } | { code: number | null; signal: string | null } | null;

export function parseNote(line: string): HelperNote {
  const pid = /^pid (\d+)$/.exec(line);
  if (pid) return { pid: Number(pid[1]) };
  const exit = /^exit (-|\d+) (-|SIG[A-Z0-9]+)$/.exec(line);
  if (!exit) return null;
  return { code: exit[1] === '-' ? null : Number(exit[1]), signal: exit[2] === '-' ? null : (exit[2] ?? null) };
}
