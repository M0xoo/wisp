// Watch: a page the agent puts up beside its task while it works, and keeps updating, so the user
// watches the work instead of waiting for the answer (the wisp_watch tool, mcp-ask.js). The agent
// writes one self-contained HTML page that draws its progress; each state it sends after reaches
// the page (wisp.on('state', fn)) without a reload. The page runs sealed, like the app block's
// (web/js/watch-doc.js): it shows, it can't reach wisp or the network beyond its CDN scripts.
//
// On the session: watch = { title, file, own, caption, state, run, seq, rev, at, closed }. seq moves
// on every change (the summary carries it, so the page and other machines hear of it); rev only
// when the page itself changed, so the frame reloads then and only gets the state otherwise.

import fs from 'node:fs';
import path from 'node:path';
import { bad } from './util.js';

export const WATCH_MAX_HTML = 1_000_000;
export const WATCH_MAX_STATE = 64_000;
const MAX_TITLE = 80;
const MAX_CAPTION = 200;

// What the summary says of it: enough to know it's there and when it moved.
export const watchView = (s) => (s.watch ? { title: s.watch.title, caption: s.watch.caption || '', seq: s.watch.seq, rev: s.watch.rev, ...(s.watch.closed && { closed: true }) } : undefined);

// The page and where it stands, for GET /sessions/:id/watch.
export function watchDoc(s) {
  const w = s.watch;
  if (!w) return null;
  let html = '';
  let problem = '';
  try {
    const st = fs.statSync(w.file);
    if (st.size > WATCH_MAX_HTML) problem = `The page is larger than ${WATCH_MAX_HTML / 1e6} MB.`;
    else html = fs.readFileSync(w.file, 'utf8');
  } catch {
    problem = 'The page’s file is gone.';
  }
  return { title: w.title, caption: w.caption || '', state: w.state ?? null, run: w.run || null, seq: w.seq, rev: w.rev, at: w.at, closed: !!w.closed, html, problem };
}

const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function runOf(run, dir) {
  if (!run || typeof run !== 'object') return null;
  const command = String(run.command || '').trim().slice(0, 2000);
  if (!command) return null;
  return { command, cwd: path.resolve(dir, String(run.cwd || '.')), ...(run.note && { note: text(run.note, 300) }) };
}

function stateOf(v) {
  const json = JSON.stringify(v ?? null);
  if (json.length > WATCH_MAX_STATE) throw bad(`state is larger than ${WATCH_MAX_STATE / 1000} KB: send what the page draws now, not the whole history.`);
  return JSON.parse(json);
}

// One wisp_watch call. dir: the task's working folder (relative paths); keep: where wisp keeps a
// page given as html. Returns { text, note? }: the agent's answer, and a line for the task's
// activity when the view opened.
export function applyWatch(s, body = {}, { dir, keep }) {
  const action = String(body.action || '');
  const w = s.watch;
  const bump = (page) => {
    s.watch.seq = (s.watch.seq || 0) + 1;
    if (page) s.watch.rev = (s.watch.rev || 0) + 1;
    s.watch.at = Date.now();
  };
  if (action === 'open') {
    const title = text(body.title, MAX_TITLE) || w?.title || 'Progress';
    let file;
    let own = false;
    if (typeof body.html === 'string' && body.html.trim()) {
      if (Buffer.byteLength(body.html) > WATCH_MAX_HTML) throw bad(`html is larger than ${WATCH_MAX_HTML / 1e6} MB.`);
      fs.mkdirSync(keep, { recursive: true });
      file = path.join(keep, 'watch.html');
      fs.writeFileSync(file, body.html);
      own = true;
    } else if (typeof body.path === 'string' && body.path.trim()) {
      file = path.resolve(dir, body.path.trim());
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        throw bad(`No such file: ${file}`);
      }
      if (st.isDirectory()) file = path.join(file, 'index.html');
      if (!/\.html?$/i.test(file) || !fs.existsSync(file)) throw bad('path must be an .html file (or a folder with index.html).');
      if (fs.statSync(file).size > WATCH_MAX_HTML) throw bad(`The page is larger than ${WATCH_MAX_HTML / 1e6} MB.`);
    } else throw bad('open needs html (the page) or path (an .html file you wrote).');
    if (w?.own && w.file !== file) fs.rmSync(w.file, { force: true });
    const reopened = !!w && !w.closed;
    s.watch = { title, file, own, caption: text(body.caption, MAX_CAPTION), state: body.state !== undefined ? stateOf(body.state) : null, run: runOf(body.run, dir), seq: w?.seq || 0, rev: w?.rev || 0 };
    bump(true);
    return {
      text: `${reopened ? 'Replaced the page' : 'Opened'} “${title}” beside the task: the user can watch it now. Send progress with action "state" (the page gets it in wisp.on('state', fn)), say what you're doing with "caption", and "reload" after you edit the page's file.`,
      note: reopened ? null : `Opened Watch: ${title}`,
    };
  }
  if (!w) throw bad('Nothing to watch yet: call it with action "open" first.');
  if (action === 'state') {
    const next = stateOf(body.state);
    s.watch.state = body.merge && w.state && typeof w.state === 'object' && !Array.isArray(w.state) && next && typeof next === 'object' && !Array.isArray(next) ? stateOf({ ...w.state, ...next }) : next;
    if (body.caption !== undefined) s.watch.caption = text(body.caption, MAX_CAPTION);
    delete s.watch.closed;
    bump(false);
    return { text: 'Sent.' };
  }
  if (action === 'caption') {
    s.watch.caption = text(body.caption ?? body.text, MAX_CAPTION);
    bump(false);
    return { text: 'Caption set.' };
  }
  if (action === 'reload') {
    if (body.run !== undefined) s.watch.run = runOf(body.run, dir);
    delete s.watch.closed;
    bump(true);
    return { text: 'Reloaded the page; it gets the last state again.' };
  }
  if (action === 'close') {
    s.watch.closed = true;
    s.watch.caption = text(body.caption, MAX_CAPTION);
    bump(false);
    return { text: 'Closed. The page stays on the task, with its last state, for the user to look back at.' };
  }
  throw bad('action must be open, state, caption, reload or close.');
}

