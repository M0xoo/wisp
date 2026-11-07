// The account page's forms: each one posts to the grid's own origin with this session's CSRF token.

import { MACHINE_WANTS } from '../accounts.ts';
import type { SessionOf } from '../accounts.ts';
import { bad } from '../errors.ts';
import { cookies, json, redirect, safePath, str } from '../http.ts';
import { messagePage } from '../pages/index.ts';
import { deleteAccount, revokeDevice } from './lifecycle.ts';
import type { Root } from './root.ts';
import { msg, statusOr } from './util.ts';

const back = (m: string): string => `/?m=${encodeURIComponent(m)}`;
const account = (m: string, isBad = false): string => `/account?m=${encodeURIComponent(m)}${isBad ? '&tone=bad' : ''}`;

/** Answers a POST form of a signed-in user; false when p is none of them. */
export async function accountForm(r: Root, s: SessionOf): Promise<boolean> {
  const { x, req, res, url } = r;
  const p = url.pathname;
  const u = s.user;
  let m: RegExpExecArray | null;
  if (p === '/instance/stop') {
    await r.needCsrf();
    await x.hostd.stop(u.id, 'put to sleep');
    return redirect(res, '/'), true;
  }
  // More cloud machines, bigger ones, GPUs: on the list for when they come. The page posts
  // JSON and answers at once; without script, the form posts and comes back here.
  if (p === '/machines/waitlist') {
    const body = await r.needCsrf();
    const wish = x.accounts.wishMachines(u.id, body['wants'] ?? MACHINE_WANTS.filter((w) => body[`want_${w}`]), body['note']);
    x.notify(u.id);
    if (String(req.headers.accept || '').includes('application/json')) return json(res, 200, { ok: true, wish }), true;
    return redirect(res, back(wish ? 'You’re on the list. We’ll write when it’s ready.' : 'You’re off the list.')), true;
  }
  if ((m = /^\/devices\/([a-f0-9]+)\/revoke$/.exec(p)) && m[1]) {
    await r.needCsrf();
    revokeDevice(x, u.id, m[1]);
    return redirect(res, account('Device removed.')), true;
  }
  if ((m = /^\/computers\/([a-f0-9]+)\/remove$/.exec(p))) {
    await r.needCsrf();
    const c = x.ownComputer(u.id, m[1]);
    x.accounts.removeComputer(u.id, c.id);
    x.tunnels.close(c.id);
    x.notify(u.id);
    return redirect(res, back(`${c.name} removed.`)), true;
  }
  if ((m = /^\/sites\/([A-Za-z0-9_-]{1,64})\/remove$/.exec(p)) && m[1]) {
    await r.needCsrf();
    await x.sites.remove(u.id, m[1]);
    x.notify(u.id);
    return redirect(res, back('Unpublished: that link no longer works.')), true;
  }
  if (await routeForm(r, s)) return true;
  return accountChange(r, s);
}

// A bot for `on laptop`: only here, on the grid's own origin, with this session and its CSRF token
// (route.ts). Never at <handle>/_grid/*, which a page a box serves can reach (trust.ts: grid:route-page).
async function routeForm(r: Root, s: SessionOf): Promise<boolean> {
  const { x, res, url } = r;
  if (!x.routes.on) return false;
  if (url.pathname === '/channels/route') {
    const body = await r.needCsrf();
    x.limit(`routeset|${s.user.id}`, 10);
    try {
      const name = await x.routes.set(s.user, body);
      x.notify(s.user.id);
      redirect(res, account(`${name ? `@${name}` : 'Your bot'} is connected.`));
    } catch (err) {
      if (statusOr(err, 0) !== 400) x.log(`grid: route for ${s.user.handle}: ${msg(err)}`);
      redirect(res, account(statusOr(err, 0) === 400 ? msg(err) : 'That didn’t work: Telegram couldn’t be reached. Try again.', true));
    }
    return true;
  }
  if (url.pathname === '/channels/route/remove') {
    await r.needCsrf();
    const shared = x.routes.shared(s.user.id);
    await x.routes.remove(s.user);
    x.notify(s.user.id);
    redirect(res, account(shared ? 'Removed. Your cloud wisp sets its own webhook the next time it starts.' : 'Removed. That bot no longer reaches your computers.'));
    return true;
  }
  return false;
}

async function accountChange(r: Root, s: SessionOf): Promise<boolean> {
  const { x, res, url } = r;
  const p = url.pathname;
  if (p === '/identities/unlink') {
    const body = await r.needCsrf();
    x.accounts.unlink(s.user.id, str(body['provider']));
    return redirect(res, '/account'), true;
  }
  if (p === '/account/delete') {
    const body = await r.needCsrf();
    const u = s.user;
    if (str(body['confirm']).trim().toLowerCase() !== u.handle) throw bad(`Type ${u.handle} to delete your account.`);
    await deleteAccount(x, u);
    r.page(messagePage({ cfg: x.cfg, title: 'Account deleted', text: 'Your wisp, its files and your agents’ sign-ins are gone from this grid. To revoke those sign-ins as well, sign out of them at Anthropic, OpenAI or GitHub.', link: ['/', 'Done'] }), 200, { 'set-cookie': x.setCookie(x.names.grid, '', 0) });
    return true;
  }
  if (p === '/signout') {
    await r.needCsrf();
    if (url.searchParams.get('all')) x.accounts.endAll(s.user.id);
    else x.accounts.endSession(cookies(r.req)[x.names.grid]);
    // Use another account (the device approval page): back to sign-in, then to that same code.
    const ret = safePath(url.searchParams.get('return'), '');
    redirect(res, ret ? `/signin?return=${encodeURIComponent(ret)}` : '/signin', { 'set-cookie': x.setCookie(x.names.grid, '', 0) });
    return true;
  }
  return false;
}
