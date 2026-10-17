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
import { Telemetry, envDisabled } from './telemetry.js';
import { blocksToMarkdown, sessionToMarkdown } from './render.js';
import { openapi } from './openapi.js';
import { Updater } from './update.js';

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
const MAX_WAIT_S = 290; // long-poll cap per request; clients loop (fetch drops headers after 300s)
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const API_VERSION = 1;

// A session "needs you" once it stops running: finished, or blocked on ask_user. A finished run
// with follow-ups still queued is about to start the next one, so it doesn't count yet.
const settled = (s) => s.state === 'waiting' || (s.state !== 'running' && !s.queue?.length);
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
  runner.on('finished', ({ session }) => notifyWebhooks(store, session));
  setInterval(() => broadcast('ping', {}), 25_000).unref();

  const telemetry = new Telemetry(store);
  const updater = new Updater({ port, onChange: (u) => broadcast('update', u) });
  const run = (s, t) => ({ agent: s.agent, model: s.model || 'default', mode: s.mode, effort: s.effort || 'default', followUp: s.turns.indexOf(t) > 0 });
  runner.on('started', ({ session, turn }) => telemetry.track('turn_started', { ...run(session, turn), attachments: turn.attachments.length }));
  runner.on('ended', ({ session, turn, interrupted, errorText }) => {
    const blocks = turn.presentation?.blocks || [];
    const st = turn.stats || {};
    telemetry.track('turn_ended', {
      ...run(session, turn),
      status: interrupted ? 'interrupted' : turn.status, // done | error | stopped | interrupted
      heroStatus: blocks.find((b) => b.type === 'hero')?.status,
      durationMs: turn.endedAt - turn.startedAt,
      blockCount: blocks.length,
      blockTypes: [...new Set(blocks.map((b) => b.type))],
      presentationFallback: !!turn.presentation?.fallback, // agent ignored or broke the wisp protocol
      changedFiles: turn.changes.length,
      inputTokens: st.inputTokens,
      outputTokens: st.outputTokens,
      costUsd: st.costUsd,
    });
    if (errorText) telemetry.captureError(new Error(errorText), { type: 'AgentError', ...run(session, turn) });
  });
  if (!envDisabled()) process.on('uncaughtExceptionMonitor', (err) => telemetry.crashed(err));

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
      if (!err.status || err.status >= 500) telemetry.captureError(err, { route: `${req.method} ${url.pathname.replace(/\/[a-f0-9]{8,}(?=\/|$)/g, '/:id')}` });
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

    if (root === 'health' && m === 'GET') return send(res, 200, { ok: true, name: 'wisp', version: VERSION, apiVersion: API_VERSION, pid: process.pid, url: `http://127.0.0.1:${port}` });
    // New wisp-agents on npm? POST installs it and relaunches; running agents are stopped, so the
    // client must pass force once it has confirmed that with the user.
    if (root === 'update') {
      if (m === 'GET') return send(res, 200, url.searchParams.has('check') ? await updater.check() : updater.view());
      if (m === 'POST') {
        const body = await readJson(req);
        if (runner.live.size && !body.force) return send(res, 409, { error: 'agents are running', running: runner.live.size });
        await updater.install();
        send(res, 202, updater.view());
        telemetry.track('update', { from: updater.state.current, to: updater.state.latest, method: updater.method });
        setTimeout(() => (shutdown(), process.exit(0)), 300);
        return;
      }
    }
    if (root === 'openapi.json' && m === 'GET') return send(res, 200, openapi({ version: VERSION, port }));

    if (root === 'agents' && m === 'GET') return send(res, 200, await listAgents());

    // Bridge for the ask_user MCP server running inside an agent process.
    if (root === 'internal') {
      if (req.headers['x-wisp-token'] !== token) return send(res, 403, { error: 'bad token' });
      if (id === 'ask' && !action && m === 'POST') {
        const body = await readJson(req);
        const s = store.get(body.session);
        if (!s) return send(res, 404, { error: 'no such session' });
        telemetry.track('ask_user', { agent: s.agent });
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
      if (m === 'GET') return send(res, 200, { ...store.config, home: os.homedir(), cwd: process.cwd(), terminals: TERMINALS, telemetry: { available: !envDisabled(), enabled: telemetry.enabled } });
      if (m === 'PATCH') {
        const body = await readJson(req);
        if (body.defaults) Object.assign(store.config.defaults, body.defaults);
        if (body.webhooks !== undefined) {
          const hooks = Array.isArray(body.webhooks) ? body.webhooks : [];
          const bad = hooks.find((h) => !/^https?:\/\/\S+$/.test(String(h?.url ?? h)));
          if (bad !== undefined) return send(res, 400, { error: `Not an http(s) URL: ${bad?.url ?? bad}` });
          store.config.webhooks = hooks.map((h) => (typeof h === 'string' ? { url: h } : { url: h.url, events: Array.isArray(h.events) ? h.events : undefined }));
        }
        store.saveConfig();
        broadcast('config', {});
        return send(res, 200, store.config);
      }
    }

    if (root === 'projects') {
      if (!id && m === 'GET') return send(res, 200, store.config.projects);
      if (!id && m === 'POST') {
        const body = await readJson(req);
        const dir = path.resolve(String(body.path || '').replace(/^~(?=$|[\\/])/, os.homedir()));
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
      const raw = (url.searchParams.get('q') || '').replace(/^~(?=$|[\\/])/, os.homedir());
      const trailing = /[\\/]$/.test(raw); // a trailing backslash counts too (Windows)
      const dir = trailing ? raw : path.dirname(raw);
      const prefix = trailing ? '' : path.basename(raw).toLowerCase();
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
        if (m === 'GET') {
          const q = Object.fromEntries(url.searchParams);
          const cwd = q.cwd && path.resolve(q.cwd.replace(/^~(?=$|[\\/])/, os.homedir()));
          let list = store.all().map((x) => summarize(x, store)).sort((a, b) => b.updatedAt - a.updatedAt);
          if (q.state) list = list.filter((x) => q.state.split(',').includes(x.state));
          if (q.agent) list = list.filter((x) => x.agent === q.agent);
          if (q.project) list = list.filter((x) => x.projectId === q.project || x.project === q.project);
          if (cwd) list = list.filter((x) => x.cwd === cwd || x.cwd?.startsWith(cwd + path.sep));
          if (q.archived !== undefined) list = list.filter((x) => x.archived === (q.archived === 'true' || q.archived === '1'));
          if (Number(q.limit) > 0) list = list.slice(0, Number(q.limit));
          return send(res, 200, list);
        }
        if (m === 'POST') {
          const body = await readJson(req);
          if (!body.prompt?.trim()) return send(res, 400, { error: 'prompt required' });
          const cwd = path.resolve((body.cwd || process.cwd()).replace(/^~(?=$|[\\/])/, os.homedir()));
          if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return send(res, 400, { error: `Not a directory: ${cwd}` });
          if (!adapters[body.agent || 'claude']) return send(res, 400, { error: 'unknown agent' });
          const s = runner.create({ prompt: body.prompt, cwd, agent: body.agent, mode: body.mode, model: body.model, effort: /^[\w-]{1,20}$/.test(body.effort || '') ? body.effort : '', attachments: resolveAttachments(body.attachments) });
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
          if (body.archived === true && s.state !== 'running' && s.state !== 'waiting') Object.assign(s, { archived: true, unread: false });
          if (body.archived === false) delete s.archived;
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

      // Long-poll until the session needs the user (finished, or asking). ?timeout=seconds.
      if (action === 'wait' && m === 'GET') {
        const timeout = Math.min(Math.max(Number(url.searchParams.get('timeout')) || 60, 0), MAX_WAIT_S) * 1000;
        const end = Date.now() + timeout;
        let gone = false;
        req.on('close', () => (gone = true));
        while (!gone && store.get(id) && !settled(s) && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
        if (!store.get(id)) return send(res, 404, { error: 'session was deleted' });
        return send(res, 200, { ...summarize(s, store), timedOut: !settled(s) });
      }

      // The latest (or ?turn=<id|index>) presentation, as blocks and as markdown.
      if (action === 'presentation' && m === 'GET') {
        const q = url.searchParams.get('turn');
        const turn = q === null ? s.turns.at(-1) : s.turns.find((t) => t.id === q) || s.turns.at(Number(q));
        if (!turn) return send(res, 404, { error: 'no such turn' });
        const latest = turn === s.turns.at(-1);
        const markdown = latest ? sessionToMarkdown(s) : blocksToMarkdown(turn.presentation?.blocks, turn);
        if (url.searchParams.get('format') === 'markdown') {
          res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
          return res.end(markdown);
        }
        return send(res, 200, {
          sessionId: s.id,
          turnId: turn.id,
          turnIndex: s.turns.indexOf(turn),
          state: s.state,
          status: turn.status,
          prompt: turn.prompt,
          blocks: turn.presentation?.blocks || [],
          notes: turn.presentation?.notes,
          fallback: !!turn.presentation?.fallback,
          changes: turn.changes.map((c) => ({ file: c.file, op: c.op, edits: c.edits.length })),
          stats: turn.stats,
          ask: latest ? s.ask || null : null,
          markdown,
        });
      }

      if (action === 'reply' && m === 'POST') {
        const { text, attachments, queue } = await readJson(req);
        if (!text?.trim()) return send(res, 400, { error: 'text required' });
        if (s.agent === 'wisp') return send(res, 400, { error: 'This is the tour — launch a real wisp to follow up.' });
        return send(res, 200, runner.reply(s, text.trim(), resolveAttachments(attachments), { queue: queue ?? store.config.defaults.followUp === 'queue' }));
      }

      if (action === 'queue' && m === 'DELETE') {
        const ok = runner.unqueue(s, url.searchParams.get('item') || '');
        return ok ? send(res, 200, { ok }) : send(res, 404, { error: 'Already sent.' });
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
        const argv = adapter.resumeCommand({ resumeId: s.agentSessionId, model: s.model, effort: s.effort });
        const command = `cd ${shq(s.cwd)} && ${argv.map(shq).join(' ')}`;
        if (m === 'GET') return send(res, 200, { command });
        if (m === 'POST') {
          if (runner.live.has(s.id)) {
            runner.stop(s);
            await runner.live.get(s.id)?.done;
          }
          openInTerminal({ cwd: s.cwd, argv, terminal: store.config.defaults.terminal || 'auto', custom: store.config.defaults.terminalCommand });
          s.takenOverAt = Date.now();
          telemetry.track('takeover', { agent: s.agent, terminal: store.config.defaults.terminal || 'auto' });
          store.save(s);
          return send(res, 200, { command });
        }
      }

      if (action === 'stop' && m === 'POST') {
        runner.stop(s);
        return send(res, 200, { ok: true });
      }

      // Images the agent pointed at (screenshots etc.). Served if inside the session's project,
      // or if the agent named that exact path in an image block (screenshots often land in /tmp).
      if (action === 'file' && m === 'GET') {
        let p = path.resolve(s.cwd, url.searchParams.get('path') || '');
        const ext = path.extname(p).toLowerCase();
        const images = s.turns.flatMap((t) => (t.presentation?.blocks || []).filter((b) => b?.type === 'image'));
        const at = (v) => typeof v === 'string' && path.resolve(s.cwd, v) === p;
        const named = images.find((b) => at(b.path || b.src));
        // A page rendered before keepImages() rewrote the block still asks for the original path.
        const kept = !named && images.find((b) => at(b.source) && typeof b.path === 'string');
        if (kept) p = path.resolve(s.cwd, kept.path);
        if (!(p.startsWith(s.cwd + path.sep) || named || kept) || !IMAGE_EXT.has(ext) || !fs.existsSync(p)) return send(res, 404, { error: 'not found' });
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

  // Advertise this server so integrations (CLI, MCP, editors) can find it without knowing the port.
  const serverFile = path.join(store.home, 'server.json');
  const shutdown = () => {
    try {
      if (JSON.parse(fs.readFileSync(serverFile, 'utf8')).pid === process.pid) fs.rmSync(serverFile, { force: true });
    } catch {}
    for (const s of store.all()) runner.stop(s);
    store.flush();
    telemetry.persist();
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
  fs.writeFileSync(serverFile, JSON.stringify({ url: `http://127.0.0.1:${port}`, port, pid: process.pid, version: VERSION, apiVersion: API_VERSION, startedAt: Date.now() }, null, 2));
  updater.start();

  if (telemetry.enabled) {
    if (store.config.defaults.telemetryNotice !== 'seen') console.log('wisp sends anonymous usage stats and error reports (no prompts, paths or code). Opt out: Settings, or WISP_TELEMETRY=0 / DO_NOT_TRACK=1.');
    listAgents()
      .then((agents) => telemetry.track('app_started', { agentsInstalled: agents.filter((a) => a.available).map((a) => a.id), ...Object.fromEntries(agents.filter((a) => a.available).map((a) => [`${a.id}Version`, a.version])) }))
      .catch(() => {});
  }

  return { url: `http://localhost:${port}`, server, store, runner, shutdown, telemetry };
}

// POST { event, session, markdown } to each configured webhook (Slack bridges, CI, notifiers).
// event: session.waiting (blocked on ask_user) | session.finished. Fire and forget.
function notifyWebhooks(store, summary) {
  const hooks = store.config.webhooks || [];
  if (!hooks.length) return;
  const s = store.get(summary.id);
  if (!s) return;
  const event = s.state === 'waiting' ? 'session.waiting' : 'session.finished';
  const body = JSON.stringify({ event, session: summary, markdown: sessionToMarkdown(s), at: Date.now() });
  for (const h of hooks) {
    if (h.events?.length && !h.events.includes(event)) continue;
    fetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': `wisp/${VERSION}` }, body, signal: AbortSignal.timeout(10_000) }).catch((err) =>
      console.warn(`wisp: webhook ${h.url} failed: ${err.message}`),
    );
  }
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
