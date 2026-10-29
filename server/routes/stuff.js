// My Stuff (services/stuff.js): list, save (a file from a task, text, a link, or a raw upload),
// edit, remove, the file itself, and Show in folder.

import fs from 'node:fs';
import path from 'node:path';
import { sendFile } from '../http/respond.js';
import { MIME } from '../http/static.js';
import { workdir } from '../runner.js';
import { bad } from '../util.js';
import { docFile, mediaFile, revealInFolder } from './sessions.js';

// A file a task's reply showed or named: its pictures and docs, or anything in its folder.
export function taskFile(s, asked) {
  if (typeof asked !== 'string' || !asked) return null;
  const known = mediaFile(s, asked) || docFile(s, asked);
  if (known) return known.path;
  const dir = workdir(s);
  const p = path.resolve(dir, asked);
  return p.startsWith(dir + path.sep) && fs.existsSync(p) && fs.statSync(p).isFile() ? p : null;
}

// Where an item came from: the task (its title as it was then, so it reads right once the task is
// gone) and the turn, plus the page's key for "already saved".
export function fromTask(s, { turn, key } = {}) {
  if (!s) return key ? { key: String(key).slice(0, 300) } : undefined;
  return { session: s.id, title: s.title, ...(turn && { turn: String(turn) }), ...(key && { key: String(key).slice(0, 300) }) };
}

export function register(r, app) {
  const { stuff, store } = app;
  // What the page sees, with whether an app is running and on which port.
  const view = (it) => ({ ...stuff.view(it), ...(it.kind === 'app' && app.apps?.state(it.id) && { running: app.apps.state(it.id) }) });
  const one = (fn) => (c) => {
    const it = stuff.get(c.params.id);
    if (!it) return c.send(404, { error: 'That’s no longer in My Stuff.' });
    return fn(c, it);
  };

  r.route('GET', '/stuff', (c) => c.send(200, { items: stuff.list().map(view), publishTo: app.publish?.targets() || [] }));

  // One of: { url } a link, { text } a doc or snippet, { session, path } a file from a task.
  r.route('POST', '/stuff', async (c) => {
    const body = await c.body();
    const s = body.session ? store.get(String(body.session)) : null;
    const from = fromTask(s, body);
    const same = stuff.findKey(from?.key);
    if (same) return c.send(200, view(same));
    const opts = { title: body.title, note: body.note, tags: body.tags, from, by: 'you' };
    let it;
    if (body.url) it = stuff.addLink(body.url, opts);
    else if (typeof body.text === 'string') it = stuff.addText(body.text, { ...opts, name: body.name, lang: body.lang });
    else {
      if (!s) throw bad(body.session ? 'That task isn’t on this computer.' : 'Say what to save: a url, some text, or a task’s file.', body.session ? 404 : 400);
      const file = taskFile(s, body.path);
      if (!file) throw bad('That file is gone, so there’s nothing to save.', 404);
      it = stuff.addFile(file, { ...opts, name: body.name });
    }
    app.telemetry?.track('stuff_save', { kind: it.kind, by: 'you' });
    c.send(201, view(it));
  });

  // A file dropped on the page, or a picture from a task on another computer: the raw body.
  r.route('POST', '/stuff/upload', async (c) => {
    const q = (k) => c.query.get(k) || undefined;
    const s = q('session') ? store.get(q('session')) : null;
    const from = s ? fromTask(s, { turn: q('turn'), key: q('key') }) : q('key') ? { key: q('key').slice(0, 300), ...(q('session') && { session: q('session') }), ...(q('from') && { title: q('from') }) } : undefined;
    const same = stuff.findKey(from?.key);
    if (same) {
      c.req.resume();
      return c.send(200, view(same));
    }
    const it = await stuff.receive(c.req, { name: q('name'), mime: q('type'), title: q('title'), from, by: 'you' });
    app.telemetry?.track('stuff_save', { kind: it.kind, by: 'you' });
    c.send(201, view(it));
  });

  r.route(
    'GET',
    '/stuff/:id/file',
    one((c, it) => {
      if (it.kind === 'app') return c.send(404, { error: 'An app has no one file: launch it.' });
      if (!it.path || !fs.existsSync(it.path)) return c.send(404, { error: 'The file is gone.' });
      // HTML (or XML) never opens here, only downloads: it would run on wisp's own origin. An SVG
      // shows as a picture, sandboxed with no scripts, the same if it's opened on its own.
      const page = /html|xml/.test(it.mime) && !/svg/.test(it.mime);
      const download = c.query.get('download') || page ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(it.name)}` } : {};
      const svg = /svg/.test(it.mime) && { 'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'" };
      sendFile(c.req, c.res, it.path, page ? 'application/octet-stream' : it.mime, { ...download, ...svg, 'x-content-type-options': 'nosniff' });
    }),
  );

  // An app's picture (the agent's screenshot of it), for its card.
  r.route(
    'GET',
    '/stuff/:id/cover',
    one((c, it) => {
      if (!it.cover || !fs.existsSync(it.cover)) return c.send(404, { error: 'No picture.' });
      sendFile(c.req, c.res, it.cover, MIME[path.extname(it.cover)] || 'application/octet-stream', { 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' });
    }),
  );

  // Launch an app: it's served on a port of its own (services/apps.js) until it's stopped or idle.
  r.route(
    'POST',
    '/stuff/:id/launch',
    one(async (c, it) => {
      const port = await app.apps.launch(it.id);
      app.telemetry?.track('stuff_launch', {});
      c.send(200, { port, url: `http://localhost:${port}/` });
    }),
  );
  r.route('DELETE', '/stuff/:id/launch', one((c, it) => c.send(200, { ok: app.apps.stop(it.id) })));

  // Publish an app to your wisp Grid: a link anyone can open (services/publish.js). Again: updated.
  r.route('POST', '/stuff/:id/publish', one(async (c, it) => c.send(200, view(await app.publish.publish(it.id, await c.body())))));
  r.route('DELETE', '/stuff/:id/publish', one(async (c, it) => c.send(200, view(await app.publish.unpublish(it.id)))));

  // Reset data: an app's database (app-db.js) goes; the next query makes it again from its seed.
  r.route(
    'DELETE',
    '/stuff/:id/data',
    one(async (c, it) => {
      if (!it.db) return c.send(404, { error: 'That app has no database.' });
      await app.apps.resetData(it.id);
      c.send(200, view(stuff.get(it.id)));
    }),
  );

  // Back to the version before the last change (an agent's update, or yours).
  r.route('POST', '/stuff/:id/restore', one((c, it) => c.send(200, view(stuff.restore(it.id)))));

  r.route('PATCH', '/stuff/:id', one(async (c, it) => c.send(200, view(stuff.update(it.id, await c.body())))));
  r.route(
    'DELETE',
    '/stuff/:id',
    one((c, it) => {
      app.apps?.stop(it.id, { quiet: true });
      // Gone from My Stuff: its public link goes too (best effort; the grid's account page lists it).
      if (it.published) app.publish?.unpublish(it.id).catch(() => {});
      c.send(200, { ok: stuff.remove(it.id) });
    }),
  );

  // Show in folder: wisp's copy. Only on the computer itself; through a proxy the page copies the path.
  r.route(
    'POST',
    '/stuff/:id/reveal',
    one((c, it) => {
      if (!it.path) return c.send(404, { error: 'A link has no file.' });
      if (app.proxy?.via(c.req)) return c.send(409, { error: 'The file is on the computer running wisp.', path: it.path });
      revealInFolder(it.path);
      c.send(200, { ok: true, path: it.path });
    }),
  );
}
