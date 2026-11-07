// The signed-in app's frame: the header (brand, Home/Account tabs, who's signed in), the page, and
// the live sync script both account pages run.

import { APP_CSS } from './app-css.ts';
import { A, I, PENDING, esc, tag, type PageCfg, type PageUser } from './common.ts';

export interface AppPageArgs {
  cfg: PageCfg;
  title: string;
  user?: PageUser | null;
  csrf?: string;
  body: string;
  head?: string;
  narrow?: boolean;
  /** 'home' | 'account': the tabbed header of the two account pages */
  tab?: string;
}

export function appPage({ cfg, title, user = null, csrf = '', body, head = '', narrow = false, tab = '' }: AppPageArgs): string {
  const initial = esc((user?.name || user?.handle || '?').trim()[0]?.toUpperCase() || '?');
  const avatar = `<span class="av">${user?.avatar ? `<img src="${esc(user.avatar)}" alt="">` : initial}</span>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(cfg.name)}</title><meta name="referrer" content="same-origin"><link rel="icon" href="${A}/icon.svg"><style>${APP_CSS}</style>${head}</head><body>
<header class="top${tab ? ' wide' : ''}"><a class="brand" href="${esc(cfg.publicUrl)}/"><span class="mark"></span>wisp</a><span class="chipx">${I.cloud.replace('<svg', '<svg width="13" height="13"')}${esc(tag(cfg))}</span>
${tab ? `<nav class="navt" aria-label="Your grid"><a href="/"${tab === 'home' ? ' aria-current="page"' : ''}>Home</a><a href="/account"${tab === 'account' ? ' aria-current="page"' : ''}>Account</a></nav>` : ''}
${tab && user ? `<div class="me"><a href="/account" title="Your account"><span class="who">${esc(user.handle)}</span>${avatar}</a></div>` : user ? `<div class="me"><span class="who">${esc(user.handle)}</span>${avatar}${csrf ? `<form class="inline" method="post" action="/signout"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="ghost">Sign out</button></form>` : ''}</div>` : ''}</header>
<main class="main${narrow ? ' narrow' : ''}${tab ? ' wide' : ''}">${body}</main>${PENDING}</body></html>`;
}

export const STATE: Readonly<Record<string, string>> = { running: 'Running', queued: 'Waiting for room', starting: 'Waking up', stopping: 'Going to sleep', stopped: 'Asleep' };
export const ago = (t: number | null | undefined): string => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toISOString().slice(0, 10);
};


// Keeps the account page current without a reload: the grid says on GET /events when something on
// it changed (a computer came online or went away, the cloud wisp woke or fell asleep), and the page
// fetches itself and swaps only the [data-live] rows that differ, so the rest (an open "Add a
// computer", a half-typed field) stays as it is. Missed events (the stream dropped, the tab came
// back from the cache) are caught up the same way. Not once a form is on its way: its own answer is
// the next page (deleting your account stops your wisp, an event, and a reload would drop that answer).
export const LIVE = `<script>(()=>{let t=0,opened=false,leaving=false;
const morph=(cur,next)=>{const a=[...cur.children],b=[...next.children];if(!b.length&&!a.length){if(cur.innerHTML!==next.innerHTML)cur.innerHTML=next.innerHTML;return}
b.forEach((n,i)=>{const o=a[i];if(!o)return cur.append(n);if(o.tagName==='DETAILS'&&n.tagName==='DETAILS')n.open=o.open;if(o.outerHTML!==n.outerHTML)o.replaceWith(n)});a.slice(b.length).forEach((o)=>o.remove())};
const sync=async()=>{try{const r=await fetch(location.pathname,{cache:'no-store',headers:{accept:'text/html'}});if(!r.ok||leaving)return;const doc=new DOMParser().parseFromString(await r.text(),'text/html');const fresh=doc.querySelectorAll('[data-live]');if(!fresh.length)return location.reload();
fresh.forEach((n)=>{const cur=document.querySelector('[data-live="'+n.dataset.live+'"]');if(cur)morph(cur,n)})}catch{}};
const soon=()=>{clearTimeout(t);t=setTimeout(sync,150)};
const es=new EventSource('/events');es.addEventListener('change',soon);es.onopen=()=>{if(opened)soon();opened=true};
addEventListener('submit',(e)=>{if(!e.defaultPrevented)leaving=true});
addEventListener('pageshow',(e)=>{if(e.persisted){leaving=false;soon()}})})()</script>`;
