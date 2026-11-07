// Device approval (RFC 8628's /activate), plain messages, and the page shown while a box wakes.

import { esc, type PageCfg, type PageUser } from './common.ts';
import { appPage } from './layout.ts';

export interface ActivateArgs {
  cfg: PageCfg;
  user: PageUser;
  code?: string;
  /** the pending code (accounts.pendingCode), or null when there's none to answer */
  device?: { name: string; user_code: string } | null;
  /** from the phone app: the way back is to the app */
  app?: boolean;
  csrf: string;
  error?: string;
}

export interface MessageArgs {
  cfg: PageCfg;
  title: string;
  text: string;
  /** [href, label] */
  link?: readonly [string, string] | null;
  tone?: string;
}

// Opens the Android app (its intent filter in mobile/android/…/AndroidManifest.xml).
export const APP_URL = 'dev.trywisp.mobile://signed-in';

export function activatePage({ cfg, user, code = '', device = null, app = false, csrf, error = '' }: ActivateArgs): string {
  if (!device)
    return appPage({
      cfg,
      title: 'Connect a device',
      user,
      csrf,
      narrow: true,
      body: `<h1 class="h1">Connect a device</h1><p class="sub">Type the code wisp shows on your computer or phone.</p>${error ? `<div class="flash bad">${esc(error)}</div>` : ''}
        <form method="get" action="/activate" style="margin-top:20px;display:flex;flex-direction:column;gap:10px"><input class="input" name="code" value="${esc(code)}" placeholder="ABCD-EFGH" autocomplete="off" autocapitalize="characters" autofocus required>${app ? '<input type="hidden" name="app" value="android">' : ''}
        <button class="primary tall">Continue</button></form>`,
    });
  return appPage({
    cfg,
    title: 'Connect a device',
    user,
    csrf,
    narrow: true,
    body: `<h1 class="h1">Let this device in?</h1>
      <p class="sub"><b>${esc(device.name)}</b> asks to use your wisp as <b>${esc(user.handle)}</b>. Allow it only if you just started this on your own computer or phone, and the code matches.</p>
      <div class="code">${esc(device.user_code)}</div>
      <form method="post" action="/activate" style="display:flex;gap:10px">
        <input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="code" value="${esc(device.user_code)}">${app ? '<input type="hidden" name="app" value="android">' : ''}
        <button class="ghost line tall" style="flex:1;justify-content:center" name="answer" value="deny">Don’t allow</button>
        <button class="primary tall" style="flex:1" name="answer" value="allow">Allow</button>
      </form>
      <form method="post" action="/signout?return=${encodeURIComponent(`/activate?code=${device.user_code}${app ? '&app=android' : ''}`)}" style="margin-top:16px;text-align:center">
        <input type="hidden" name="csrf" value="${esc(csrf)}"><span class="sub">Not ${esc(user.handle)}?</span> <button class="ghost">Use another account</button>
      </form>`,
  });
}

export function messagePage({ cfg, title, text, link = null, tone = '' }: MessageArgs): string {
  return appPage({
    cfg,
    title,
    narrow: true,
    body: `<h1 class="h1">${esc(title)}</h1>${tone ? `<div class="flash ${tone}">${esc(text)}</div>` : `<p class="sub">${esc(text)}</p>`}${link ? `<p style="margin-top:20px"><a class="primary tall" href="${esc(link[0])}">${esc(link[1])}</a></p>` : ''}`,
  });
}

// Shown at <handle>.<domain> while its wisp starts; reloads itself once it answers.
export function wakingPage({ cfg, user }: { cfg: PageCfg; user: PageUser }): string {
  return appPage({
    cfg,
    title: 'Waking up',
    narrow: true,
    body: `<div class="center" style="padding-top:48px"><div class="orb"></div><h1 class="h1">Waking your wisp</h1><p class="sub" id="msg">${esc(user.handle)}’s computer was asleep. A few seconds.</p></div>
      <script>(async function poll(n){try{const r=await fetch('/_grid/state',{cache:'no-store'});const j=await r.json();if(j.state==='running')return location.reload();const m=document.getElementById('msg');if(j.error)m.textContent=j.error;else if(j.state==='queued')m.textContent='The grid is busy right now. You’re next in line: it opens as soon as there’s room.';}catch{}setTimeout(()=>poll(n+1),n<20?700:2000)})(0)</script>`,
  });
}

