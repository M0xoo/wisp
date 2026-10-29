// Watch's sealed document: the page an agent put up beside its task (server/watch.js), with wisp's
// head before it. DOM-free, so the tests can check what goes around the agent's HTML. The frame is
// `sandbox="allow-scripts"` (its own opaque origin: no cookies, no wisp API, no popups) and the CSP
// comes first, so a later policy can only tighten it. Unlike the app block's, scripts, styles and
// fonts may come from https CDNs (a chart library); it still can't fetch or send anything.

import { themeCss } from './app-doc.js';

const CSP = "default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob:; connect-src 'none'; form-action 'none'";

// Under the agent's own styles: wisp's look by default, any of it overridable.
const BASE = `*,*::before,*::after{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;padding:16px;font:13px/1.45 var(--sans);color:var(--ink);background:var(--bg);overflow-wrap:break-word}img,svg,canvas,video{max-width:100%}button,input,select,textarea{font:inherit;color:inherit}`;

// What the page's scripts get as `wisp`: the last state, and on('state'|'theme', fn) for what
// comes next. A handler added after a state arrived is called with it at once.
const bridge = (init) => `(()=>{let {state:st,scheme:th}=${init};const hs={state:new Set(),theme:new Set()};
const fire=(k,v)=>hs[k].forEach((f)=>{try{f(v)}catch(e){console.error(e)}});
window.wisp=Object.freeze({get state(){return st},get theme(){return th},on(k,f){if(!hs[k]||typeof f!=='function')return()=>{};hs[k].add(f);if(k==='state'&&st!==null)queueMicrotask(()=>hs.state.has(f)&&f(st));return()=>hs[k].delete(f)}});
addEventListener('message',(e)=>{const m=e.data||{};if(e.source!==parent)return;if(m.type==='state'){st=m.state??null;fire('state',st)}else if(m.type==='theme'){document.getElementById('wisp-theme').textContent=m.css;th=m.scheme;fire('theme',th)}});
window.alert=window.confirm=window.prompt=()=>{};})()`;

// The srcdoc: wisp's head, then the agent's page (a whole document or a fragment). A doctype it
// starts with goes: ours comes first, and its <html>/<head> tags merge into the ones begun here.
export function watchDoc(html, { vars, scheme = 'light', state = null } = {}) {
  const init = JSON.stringify({ state, scheme }).replace(/</g, '\\u003c');
  const page = String(html ?? '').replace(/^\s*<!doctype[^>]*>/i, '');
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style id="wisp-theme">${themeCss(vars, scheme)}</style><style>${BASE}</style><script>${bridge(init)}</script>${page}`;
}
