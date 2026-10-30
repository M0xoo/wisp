// Terminals inside wisp: take over a session in the page instead of a terminal app, which a
// wisp Grid (or any server without a desktop) doesn't have.
//
// Node has no pseudo-terminal of its own and wisp takes no dependencies, so a small Python helper
// (pty.fork) runs the command on one, relays stdin and stdout, and reads "rows cols" lines on fd 3
// to resize it. Without Python, script(1) gives a terminal that keeps the size it started with.
// One terminal per session (Terms); its output is kept so a page that opens later sees the screen.

import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { onPath } from './proc.js';
import { shq } from './util.js';

const KEEP = 1 << 20; // characters of output replayed to a page that attaches later
const GONE_MS = 10 * 60_000; // an exited terminal is forgotten after this
const PING_MS = 25_000; // keeps proxies (a machine's tunnel, the grid's edge) from timing the stream out
const GAP_MS = 1000; // a numbered key that never came (its send failed) is waited for this long
export const ACTIVE_MS = 15 * 60_000; // a terminal used this recently keeps a cloud computer awake

// Sessions with a terminal running, for their summaries (term: true), here and on other devices.
export const openTerms = new Set();

const HELPER = `
import os, pty, select, signal, struct, sys, fcntl, termios
rows, cols = int(sys.argv[1]), int(sys.argv[2])
def size(fd, r, c):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
pid, fd = pty.fork()
if pid == 0:
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
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
`;

// Python 3 that can be run. On a Mac without the developer tools, /usr/bin/python3 is only a stub
// that offers to install them, so it counts only once they're there.
let pythonCache;
export function python({ platform = process.platform, env = process.env, has = (b) => onPath(b, env), run = spawnSync } = {}) {
  if (pythonCache !== undefined && arguments.length === 0) return pythonCache;
  let found = null;
  const bin = env.WISP_PYTHON || (has('python3') ? 'python3' : null);
  if (bin) {
    const stub = platform === 'darwin' && !env.WISP_PYTHON && run('/usr/bin/xcode-select', ['-p'], { stdio: 'ignore' }).status !== 0;
    if (!stub && run(bin, ['-c', 'import pty, termios'], { stdio: 'ignore', timeout: 5000 }).status === 0) found = bin;
  }
  if (arguments.length === 0) pythonCache = found;
  return found;
}

// Whether this computer can run a terminal for the page at all (no pty on Windows).
export const ptySupported = (platform = process.platform) => platform !== 'win32';

// How to start argv on a terminal of cols × rows: [command, args, resizable].
export function ptyCommand(argv, { cols = 100, rows = 30, platform = process.platform, py = python() } = {}) {
  if (py) return [py, ['-c', HELPER, String(rows), String(cols), ...argv], true];
  const line = `stty rows ${rows} cols ${cols} 2>/dev/null; ${argv.map(shq).join(' ')}`;
  if (platform === 'darwin') return ['script', ['-q', '/dev/null', 'sh', '-c', line], false];
  return ['script', ['-qfec', line, '/dev/null'], false]; // util-linux
}

// What a Claude Code session that started wisp (`npm run dev:web` from its terminal) leaves in the
// environment. An interactive claude that inherits them thinks it's that session's child and keeps no
// transcript, so the conversation can't be resumed. Only these: CLAUDE_CODE_USE_BEDROCK and such are
// the user's own settings.
export const PARENT_SESSION_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID'];

// t's output as one string of at most KEEP characters. Cut from the start of a line or an escape
// sequence near the limit, so a replay doesn't begin with half of one printed as text.
function keep(t) {
  let out = t.chunks.length === 1 ? t.chunks[0] : t.chunks.join('');
  if (out.length > KEEP) {
    const from = out.length - KEEP;
    const near = out.slice(from, from + 4096).search(/[\n\x1b]/);
    out = out.slice(near < 0 ? from : from + near + (out[from + near] === '\n' ? 1 : 0));
  }
  t.chunks = out ? [out] : [];
  t.kept = out.length;
  return out;
}

const clampSize = (n, lo, hi, d) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Math.round(Number(n)))) : d);

export class Terms {
  // onChange(id): a terminal opened or ended (its session's summary changed). track: the set that
  // marks its session "In terminal" (a take over); null for a shell beside the task (app.shells).
  constructor({ spawnFn = spawn, env = process.env, onChange = () => {}, track = openTerms } = {}) {
    this.spawnFn = spawnFn;
    this.env = env;
    this.onChange = onChange;
    this.track = track;
    this.map = new Map(); // session id -> terminal
  }

  get(id) {
    return this.map.get(id) || null;
  }

