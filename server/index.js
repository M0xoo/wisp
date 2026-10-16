// HTTP API + SSE + static web UI. No dependencies.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Store } from './store.js';
import { Runner, summarize, newId } from './runner.js';
import { adapters, listAgents } from './adapters/index.js';
import { welcomeSession } from './welcome.js';
import { openInTerminal, TERMINALS, shq } from './terminal.js';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
};
const MAX_UPLOAD = 500 * 1024 * 1024;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

export async function startServer({ port = 4477, host = '127.0.0.1', handleSignals = true } = {}) {
  const store = new Store();
  const token = randomBytes(16).toString('hex');
  const runner = new Runner(store, { url: `http://127.0.0.1:${port}`, token });
  const uploadsDir = path.join(store.home, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const uploads = new Map(); // id -> { id, name, mime, size, path }
  for (const f of fs.readdirSync(uploadsDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const u = JSON.parse(fs.readFileSync(path.join(uploadsDir, f), 'utf8'));
      uploads.set(u.id, u);
    } catch {}
  }
  const resolveAttachments = (ids) => (Array.isArray(ids) ? ids.map((i) => uploads.get(i)).filter(Boolean) : []);

  if (store.all().length === 0) store.put(welcomeSession());

  const clients = new Set();
  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  };
  runner.on('summary', (s) => broadcast('summary', s));
  runner.on('activity', (a) => broadcast('activity', a));
  runner.on('turn', (t) => broadcast('turn', t));
  runner.on('finished', (f) => broadcast('finished', f));
  setInterval(() => broadcast('ping', {}), 25_000).unref();

  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  const server = http.createServer(async (req, res) => {
    // Agents can run with broad permissions, so only same-origin local pages may talk to us.
    if (!allowedHosts.has(req.headers.host)) return send(res, 403, { error: 'forbidden host' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return send(res, 403, { error: 'forbidden origin' });
      const ct = String(req.headers['content-type'] || '');
      const isUpload = req.url.startsWith('/api/uploads') && ct.startsWith('application/octet-stream');
      if (!ct.startsWith('application/json') && !isUpload) return send(res, 415, { error: 'json only' });
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      return serveStatic(res, url.pathname);
    } catch (err) {
      console.error(err);
      send(res, err.status || 500, { error: err.message });
    }
  });

  async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
    const [root, id, action] = parts;
    const m = req.method;

    if (root === 'events' && m === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: hello\ndata: {}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (root === 'agents' && m === 'GET') return send(res, 200, await listAgents());

    // Bridge for the ask_user MCP server running inside an agent process.
    if (root === 'internal') {
      if (req.headers['x-wisp-token'] !== token) return send(res, 403, { error: 'bad token' });
      if (id === 'ask' && !action && m === 'POST') {
        const body = await readJson(req);
        const s = store.get(body.session);
        if (!s) return send(res, 404, { error: 'no such session' });
        return send(res, 200, { id: runner.ask(s, body) });
      }
      if (id === 'ask' && action && m === 'GET') return send(res, 200, runner.pollAnswer(action));
    }

    // Attachments: raw body streamed to disk, referenced by id from launches and replies.
    if (root === 'uploads') {
      if (!id && m === 'POST') {
        const name = path.basename(url.searchParams.get('name') || 'file').replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file';
        const uid = newId();
        const file = path.join(uploadsDir, `${uid}-${name}`);
        let size = 0;
        await new Promise((resolve, reject) => {
          const out = fs.createWriteStream(file);
          req.on('data', (c) => {
            size += c.length;
            if (size > MAX_UPLOAD) {
              req.destroy();
              out.destroy();
              fs.rmSync(file, { force: true });
              reject(Object.assign(new Error('file too large (500 MB max)'), { status: 413 }));
            }
          });
          req.pipe(out);
          out.on('finish', resolve);
          out.on('error', reject);
        });
        const meta = { id: uid, name, size, mime: url.searchParams.get('type') || MIME[path.extname(name).toLowerCase()] || 'application/octet-stream', path: file };
        uploads.set(uid, meta);
        fs.writeFileSync(path.join(uploadsDir, `${uid}.json`), JSON.stringify(meta));
        return send(res, 201, meta);
      }
      if (id && m === 'GET') {
        const u = uploads.get(id);
        if (!u || !fs.existsSync(u.path)) return send(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': u.mime, 'content-length': fs.statSync(u.path).size });
        return fs.createReadStream(u.path).pipe(res);
      }
    }

    if (root === 'config') {
      if (m === 'GET') return send(res, 200, { ...store.config, home: os.homedir(), cwd: process.cwd(), terminals: TERMINALS });
      if (m === 'PATCH') {
        const body = await readJson(req);
        if (body.defaults) Object.assign(store.config.defaults, body.defaults);
        store.saveConfig();
        broadcast('config', {});
        return send(res, 200, store.config);
      }
    }

    if (root === 'projects') {
      if (!id && m === 'GET') return send(res, 200, store.config.projects);
      if (!id && m === 'POST') {
        const body = await readJson(req);
        const dir = path.resolve(String(body.path || '').replace(/^~(?=$|\/)/, os.homedir()));
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return send(res, 400, { error: `Not a folder: ${dir}` });
        const p = store.addProject(dir, { name: body.name });
        broadcast('config', {});
        return send(res, 201, p);
      }
      // Find git repos in the usual places so adding projects is one click.
      if (id === 'discover' && m === 'GET') {
        const known = new Set(store.config.projects.map((p) => p.path));
        const roots = ['code', 'Code', 'dev', 'Developer', 'projects', 'Projects', 'src', 'repos', 'work', 'git', 'GitHub', 'Documents', 'Downloads', 'Desktop'].map((d) => path.join(os.homedir(), d));
        const found = [];
        const walk = (dir, depth) => {
          if (found.length >= 60) return;
          let entries;
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          if (entries.some((e) => e.name === '.git')) {
            if (!known.has(dir)) found.push({ path: dir, name: path.basename(dir), mtime: fs.statSync(dir).mtimeMs });
            return;
          }
          if (depth <= 0) return;
          for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(path.join(dir, e.name), depth - 1);
        };
        for (const r of roots) walk(r, 2);
        return send(res, 200, found.sort((a, b) => b.mtime - a.mtime).slice(0, 24));
      }
      const p = store.config.projects.find((x) => x.id === id);
      if (!p) return send(res, 404, { error: 'no such project' });
      if (m === 'PATCH') {
        const body = await readJson(req);
        if (typeof body.name === 'string' && body.name.trim()) p.name = body.name.trim();
        if (typeof body.color === 'string') p.color = body.color;
        store.saveConfig();
        broadcast('config', {});
        return send(res, 200, p);
      }
      if (m === 'DELETE') {
        store.config.projects = store.config.projects.filter((x) => x.id !== id);
        store.saveConfig();
        broadcast('config', {});
        return send(res, 200, { ok: true });
      }
    }

    // Directory suggestions for the launcher's project picker.
    if (root === 'fs' && m === 'GET') {
      const raw = (url.searchParams.get('q') || '').replace(/^~(?=$|\/)/, os.homedir());
      const dir = raw.endsWith('/') ? raw : path.dirname(raw);
      const prefix = raw.endsWith('/') ? '' : path.basename(raw).toLowerCase();
      let entries = [];
      try {
        entries = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name.toLowerCase().startsWith(prefix))
          .slice(0, 12)
          .map((e) => path.join(dir, e.name));
      } catch {}
      return send(res, 200, entries);
    }

    if (root === 'sessions') {
      if (!id) {
        if (m === 'GET') return send(res, 200, store.all().map((x) => summarize(x, store)).sort((a, b) => b.updatedAt - a.updatedAt));
        if (m === 'POST') {
          const body = await readJson(req);
          if (!body.prompt?.trim()) return send(res, 400, { error: 'prompt required' });
          const cwd = path.resolve((body.cwd || process.cwd()).replace(/^~(?=$|\/)/, os.homedir()));
          if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return send(res, 400, { error: `Not a directory: ${cwd}` });
          if (!adapters[body.agent || 'claude']) return send(res, 400, { error: 'unknown agent' });
          const s = runner.create({ prompt: body.prompt, cwd, agent: body.agent, mode: body.mode, model: body.model, attachments: resolveAttachments(body.attachments) });
          return send(res, 201, summarize(s, store));
        }
      }

      const s = store.get(id);
      if (!s) return send(res, 404, { error: 'no such session' });

      if (!action) {
        if (m === 'GET') return send(res, 200, s);
        if (m === 'PATCH') {
          const body = await readJson(req);
          if (typeof body.title === 'string' && body.title.trim()) Object.assign(s, { title: body.title.trim(), titleAuto: false });
          if (body.state === 'done' && s.state !== 'running') s.state = 'done';
          if (body.state === 'review' && s.state === 'done') s.state = 'review';
          if (typeof body.unread === 'boolean') s.unread = body.unread;
          store.save(s);
          broadcast('summary', summarize(s, store));
          return send(res, 200, summarize(s, store));
        }
        if (m === 'DELETE') {
          runner.stop(s);
          store.delete(id);
          broadcast('removed', { id });
          return send(res, 200, { ok: true });
        }
      }

      if (action === 'reply' && m === 'POST') {
        const { text, attachments } = await readJson(req);
        if (!text?.trim()) return send(res, 400, { error: 'text required' });
        if (s.agent === 'wisp') return send(res, 400, { error: 'This is the tour — launch a real wisp to follow up.' });
        return send(res, 200, runner.reply(s, text.trim(), resolveAttachments(attachments)));
      }

      if (action === 'answer' && m === 'POST') {
        const { text } = await readJson(req);
        if (!text?.trim()) return send(res, 400, { error: 'text required' });
        return send(res, 200, { ok: runner.answer(s, text.trim()) });
      }

      // Take over: continue this exact agent session interactively in a terminal.
      if (action === 'takeover') {
        const adapter = adapters[s.agent];
        if (!adapter?.resumeCommand || !s.agentSessionId) return send(res, 400, { error: 'This session cannot be resumed in a terminal.' });
        const argv = adapter.resumeCommand({ resumeId: s.agentSessionId, model: s.model });
        const command = `cd ${shq(s.cwd)} && ${argv.map(shq).join(' ')}`;
        if (m === 'GET') return send(res, 200, { command });
        if (m === 'POST') {
          if (runner.live.has(s.id)) {
            runner.stop(s);
            await runner.live.get(s.id)?.done;
          }
          openInTerminal({ cwd: s.cwd, argv, terminal: store.config.defaults.terminal || 'auto', custom: store.config.defaults.terminalCommand });
          s.takenOverAt = Date.now();
          store.save(s);
          return send(res, 200, { command });
        }
      }

      if (action === 'stop' && m === 'POST') {
        runner.stop(s);
        return send(res, 200, { ok: true });
      }

      // Images the agent pointed at (screenshots etc.), confined to the session's project.
      if (action === 'file' && m === 'GET') {
        const p = path.resolve(s.cwd, url.searchParams.get('path') || '');
        const ext = path.extname(p).toLowerCase();
        if (!p.startsWith(s.cwd + path.sep) || !IMAGE_EXT.has(ext) || !fs.existsSync(p)) return send(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': MIME[ext] });
        return fs.createReadStream(p).pipe(res);
      }
    }

    send(res, 404, { error: 'not found' });
  }

  function serveStatic(res, pathname) {
    const p = path.normalize(path.join(WEB, pathname === '/' ? 'index.html' : pathname));
    if (!p.startsWith(WEB) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      // SPA fallback
      res.writeHead(200, { 'content-type': MIME['.html'] });
      return fs.createReadStream(path.join(WEB, 'index.html')).pipe(res);
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(p).pipe(res);
  }

  const shutdown = () => {
    for (const s of store.all()) runner.stop(s);
    store.flush();
  };
  if (handleSignals) {
    const exit = () => (shutdown(), process.exit(0));
    process.once('SIGINT', exit);
    process.once('SIGTERM', exit);
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  return { url: `http://localhost:${port}`, server, store, runner, shutdown };
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2e6) reject(Object.assign(new Error('body too large'), { status: 413 }));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(Object.assign(new Error('invalid json'), { status: 400 }));
      }
    });
  });
}
