// Signed in, Account (/account): devices, `on laptop`'s bot, sign-ins, sign out, delete. And
// accountPage, which picks this or Home (home.ts).

import { I, esc, logo, type PageCfg, type PageProvider, type PageUser } from './common.ts';
import { homeView, type ComputerView, type DeviceView, type InstanceView, type MachineView, type Offers, type SiteView } from './home.ts';
import { LIVE, ago, appPage } from './layout.ts';

/** `on laptop`'s bot as the account page shows it (route.ts view): never its token. */
export interface RouteView {
  set: boolean;
  bot?: string | null;
  senders: string[];
  moved?: boolean;
  shared?: boolean;
}
export interface IdentityView {
  provider: string;
  email?: string | null;
  login?: string | null;
}

export interface AccountPageArgs {
  cfg: PageCfg;
  view?: 'home' | 'account';
  offers?: Offers;
  user: PageUser;
  instance: InstanceView;
  machine?: MachineView;
  devices: DeviceView[];
  computers?: ComputerView[];
  sites?: SiteView[];
  identities: IdentityView[];
  providers: ReadonlyMap<string, PageProvider>;
  route?: RouteView | null;
  csrf: string;
  flash?: string;
  tone?: string;
}

interface AccountViewArgs {
  cfg: PageCfg;
  user: PageUser;
  devices: DeviceView[];
  computers: ComputerView[];
  identities: IdentityView[];
  providers: ReadonlyMap<string, PageProvider>;
  route: RouteView | null;
  csrf: string;
  hidden: string;
  flash: string;
}

export function accountPage({ cfg, view = 'home', offers = {}, user, instance, machine = {}, devices, computers = [], sites = [], identities, providers, route = null, csrf, flash: msg = '', tone = '' }: AccountPageArgs): string {
  const hidden = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
  const flash = msg ? `<div class="flash ${tone}">${esc(msg)}</div>` : '';
  if (view === 'account') return accountView({ cfg, user, devices, computers, identities, providers, route, csrf, hidden, flash });
  return homeView({ cfg, offers, user, instance, machine, devices, computers, sites, csrf, hidden, flash });
}

const routeWarn = (title: string, text: string): string => `<div class="r route-warn"><span class="ic">${I.shield}</span><div class="tx"><b>${title}</b><small>${text}</small></div></div>`;

// A bot for `on laptop` (grid/route.js). What was given here never shows again, only that it's set.
function routeSection(route: RouteView, computers: ComputerView[], hidden: string): string {
  const name = esc(computers[0]?.name || 'laptop');
  const n = route.senders.length;
  return `<h2 class="sec" id="route">Telegram to your computers</h2>
      <p class="hint">Tell your bot <code>on ${name} fix the login</code> and it runs on that computer, once that computer has switched on <b>Settings → Notifications → Accept tasks from channels</b> itself. The grid reads these messages and your cloud wisp is never asked. The bot does nothing else: anything else gets a line saying so.</p>
      <div class="group" data-live="route">${
        route.set
          ? `<div class="r wrap"><span class="ic">${I.shield}</span><div class="tx"><b>${route.bot ? `@${esc(route.bot)}` : 'Your bot'}</b><small>${n === 1 ? 'One person' : `${n} people`} can send: ${esc(route.senders.join(', '))}</small></div><form class="inline" method="post" action="/channels/route/remove">${hidden}<button class="ghost quiet">Remove</button></form></div>${
              route.moved ? routeWarn('The webhook moved', 'Telegram no longer sends this bot’s messages to the grid, so they aren’t reaching your computers. Something else with this bot’s token set it. Remove the bot here and connect it again.') : ''
            }${route.shared ? routeWarn('Your cloud wisp also has this bot', 'Anything on your cloud wisp can read this bot’s token, and with it your messages and reports, or speak as this bot. It can’t start anything on your computers. Make a new bot with BotFather, then Remove this one and connect that.') : ''}`
          : `<form class="route-f" method="post" action="/channels/route" autocomplete="off">${hidden}
        <label><span>Bot token</span><input class="input" name="token" type="password" placeholder="From BotFather" autocomplete="off" autocapitalize="none" spellcheck="false" required></label>
        <label><span>Who may send</span><input class="input" name="senders" inputmode="numeric" placeholder="Your Telegram user id" autocomplete="off" required></label>
        <p class="hint">Make a new bot for this with BotFather, not the one your cloud wisp uses. Anything on your cloud wisp can read that bot’s token, and with it what goes through here. The grid keeps this token sealed and sets the webhook with a secret of its own.</p>
        <button class="primary">Connect</button></form>`
      }</div>

      `;
}

