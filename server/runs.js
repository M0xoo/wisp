// Run the app: a task's dev server, started from its folder (its worktree) and shown in the side
// panel's Preview (web/js/features/run.js), as Conductor's Run script or Vibe Kanban's preview.
// One per task. The command comes from .wisp/worktree.json's run (worktree-setup.js runCommand),
// a repo's Conductor run script, a guess from package.json, or the page. It runs in a process group
// of its own (on Windows its tree goes with taskkill /T) with PORT set to a port wisp picks for the
// task (stable while it's free), or the config's. Its output's last lines are kept; the first local
// address it prints is where it listens, else PORT.
//
// The panel shows the app through a small proxy on a port of its own (proxy below): the same app,
// minus X-Frame-Options and CSP frame-ancestors, with one script added to its pages that lets the
// panel pick an element (PICK_JS: hover outlines, a click describes the element to the panel). The
// proxy is its own origin, as the app is: wisp's API stays out of the app's reach. Websockets
// (live reload) go straight through.

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import { askLocal, failedPage, previewAnswer, previewUpgrade } from './http/preview.js';

const MAX_LINES = 2000;
const LINE_MAX = 2000; // characters: a minified bundle printed whole isn't a log line
const TAIL = 300; // lines GET /run gives; the log stream has them all
const APP_BASE = 41000; // the task's port: APP_BASE + its id's hash, the next free one if taken
const PROXY_BASE = 42000;
const SPAN = 900;
const STOP_GRACE_MS = 3000;
const PICK_PATH = '/__wisp/pick.js';
const HTML_MAX = 8 * 1024 * 1024;

