// wisp-rootd: root in a sandbox, for its user (uid 1000) only. `sudo` (the image's client) sends a
// command line; this runs it as root and streams its output back. Started by wisp-sandbox-init.
// Line-framed JSON: in { argv, cwd, env } then { i: base64 } / { eof: true }; out { o | e: base64 },
// then { x: exit code }.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

const SOCK = '/run/wisp/root.sock';
const PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'; // sudo's secure_path: apt's wrapper first
fs.rmSync(SOCK, { force: true });
const srv = net.createServer((c) => {
  let buf = '';
  let child = null;
  const send = (m) => c.writable && c.write(`${JSON.stringify(m)}\n`);
  c.on('error', () => child?.kill());
  c.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; ) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        return c.destroy();
      }
      if (!child) {
        if (!Array.isArray(m.argv) || !m.argv.length) return c.destroy();
        const env = { ...(m.env || {}), PATH, HOME: '/root', USER: 'root', LOGNAME: 'root', SUDO_USER: 'node', SUDO_UID: '1000', SUDO_GID: '1000' };
        child = spawn(String(m.argv[0]), m.argv.slice(1).map(String), { cwd: fs.existsSync(m.cwd || '') ? m.cwd : '/', env, stdio: 'pipe' });
        child.stdout.on('data', (x) => send({ o: x.toString('base64') }));
        child.stderr.on('data', (x) => send({ e: x.toString('base64') }));
        child.stdin.on('error', () => {});
        child.on('error', (err) => {
          send({ e: Buffer.from(`sudo: ${m.argv[0]}: ${err.code === 'ENOENT' ? 'command not found' : err.message}\n`).toString('base64') });
          send({ x: err.code === 'ENOENT' ? 127 : 1 });
          c.end();
        });
        child.on('close', (code, sig) => {
          send({ x: code ?? 128 + (sig === 'SIGKILL' ? 9 : 15) });
          c.end();
        });
        c.on('close', () => child.exitCode === null && child.kill());
      } else if (m.i) child.stdin.write(Buffer.from(m.i, 'base64'));
      else if (m.eof) child.stdin.end();
    }
  });
});
srv.listen(SOCK, () => {
  fs.chownSync(SOCK, 1000, 1000); // only the box's user
  fs.chmodSync(SOCK, 0o600);
});