  // Start a terminal for session id, or return the one still running. argv runs in cwd.
  open(id, { argv, cwd, cols, rows }) {
    const live = this.map.get(id);
    if (live && live.code === null) return live;
    if (live) this.#forget(id);
    cols = clampSize(cols, 20, 500, 100);
    rows = clampSize(rows, 5, 200, 30);
    const [command, args, resizable] = ptyCommand(argv, { cols, rows });
    const env = { ...this.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'wisp' };
    delete env.NO_COLOR;
    for (const k of PARENT_SESSION_ENV) delete env[k];
    const child = this.spawnFn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    const t = {
      id, child, cwd, cols, rows, resizable, code: null, startedAt: Date.now(), usedAt: Date.now(), clients: new Set(), timer: null,
      // What it printed: chunks, joined and cut to KEEP only when read or twice too long (cutting
      // on every chunk copied the whole megabyte each time).
      chunks: [], kept: 0,
      get out() {
        return keep(this);
      },
    };
    const dec = new StringDecoder('utf8');
    const emit = (text) => {
      if (!text) return;
      t.chunks.push(text);
      t.kept += text.length;
      if (t.kept > 2 * KEEP) keep(t);
      t.usedAt = Date.now();
      const frame = `event: data\ndata: ${JSON.stringify(text)}\n\n`;
      for (const res of t.clients) res.write(frame);
    };
    child.stdout.on('data', (d) => emit(dec.write(d)));
    child.stderr.on('data', (d) => emit(String(d).replace(/\r?\n/g, '\r\n')));
    for (const s of [child.stdin, child.stdio[3]]) s?.on('error', () => {});
    const end = (code) => {
      if (t.code !== null) return;
      emit(dec.end());
      t.code = code ?? 1;
      this.track?.delete(id);
      this.onChange(id);
      for (const res of t.clients) res.write(`event: exit\ndata: ${JSON.stringify({ code: t.code })}\n\n`);
      t.timer = setTimeout(() => this.map.get(id) === t && this.#forget(id), GONE_MS);
      t.timer.unref?.();
    };
    child.on('error', (e) => (emit(`wisp: couldn’t start a terminal (${e.message})\r\n`), end(127)));
    child.on('exit', (code, signal) => end(code ?? (signal ? 129 : 1)));
    this.map.set(id, t);
    this.track?.add(id);
    this.onChange(id);
    return t;
  }

  // Server-sent events: hello (start over), data (output, a JSON string), exit ({ code }).
  attach(id, req, res) {
    const t = this.map.get(id);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    if (!t) {
      res.end(`event: gone\ndata: {}\n\n`);
      return;
    }
    // ordered: numbered input goes in in order (input()), so the page needn't wait between sends.
    res.write(`event: hello\ndata: ${JSON.stringify({ cols: t.cols, rows: t.rows, resizable: t.resizable, ordered: true })}\n\n`);
    res.write(`event: data\ndata: ${JSON.stringify(t.out)}\n\n`); // always, even empty: the page replays it
    if (t.code !== null) return res.end(`event: exit\ndata: ${JSON.stringify({ code: t.code })}\n\n`);
    t.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
    res.on('close', () => (clearInterval(ping), t.clients.delete(res)));
  }

  // Typed text. A page sends keys without waiting for the last send to answer (each round trip to a
  // cloud computer would hold up the next key): numbered (seq, counted per page: from), they may
  // arrive out of order and go in in order. A gap (a send that failed) is skipped after GAP_MS.
  input(id, data, { seq, from } = {}) {
    const t = this.map.get(id);
    if (!t || t.code !== null) return false;
    t.usedAt = Date.now();
    if (!Number.isInteger(seq) || typeof from !== 'string') {
      t.child.stdin.write(String(data));
      return true;
    }
    t.senders ||= new Map();
    let q = t.senders.get(from);
    if (!q) {
      if (t.senders.size >= 8) t.senders.delete(t.senders.keys().next().value);
      t.senders.set(from, (q = { next: 0, held: new Map(), timer: null }));
    }
    if (seq < q.next) return true; // sent again
    q.held.set(seq, String(data));
    const flush = (skip) => {
      if (skip && q.held.size) q.next = Math.min(...q.held.keys());
      while (q.held.has(q.next)) {
        if (t.code === null) t.child.stdin.write(q.held.get(q.next));
        q.held.delete(q.next++);
      }
      clearTimeout(q.timer);
      q.timer = q.held.size ? setTimeout(() => flush(true), GAP_MS) : null;
      q.timer?.unref?.();
    };
    flush(false);
    return true;
  }

  resize(id, cols, rows) {
    const t = this.map.get(id);
    if (!t || t.code !== null || !t.resizable) return false;
    t.cols = clampSize(cols, 20, 500, t.cols);
    t.rows = clampSize(rows, 5, 200, t.rows);
    t.child.stdio[3]?.write(`${t.rows} ${t.cols}\n`);
    return true;
  }

  close(id) {
    const t = this.map.get(id);
    if (!t) return false;
    if (t.code === null) t.child.kill('SIGHUP');
    this.#forget(id);
    return true;
  }

  // Running terminals someone used lately (a cloud computer stays up for them).
  active(now = Date.now()) {
    return [...this.map.values()].filter((t) => t.code === null && (t.clients.size || now - t.usedAt < ACTIVE_MS)).length;
  }

  closeAll() {
    for (const id of [...this.map.keys()]) this.close(id);
  }

  #forget(id) {
    const t = this.map.get(id);
    if (!t) return;
    clearTimeout(t.timer);
    for (const q of t.senders?.values() || []) clearTimeout(q.timer);
    for (const res of t.clients) res.end(`event: gone\ndata: {}\n\n`);
    this.map.delete(id);
    if (this.track?.delete(id)) this.onChange(id);
  }
}