const win = process.platform === 'win32';
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})(\/[^\s'"<>`)]*)?/i;

// The first local address a line says the app listens on: { port, path }.
export function urlIn(line) {
  const m = String(line || '').match(URL_RE);
  const port = m && Number(m[1]);
  if (!port || port > 65535) return null;
  return { port, path: (m[2] || '/').replace(/[.,;:]+$/, '') || '/' };
}

// One line of output: colours and cursor moves out, a \r-redrawn line as it ended up.
export function cleanLine(l) {
  let t = String(l).replace(ANSI, '').replace(/\r$/, '');
  if (t.includes('\r')) t = t.slice(t.lastIndexOf('\r') + 1);
  return t.length > LINE_MAX ? `${t.slice(0, LINE_MAX)}…` : t;
}

const hash = (s) => [...String(s)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
const listenable = (port) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen({ port, host: '127.0.0.1', exclusive: true }, () => s.close(() => resolve(true)));
  });
const answers = (port, timeout = 400) =>
  new Promise((resolve) => {
    const c = net.connect({ host: 'localhost', port, autoSelectFamily: true });
    const done = (v) => (c.destroy(), resolve(v));
    c.setTimeout(timeout, () => done(false));
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
  });

// The port a key asks for first.
export const taskPort = (key) => APP_BASE + hash(key) % SPAN;
const block = (port, width) => Array.from({ length: width }, (_, i) => port + i);
const allFree = async (ports, taken) => {
  for (const p of ports) if (taken.has(p) || !(await listenable(p)) || (await answers(p, 150))) return false;
  return true;
};

// A port for the task: the same one each time while it's free, so the app keeps its storage.
// width: how many in a row it needs, from that one up.
async function pickPort(key, base, taken, width = 1) {
  const h = hash(key);
  for (let i = 0; i < 60; i++) {
    const p = base + ((h + i) % SPAN);
    if (await allFree(block(p, width), taken)) return p;
  }
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Without frame-ancestors (the panel frames it); every other rule stays.
export function frameable(headers) {
  const h = { ...headers };
  delete h['x-frame-options'];
  const csp = h['content-security-policy'];
  if (csp) {
    const strip = (v) =>
      String(v)
        .split(';')
        .filter((d) => !/^\s*frame-ancestors\b/i.test(d))
        .join(';')
        .trim();
    const out = [].concat(csp).map(strip).filter(Boolean);
    if (out.length) h['content-security-policy'] = out;
    else delete h['content-security-policy'];
  }
  return h;
}

// The picker's script tag, as early in the page as it can go.
export function withPicker(html) {
  const tag = `<script src="${PICK_PATH}"></script>`;
  if (html.includes(PICK_PATH)) return html;
  const at = html.match(/<head\b[^>]*>/i) || html.match(/<html\b[^>]*>/i);
  if (at) return html.slice(0, at.index + at[0].length) + tag + html.slice(at.index + at[0].length);
  return tag + html;
}

export class Runs {
  constructor({ onChange } = {}) {
    this.map = new Map(); // task id -> its run
    this.onChange = onChange || (() => {});
  }

  get(id) {
    return this.map.get(id);
  }

  running(id) {
    const r = this.map.get(id);
    return !!r && !r.exited;
  }

  active() {
    return [...this.map.values()].filter((r) => !r.exited).length;
  }

  // What GET /sessions/:id/run says about it (null: never run since wisp started).
  view(id, lines = TAIL) {
    const r = this.map.get(id);
    if (!r) return null;
    const all = r.partial ? [...r.lines, cleanLine(r.partial)] : r.lines;
    const on = r.url || { port: r.port, path: '/' };
    return {
      command: r.command,
      dir: r.dir,
      running: !r.exited,
      ready: r.ready,
      port: r.port,
      url: `http://localhost:${on.port}${on.path}`,
      proxyUrl: r.proxy && !r.exited ? `http://localhost:${r.proxyPort}${on.path}` : null,
      exitCode: r.code,
      signal: r.signal,
      stopped: r.stopped,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      tail: all.slice(-lines).join('\n'),
      lineCount: r.count,
    };
  }

  // Start the app in dir. Stops the one running first. portKey: what its port hangs on (the task).
  // ports: how many in a row it gets, from PORT up. envFor(port): more env, once PORT is known.
  async start(id, { dir, command, port: fixed = null, env = process.env, portKey = id, ports = 1, envFor }) {
    if (this.running(id)) await this.stop(id);
    const taken = new Set([...this.map.values()].filter((r) => !r.exited).flatMap((r) => [...block(r.port, r.ports), r.proxyPort]));
    const port = fixed || (await pickPort(portKey, APP_BASE, taken, ports));
    for (const p of block(port, ports)) taken.add(p);
    const proxyPort = await pickPort(`${id}:proxy`, PROXY_BASE, taken);
    const [bin, args] = win ? [env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`]] : [env.SHELL || '/bin/sh', ['-c', command]];
    const child = spawn(bin, args, {
      cwd: dir,
      env: { ...env, ...envFor?.(port), PORT: String(port), BROWSER: 'none' }, // BROWSER: dev servers that open a tab don't
      detached: !win, // its own process group: Stop ends what it started too
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: win,
    });
    const r = { id, command, dir, port, ports, proxyPort, child, lines: [], partial: '', count: 0, url: null, ready: false, exited: false, code: null, signal: null, stopped: false, startedAt: Date.now(), endedAt: null, clients: new Set() };
    this.map.set(id, r);
    const out = (chunk) => this.#out(r, chunk);
    child.stdout.on('data', out);
    child.stderr.on('data', out);
    child.on('error', (err) => {
      this.#add(r, [`wisp: couldn’t start it: ${err.message}`]);
      this.#ended(r, 127, null);
    });
    child.on('exit', (code, signal) => this.#ended(r, code, signal));
    // Ready once its port answers (the address it printed, else PORT).
    r.probe = setInterval(async () => {
      if (r.exited || r.ready) return clearInterval(r.probe);
      if (await answers(r.url?.port || r.port)) {
        r.ready = true;
        clearInterval(r.probe);
        this.onChange(id);
      }
    }, 400);
    r.proxy = this.#proxy(r);
    this.onChange(id);
    return this.view(id);
  }

  // Stop it and everything it started; resolves once it's gone (or wasn't running).
  stop(id) {
    const r = this.map.get(id);
    if (!r || r.exited) return Promise.resolve(false);
    r.stopped = true;
    const gone = new Promise((resolve) => r.child.once('exit', () => resolve(true)));
    this.#kill(r, 'SIGTERM');
    const hard = setTimeout(() => !r.exited && this.#kill(r, 'SIGKILL'), STOP_GRACE_MS);
    hard.unref?.();
    return Promise.race([gone, new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS + 2000).unref?.())]).then(() => (clearTimeout(hard), true));
  }

  // wisp is going: every run with it.
  closeAll() {
    for (const r of this.map.values()) if (!r.exited) (r.stopped = true), this.#kill(r, 'SIGTERM');
  }

  // The output as server-sent events: hello (the run), lines (a JSON array of new lines), exit.
  attach(id, req, res) {
    const r = this.map.get(id);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    if (!r) return void res.end('event: gone\ndata: {}\n\n');
    const { tail, ...hello } = this.view(id);
    res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
    res.write(`event: lines\ndata: ${JSON.stringify(r.lines)}\n\n`);
    if (r.exited) return void res.end(`event: exit\ndata: ${JSON.stringify({ code: r.code, signal: r.signal })}\n\n`);
    r.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    res.on('close', () => (clearInterval(ping), r.clients.delete(res)));
  }

  #kill(r, sig) {
    try {
      if (win) spawnSync('taskkill', ['/pid', String(r.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else process.kill(-r.child.pid, sig);
    } catch {
      try {
        r.child.kill(sig);
      } catch {}
    }
  }

  #out(r, chunk) {
    const text = r.partial + chunk.toString('utf8');
    const parts = text.split('\n');
    r.partial = parts.pop();
    if (r.partial.length > LINE_MAX * 2) (parts.push(r.partial), (r.partial = ''));
    if (parts.length) this.#add(r, parts.map(cleanLine));
  }

  #add(r, lines) {
    for (const l of lines) {
      if (!r.url) {
        const u = urlIn(l);
        if (u) r.url = u;
      }
      r.lines.push(l);
    }
    r.count += lines.length;
    if (r.lines.length > MAX_LINES) r.lines.splice(0, r.lines.length - MAX_LINES);
    const msg = `event: lines\ndata: ${JSON.stringify(lines)}\n\n`;
    for (const c of r.clients) c.write(msg);
  }

  #ended(r, code, signal) {
    if (r.exited) return;
    if (r.partial) (this.#add(r, [cleanLine(r.partial)]), (r.partial = ''));
    Object.assign(r, { exited: true, code, signal, endedAt: Date.now(), ready: false });
    clearInterval(r.probe);
    r.proxy?.close();
    r.proxy?.closeAllConnections?.();
    // Its group: what it started may outlive the shell that started it.
    if (!win) {
      try {
        process.kill(-r.child.pid, 'SIGTERM');
      } catch {}
    }
    for (const c of r.clients) c.end(`event: exit\ndata: ${JSON.stringify({ code, signal })}\n\n`);
    r.clients.clear();
    this.onChange(r.id);
  }

  // The app again, on a port of its own, framable and with the picker in its pages.
  #proxy(r) {
    const target = () => r.url?.port || r.port;
    const srv = http.createServer((req, res) => {
      // Only the page's own frame: a site elsewhere can't reach it through a name that points here.
      if (!/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(String(req.headers.host || ''))) return void res.writeHead(403).end();
      if (req.url === PICK_PATH) return void res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }).end(PICK_JS);
      const port = target();
      const headers = { ...req.headers };
      delete headers['accept-encoding']; // over loopback: plain, so a page can take the script
      const up = askLocal(
        { method: req.method, path: req.url, headers, port },
        (a) => {
          const h = frameable(previewAnswer(a.headers, port));
          const html = req.method === 'GET' && /^text\/html/i.test(String(a.headers['content-type'] || '')) && Number(a.headers['content-length'] || 0) <= HTML_MAX;
          if (!html) return (res.writeHead(a.statusCode, h), a.pipe(res));
          const enc = String(a.headers['content-encoding'] || '').toLowerCase();
          const body = enc === 'gzip' ? a.pipe(zlib.createGunzip()) : enc === 'deflate' ? a.pipe(zlib.createInflate()) : enc === 'br' ? a.pipe(zlib.createBrotliDecompress()) : a;
          const bufs = [];
          body.on('data', (b) => bufs.push(b));
          body.on('error', () => res.destroy());
          body.on('end', () => {
            const out = Buffer.from(withPicker(Buffer.concat(bufs).toString('utf8')));
            delete h['content-encoding'];
            delete h.etag; // another body than the one it names
            h['content-length'] = out.length;
            res.writeHead(a.statusCode, h);
            res.end(out);
          });
        },
        (err) => {
          if (res.headersSent) return res.destroy();
          const p = failedPage(port, err);
          res.writeHead(p.status, p.headers);
          res.end(p.body);
        },
      );
      res.on('close', () => up.destroy());
      req.pipe(up);
    });
    srv.on('upgrade', (req, socket, head) => previewUpgrade(req, socket, head, target()));
    srv.on('error', () => (r.proxy = null)); // the port went meanwhile: the panel shows the app itself
    srv.listen(r.proxyPort, '127.0.0.1');
    return srv;
  }
}

// In the app's pages (through the proxy only): the panel turns picking on, the pointer outlines
// what's under it, a click tells the panel which element (its tag, text, selector, trimmed HTML and
// key styles) and ends it; Escape ends it too. It talks to the frame's parent only. What it says
// stays short, and never holds what's typed in a password or a hidden field. The cursor is a
// constructed sheet: only !important beats a button's own, and a page's CSP can't refuse it.
export const PICK_JS = `(() => {
  if (window.parent === window || window.__wispPick) return;
  window.__wispPick = true;
  const say = (m) => window.parent.postMessage({ wisp: 'pick', ...m }, '*');
  let on = false, box = null, tip = null, cur = null, color = '#3b82f6';
  const aim = new CSSStyleSheet();
  aim.replaceSync('*{cursor:crosshair!important}');
  const aiming = (yes) => { document.adoptedStyleSheets = [...document.adoptedStyleSheets].filter((s) => s !== aim).concat(yes ? [aim] : []); };
  const make = () => {
    box = document.createElement('div');
    tip = document.createElement('div');
    Object.assign(box.style, { position: 'fixed', zIndex: 2147483647, pointerEvents: 'none', borderRadius: '3px', boxSizing: 'border-box', display: 'none' });
    Object.assign(tip.style, { position: 'fixed', zIndex: 2147483647, pointerEvents: 'none', font: '11.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace', padding: '2px 6px', borderRadius: '4px', color: '#fff', whiteSpace: 'nowrap', display: 'none' });
    document.documentElement.append(box, tip);
  };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + [...el.classList].slice(0, 2).map((c) => '.' + c).join('');
  const show = (el) => {
    if (!box) make();
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', border: '2px solid ' + color, background: color + '1f' });
    tip.textContent = name(el);
    Object.assign(tip.style, { display: 'block', background: color, left: Math.max(2, r.left) + 'px', top: (r.top > 24 ? r.top - 22 : r.bottom + 4) + 'px' });
  };
  const hide = () => { if (box) box.style.display = tip.style.display = 'none'; };
  const ok = (c) => /^[A-Za-z_-][\\w-]*$/.test(c) && c.length < 40;
  const seg = (n) => {
    if (n.id && /^[A-Za-z][\\w-]*$/.test(n.id)) return { s: n.tagName.toLowerCase() + '#' + n.id, stop: true };
    let s = n.tagName.toLowerCase() + [...n.classList].filter(ok).slice(0, 2).map((c) => '.' + c).join('');
    const p = n.parentElement;
    if (p) {
      const like = [...p.children].filter((x) => x.tagName === n.tagName);
      if (like.length > 1 && p.querySelectorAll(':scope > ' + s).length > 1) s += ':nth-of-type(' + (like.indexOf(n) + 1) + ')';
    }
    return { s };
  };
  const selector = (el) => {
    const out = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement && out.length < 5; n = n.parentElement) {
      const x = seg(n);
      out.unshift(x.s);
      if (x.stop) break;
    }
    return out.join(' > ') || el.tagName.toLowerCase();
  };
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const secret = (el) => /^(password|hidden)$/i.test(el.getAttribute('type') || '');
  const textOf = (el) => {
    const t = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('title') || (secret(el) ? '' : el.value) || '').replace(/\\s+/g, ' ').trim();
    return cut(t, 60);
  };
  const EMPTY = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/;
  const attrsOf = (el) => [...el.attributes]
    .filter((a) => !(a.name === 'value' && secret(el)))
    .map((a) => ' ' + a.name + '="' + cut(a.value.replace(/\\s+/g, ' ').trim(), a.name === 'class' ? 200 : 80).replace(/"/g, '&quot;') + '"')
    .join('');
  // The element as markup, three levels down and about 600 characters, the rest as …
  const htmlOf = (el) => {
    let room = 600;
    const walk = (n, depth) => {
      if (n.nodeType === 3) {
        const t = cut(n.nodeValue.replace(/\\s+/g, ' ').trim(), 80);
        room -= t.length;
        return t;
      }
      if (n.nodeType !== 1 || /^(script|style|noscript|template)$/i.test(n.tagName)) return '';
      const tag = n.tagName.toLowerCase();
      const open = '<' + tag + attrsOf(n) + '>';
      room -= open.length;
      if (EMPTY.test(tag)) return open;
      let inner = '';
      const kids = [...n.childNodes];
      if (kids.length && (depth >= 3 || tag === 'svg')) inner = '…';
      else for (const k of kids) {
        if (room <= 0) { inner += '…'; break; }
        inner += walk(k, depth + 1);
      }
      return open + inner + '</' + tag + '>';
    };
    return cut(walk(el, 0), 800);
  };
  // The four sides of a box in the fewest words; nothing when they're all 0.
  const sides = (c, name) => {
    const [t, r, b, l] = ['top', 'right', 'bottom', 'left'].map((s) => c.getPropertyValue(name + '-' + s + (name === 'border' ? '-width' : '')));
    if (t === '0px' && r === '0px' && b === '0px' && l === '0px') return '';
    return t === b && l === r ? (t === l ? t : t + ' ' + r) : [t, r, b, l].join(' ');
  };
  // What decides how it looks: size, spacing, colour, font. Defaults say nothing.
  const stylesOf = (el) => {
    const c = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const v = (k) => c.getPropertyValue(k);
    const clear = (x) => !x || x === 'transparent' || /^rgba\\(.*, 0\\)$/.test(x);
    const family = v('font-family').split(',')[0].replace(/["']/g, '').trim();
    const width = sides(c, 'border');
    const out = [
      ['size', Math.round(r.width) + ' × ' + Math.round(r.height) + 'px'],
      ['display', v('display')],
      ['margin', sides(c, 'margin')],
      ['padding', sides(c, 'padding')],
      ['gap', /^(normal|0px)$/.test(v('gap')) ? '' : v('gap')],
      ['color', v('color')],
      ['background', clear(v('background-color')) ? '' : v('background-color')],
      ['font', v('font-weight') + ' ' + v('font-size') + '/' + v('line-height') + ' ' + family],
      ['border', width && v('border-top-style') !== 'none' ? width + ' ' + v('border-top-style') + ' ' + v('border-top-color') : ''],
      ['radius', v('border-radius') === '0px' ? '' : v('border-radius')],
    ];
    return cut(out.filter((x) => x[1]).map((x) => x[0] + ': ' + x[1]).join('; '), 400);
  };
  const tagOf = (el) => {
    const a = [];
    if (el.id) a.push('id="' + el.id + '"');
    const c = el.getAttribute('class');
    if (c && c.trim()) a.push('class="' + (c.trim().length > 60 ? c.trim().slice(0, 59) + '…' : c.trim()) + '"');
    return '<' + el.tagName.toLowerCase() + (a.length ? ' ' + a.join(' ') : '') + '>';
  };
  const stop = () => { on = false; cur = null; hide(); aiming(false); };
  const block = (e) => { if (!on) return; e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
  addEventListener('pointermove', (e) => {
    if (!on) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== box && el !== tip && el !== cur) show((cur = el));
  }, true);
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'touchstart', 'touchend', 'submit']) addEventListener(t, block, true);
  addEventListener('click', (e) => {
    if (!on) return;
    block(e);
    const el = document.elementFromPoint(e.clientX, e.clientY) || cur;
    if (!el || el === document.documentElement) return;
    say({ type: 'picked', tag: tagOf(el), text: textOf(el), selector: selector(el), path: location.pathname + location.hash, html: htmlOf(el), styles: stylesOf(el) });
    stop();
  }, true);
  addEventListener('keydown', (e) => { if (on && e.key === 'Escape') { block(e); stop(); say({ type: 'off' }); } }, true);
  addEventListener('scroll', () => on && cur && show(cur), true);
  addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window.parent || !d || d.wisp !== 'pick') return;
    if (d.type === 'hello') say({ type: 'ready' });
    if (d.type === 'on') { on = true; if (/^#[0-9a-f]{6}$/i.test(d.color || '')) color = d.color; aiming(true); }
    if (d.type === 'off') stop();
  });
  say({ type: 'ready' });
})();
`;
