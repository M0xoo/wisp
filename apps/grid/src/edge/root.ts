// The grid's own address: its pages, sign-in, the device API (api.ts), shared tasks (share-page.ts)
// and the account page's forms (account-forms.ts). Every form posts back here with this session's
// CSRF token and this origin: a page a box serves can reach none of it.

import type { SessionOf } from '../accounts.ts';
import { bad } from '../errors.ts';
import { cookies, html, json, readBody, redirect, safePath, str, type HeaderMap, type Json, type Req, type Res } from '../http.ts';
import { accountPage, activatePage, APP_URL, messagePage, signInPage } from '../pages/index.ts';
import { isUnder, ROUTE_PREFIX } from '../hosts.ts';
import { accountForm } from './account-forms.ts';
import { api } from './api.ts';
import type { Ctx } from './context.ts';
import { routeIn } from './hooks-in.ts';
import { sharePage, webFile } from './share-page.ts';
import { auth } from './signin.ts';
import { events } from './events.ts';

export interface Root {
  x: Ctx;
  req: Req;
  res: Res;
  url: URL;
  s: SessionOf | null;
  page(body: string, status?: number, headers?: HeaderMap): void;
  needCsrf(): Promise<Json>;
  signInFirst(ret: string): void;
}

export async function root(x: Ctx, req: Req, res: Res, url: URL): Promise<void> {
  const p = url.pathname;
  const c = cookies(req);
  const s = x.accounts.session(c[x.names.grid], 'grid');
  const r: Root = {
    x,
    req,
    res,
    url,
    s,
    // Only the landing page belongs in search results; sign-in steps, messages and the account page don't.
    page: (body, status = 200, headers = {}) => html(res, status, body, p === '/' ? headers : { 'x-robots-tag': 'noindex', ...headers }),
    async needCsrf() {
      const body = await readBody(req);
      if (req.headers.origin && req.headers.origin !== x.cfg.publicUrl) throw bad('This form came from another site.', 403);
      if (!s || !x.secrets.verify(`csrf|${s.hash}`, str(body['csrf']))) throw bad('The page was out of date. Go back and try again.', 403);
      return body;
    },
    signInFirst: (ret) => redirect(res, `/signin?return=${encodeURIComponent(ret)}`),
  };
  if (isUnder(p, ROUTE_PREFIX)) return routeIn(x, req, res, p);
  if (p.startsWith('/api/')) return api(x, req, res, url);
  if (p === '/healthz') return json(res, 200, { ok: true });
  if (await webFile(x, req, res, p)) return;
  if (await sharePage(r)) return;
  if (await pages(r)) return;
  if (await auth(r)) return;
  if (await go(r)) return;
  if (p === '/activate') return activate(r);
  if (req.method === 'POST') {
    if (!s) return r.signInFirst('/');
    if (await accountForm(r, s)) return;
  }
  r.page(messagePage({ cfg: x.cfg, title: 'Not found', text: 'There’s nothing here.', link: ['/', 'Home'] }), 404);
}