function accountView({ cfg, user, devices, computers, identities, providers, route, csrf, hidden, flash }: AccountViewArgs): string {
  const linked = new Set(identities.map((i) => i.provider));
  const canLink = [...providers.values()].filter((p) => !linked.has(p.id) && p.id !== 'dev');
  const byDevice = new Map(computers.map((c) => [c.deviceId, c]));
  const initial = esc((user.name || user.handle || '?').trim()[0]?.toUpperCase() || '?');
  return appPage({
    cfg,
    title: 'Account',
    user,
    csrf,
    tab: 'account',
    body: `${flash}<div class="acct">
      <aside class="a-side">
        <div class="a-who"><span class="av">${user.avatar ? `<img src="${esc(user.avatar)}" alt="">` : initial}</span><div><b title="${esc(user.name || user.handle)}">${esc(user.name || user.handle)}</b><small title="${esc(user.email || user.handle)}">${esc(user.email || user.handle)}</small></div></div>
        <nav class="a-nav" aria-label="Account"><a href="#devices">Signed-in devices</a>${route ? '<a href="#route">Telegram to your computers</a>' : ''}<a href="#ways">How you sign in</a><a href="#out">Sign out</a><a href="#delete">Delete your account</a></nav>
      </aside>
      <div class="a-main">
      <h1 class="h1">Account</h1>
      <h2 class="sec" id="devices">Signed-in devices</h2>
      <p class="hint">Apps that can open your wisps. Removing a computer’s device also takes it off the grid.</p>
      <div class="group" data-live="devices">${
        devices.length
          ? devices
              .map((d) => {
                const c = byDevice.get(d.id);
                return `<div class="r"><span class="ic">${/phone/i.test(d.name) ? I.phone : I.laptop}</span><div class="tx"><b>${esc(d.name)}</b><small>${c ? `On the grid as ${esc(c.name)} · ` : ''}added ${ago(d.created_at)} · last used ${ago(d.last_seen_at)}</small></div>
            <form class="inline" method="post" action="/devices/${esc(d.id)}/revoke">${hidden}<button class="ghost quiet">Remove</button></form></div>`;
              })
              .join('')
          : `<div class="r"><span class="ic">${I.laptop}</span><div class="tx"><b>No devices yet</b><small>wisp on a computer and the phone app sign in here once, with a code.</small></div></div>`
      }</div>

      ${route ? routeSection(route, computers, hidden) : ''}<h2 class="sec" id="ways">How you sign in</h2>
      <div class="group">${identities
        .map(
          (i) => `<div class="r"><span class="ic">${logo(i.provider)}</span><div class="tx"><b>${esc(providers.get(i.provider)?.label || i.provider)}</b><small>${esc(i.login || i.email || '')}</small></div>
          ${identities.length > 1 ? `<form class="inline" method="post" action="/identities/unlink">${hidden}<input type="hidden" name="provider" value="${esc(i.provider)}"><button class="ghost">Disconnect</button></form>` : ''}</div>`,
        )
        .join('')}
        ${canLink.map((p) => `<div class="r"><span class="ic">${logo(p.id)}</span><div class="tx"><b>${esc(p.label)}</b><small>Connect it too, and either one signs you in</small></div><a class="ghost line" href="/auth/${encodeURIComponent(p.id)}/start?link=1">Connect</a></div>`).join('')}
      </div>

      <h2 class="sec" id="out">Sign out</h2>
      <div class="group">
        <div class="r wrap"><span class="ic">${I.globe}</span><div class="tx"><b>This browser</b><small>Your cloud wisp keeps running.</small></div><form class="inline" method="post" action="/signout">${hidden}<button class="ghost line">Sign out</button></form></div>
        <div class="r wrap"><span class="ic">${I.shield}</span><div class="tx"><b>Every browser</b><small>Signs this account out of the grid in every browser. Devices stay signed in: remove them above.</small></div><form class="inline" method="post" action="/signout?all=1">${hidden}<button class="ghost line">Sign out everywhere</button></form></div>
      </div>

      <h2 class="sec" id="delete">Delete your account</h2>
      <div class="group"><form class="r del" method="post" action="/account/delete"><span class="ic">${I.trash}</span><div class="tx"><b>Delete your account and your cloud wisp</b><small>Your cloud wisp, its files and your agents’ sign-ins there are deleted for good. Your computers keep their own wisp.</small></div>
        ${hidden}<input class="input" name="confirm" placeholder="Type ${esc(user.handle)}" aria-label="Type ${esc(user.handle)} to confirm" autocomplete="off" autocapitalize="none" spellcheck="false" required pattern="${esc(user.handle)}"><button class="ghost line danger">Delete</button></form></div>
      </div></div>
      ${LIVE}`,
  });
}

