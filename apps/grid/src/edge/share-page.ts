// A shared task's page (/s/<id>, its delegates' /s/<id>/r/<run>) and its pictures and videos
// (/s/<id>/m/<n>.<ext>): open to anyone with the link, or only with its passkey (POSTed here).
// Opened once, a cookie for that share keeps it open a while, so its delegates' pages don't ask
// again; a new passkey shuts it. The page is drawn the way wisp draws a task, with wisp's own
// stylesheets and scripts (webFile): public files, nothing of anyone's.

import fs from 'node:fs';
import { clientIp, cookie, cookies, json, readBody, str, type Req, type Res } from '../http.ts';
import { messagePage, sharePassPage, shareViewPage } from '../pages/index.ts';
import { MEDIA_TYPES, SHARE_ID } from '../shares.ts';
import type { ShareRow } from '../rows.ts';
import type { Ctx } from './context.ts';
import type { Root } from './root.ts';

const WEB_TYPES: Record<string, string> = { css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml' };
const WEB_FILE = /^\/(css|js|logos)\/[\w./-]+\.(css|js|svg)$|^\/favicon\.svg$/;
const MEDIA_PATH = /^\/s\/([A-Za-z0-9_-]{16})\/m\/([\w.-]{1,40})$/;
const SHARE_PATH = /^\/s\/([A-Za-z0-9_-]+)(?:\/r\/([^/]{1,60}))?$/;
const VIEW_CSP = "default-src 'none'; img-src 'self' https: data:; media-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; connect-src 'none'; frame-src https:; form-action 'self'; base-uri 'none'; frame-ancestors *";
const MEDIA_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

export interface Look {
  styles: string[];
  sprite: string;
}

// wisp's page's look, from its index.html: its stylesheets in order and its icon sprite. Read once.
const looks = new Map<string, Promise<Look>>();
export function webLook(root: URL): Promise<Look> {
  let l = looks.get(root.href);
  if (!l) {
    l = fs.promises.readFile(new URL('index.html', root), 'utf8').then(
      (html) => ({ styles: [...html.matchAll(/<link rel="stylesheet" href="(\/css\/[\w.-]+\.css)">/g)].map((m) => m[1] ?? ''), sprite: /<svg width="0" height="0"[\s\S]*?<\/svg>\n/.exec(html)?.[0] || '' }),
      () => ({ styles: [], sprite: '' }),
    );
    looks.set(root.href, l);
  }
  return l;
}

/** wisp's own stylesheets, scripts and logos, for a shared task's page. */
export async function webFile(x: Ctx, req: Req, res: Res, p: string): Promise<boolean> {
  if ((req.method !== 'GET' && req.method !== 'HEAD') || !WEB_FILE.test(p) || p.includes('..')) return false;
  let body: Buffer;
  try {
    body = await fs.promises.readFile(new URL(`.${p}`, x.webRoot));
  } catch {
    json(res, 404, { error: 'not found' });
    return true;
  }
  res.writeHead(200, { 'content-type': WEB_TYPES[p.split('.').pop() ?? ''] ?? 'application/octet-stream', 'content-length': body.length, 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

const opened = (x: Ctx, req: Req, row: ShareRow): boolean => !!row.pass && x.secrets.verify(`share|${row.id}|${row.pass}`, cookies(req)[`wsh_${row.id}`] || '');

export async function sharePage(r: Root): Promise<boolean> {
  const { req, url } = r;
  const read = req.method === 'GET' || req.method === 'HEAD';
  const sm = read ? MEDIA_PATH.exec(url.pathname) : null;
  if (sm?.[1] && sm[2]) return media(r, sm[1], sm[2]), true;
  const sp = SHARE_PATH.exec(url.pathname);
  if (sp?.[1] && (read || req.method === 'POST')) return view(r, sp[1], sp[2]), true;
  return false;
}

// A range for a video, so it seeks (and plays at all in Safari).
async function media(r: Root, id: string, name: string): Promise<void> {
  const { x, req, res } = r;
  const row = x.shares.get(id);
  const file = row && (!row.pass || opened(x, req, row)) ? x.shares.media(row, name) : null;
  const size = file ? await fs.promises.stat(file).then((s) => s.size, () => -1) : -1;
  if (!row || !file || size < 0) return json(res, 404, { error: 'not found' });
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  const ranged = !!m && !!(m[1] || m[2]);
  let [start, end] = [0, size - 1];
  if (m && ranged) {
    [start, end] = m[1] ? [Number(m[1]), m[2] ? Math.min(Number(m[2]), size - 1) : size - 1] : [Math.max(0, size - Number(m[2])), size - 1];
    if (start > end || start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      return void res.end();
    }
  }
  const type = MEDIA_TYPES[(name.split('.').pop() ?? '').toLowerCase()] ?? 'application/octet-stream';
  const head = { 'content-type': type, 'content-length': end - start + 1, 'accept-ranges': 'bytes', 'cache-control': row.pass ? 'private, max-age=300' : 'public, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': MEDIA_CSP };
  res.writeHead(ranged ? 206 : 200, ranged ? { ...head, 'content-range': `bytes ${start}-${end}/${size}` } : head);
  if (req.method === 'HEAD') return void res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
}

async function view(r: Root, id: string, runPart: string | undefined): Promise<void> {
  const { x, req } = r;
  const row = SHARE_ID.test(id) ? x.shares.get(id) : undefined;
  if (!row) return r.page(messagePage({ cfg: x.cfg, title: 'Nothing here', text: 'This task isn’t shared any more, or its link has a typo.', link: [x.cfg.publicUrl, 'Home'] }), 404);
  const c = x.shareCard(row);
  let pass = '';
  if (req.method === 'POST') {
    x.limit(`sharepk|${row.id}|${clientIp(req)}`, 10);
    pass = str((await readBody(req))['passkey']);
  }
  // Framed anywhere (wisp's preview block, a doc, a wiki): it's meant to be shown, and the page
  // has nothing to click that acts for anyone. Every other grid page stays DENY.
  const framed = { 'x-frame-options': null };
  if (!opened(x, req, row) && !(await x.shares.unlocks(row, pass))) return r.page(sharePassPage({ cfg: x.cfg, share: c, wrong: !!pass }), pass ? 403 : 200, framed);
  const task = await x.shares.task(row);
  let run: string | null = null;
  if (runPart) {
    try {
      run = decodeURIComponent(runPart);
    } catch {
      run = null;
    }
    if (!run || !task.runs?.[run]) return r.page(messagePage({ cfg: x.cfg, title: 'Nothing here', text: 'That delegated task isn’t in this share.', link: [`/s/${row.id}`, 'Back to the task'] }), 404);
  }
  const keep = row.pass && pass ? { 'set-cookie': cookie(`wsh_${row.id}`, x.secrets.sign(`share|${row.id}|${row.pass}`), { secure: x.cfg.publicUrl.startsWith('https:'), maxAge: 12 * 3600, path: `/s/${row.id}` }) } : {};
  r.page(shareViewPage({ share: c, task, run, look: await webLook(x.webRoot) }), 200, { 'content-security-policy': VIEW_CSP, ...framed, ...keep });
}