async function pages(r: Root): Promise<boolean> {
  const { x, req, url, s } = r;
  const p = url.pathname;
  const ua = String(req.headers['user-agent'] || '');
  // HEAD too: link checkers (ad review, unfurlers) probe with it, and a 404 there reads as a dead page
  if ((req.method === 'GET' || req.method === 'HEAD') && (p === '/' || p === '/account')) {
    if (!s) {
      r.page(signInPage({ cfg: x.cfg, providers: x.providers, seats: x.accounts.seats(), ret: url.searchParams.get('return') || (p === '/account' ? '/account' : ''), analytics: x.stats.pages, ua }));
      return true;
    }
    const u = s.user;
    const account = p === '/account';
    r.page(
      accountPage({
        cfg: x.cfg,
        view: account ? 'account' : 'home',
        offers: { sites: x.sites.opts.enabled, sandboxes: x.sandboxes.opts.enabled },
        user: u,
        instance: { ...x.accounts.instance(u.id), state: x.hostd.state(u.id) },
        machine: { cpus: x.hostd.container.cpus, memory: x.hostd.container.memory, wish: x.accounts.machineWish(u.id) },
        devices: x.accounts.devices(u.id),
        computers: x.accounts.computers(u.id).map((c) => ({ ...x.computerView(c), deviceId: c.device_id })),
        sites: x.sites.list(u.id).map(x.sites.view),
        identities: x.accounts.identities(u.id),
        providers: x.providers,
        route: account ? await x.routes.view(u.id) : null,
        csrf: x.csrfFor(s),
        flash: url.searchParams.get('m') || '',
        tone: url.searchParams.get('tone') === 'bad' ? 'bad' : '',
      }),
    );
    return true;
  }
  if (req.method === 'GET' && p === '/events') return events(r), true;
  if (req.method === 'GET' && p === '/signin') {
    if (s && !url.searchParams.get('link')) redirect(r.res, safePath(url.searchParams.get('return')));
    else r.page(signInPage({ cfg: x.cfg, providers: x.providers, seats: x.accounts.seats(), ret: safePath(url.searchParams.get('return'), ''), analytics: x.stats.pages, ua }));
    return true;
  }
  return false;
}

// Into the user's own wisp (or ?computer=<id>, one of their computers; with ?preview=<port>, a page
// in that box or on that computer): a one-time ticket to its address, which sets that address's cookie.
async function go(r: Root): Promise<boolean> {
  const { x, req, url, s } = r;
  if (req.method !== 'GET' || url.pathname !== '/go') return false;
  if (!s) return r.signInFirst(`/go${url.search}`), true;
  const q = url.searchParams;
  const c = q.get('computer') ? x.accounts.computer(q.get('computer')) : undefined;
  const sb = x.sandboxes.get(q.get('sandbox'));
  const label = c && c.user_id === s.user.id ? c.label : sb && sb.user_id === s.user.id ? sb.label : s.user.handle;
  const pport = /^\d{1,5}$/.test(q.get('preview') || '') && (x.previews || (!!c && label === c.label)) ? Number(q.get('preview')) : 0;
  const to = pport ? x.previewUrl(label, pport) : x.cfg.instanceUrl(label);
  redirect(r.res, `${to}/_grid/auth?t=${x.accounts.ticket(s.user.id, pport ? `preview:${label}` : null)}&r=${encodeURIComponent(safePath(q.get('path')))}`);
  return true;
}

async function activate(r: Root): Promise<void> {
  const { x, req, url, s } = r;
  if (!s) return r.signInFirst(`/activate${url.search}`);
  x.limit(`activate|${s.user.id}`, 30);
  if (req.method === 'GET') {
    const code = url.searchParams.get('code') || '';
    const device = code ? x.accounts.pendingCode(code) : null;
    const app = url.searchParams.get('app') === 'android';
    return r.page(activatePage({ cfg: x.cfg, user: s.user, code, device, app, csrf: x.csrfFor(s), error: code && !device ? 'That code expired or was already used. Start again on the device.' : '' }));
  }
  const body = await r.needCsrf();
  const allow = body['answer'] === 'allow';
  const c2 = x.accounts.answerCode(body['code'], s.user.id, allow);
  // From the phone app: the way back is to the app, which is waiting to open your wisp. 'Your
  // account' would open it here in the browser instead.
  const app = body['app'] === 'android';
  const back: [string, string] = app ? [APP_URL, 'Back to the wisp app'] : ['/', 'Your account'];
  const done = app ? `${c2.name} can use your wisp now. Go back to the app: it opens your wisp there.` : `${c2.name} can use your wisp now. You can close this tab.`;
  r.page(messagePage({ cfg: x.cfg, title: allow ? 'Device connected' : 'Not allowed', text: allow ? done : `${c2.name} wasn’t let in.`, link: back }));
}
