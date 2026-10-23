// The `app` block's sandboxed document. DOM-free, so the tests can check what goes around the
// agent's HTML. The frame (web/js/app-frame.js) is `sandbox="allow-scripts"`: its own opaque
// origin, so no cookies, no wisp API, no popups and no alert(). The CSP comes first in <head>:
// a later policy can only tighten it, so the agent's HTML can't fetch or send anything out.

export const APP_MAX_HTML = 200_000; // bytes of html a block may carry
export const APP_MAX_STATE = 32_000; // bytes of JSON wisp.save() may keep
export const APP_HEIGHT = [80, 1000]; // px the frame follows its content between
export const APP_NARROW = 520; // px: under this the app gets html.narrow

// wisp's theme, passed in as CSS variables so an app matches light and dark.
export const APP_TOKENS = ['--bg', '--bg-2', '--surface', '--surface-2', '--ink', '--ink-2', '--muted', '--faint', '--line', '--line-2', '--accent', '--accent-ink', '--accent-soft', '--good', '--warn', '--bad', '--info', '--add-bg', '--del-bg', '--shadow-1', '--shadow-2', '--radius', '--sans', '--mono', '--display'];

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

// Small screens: nothing may push the frame wider than the card, long words wrap, media shrink.
const BASE = `*,*::before,*::after{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;padding:0;font:13px/1.45 var(--sans);color:var(--ink);background:var(--surface);overflow-wrap:break-word}img,svg,canvas,video{max-width:100%}button,input,select,textarea{font:inherit;color:inherit}`;

// What the page's scripts get as `wisp`. Height follows the body; html.narrow under APP_NARROW.
const bridge = (init) => `(()=>{const post=(m)=>parent.postMessage({wispApp:1,...m},'*');let {state:st,scheme:th}=${init};
const fit=()=>{document.documentElement.classList.toggle('narrow',innerWidth<${APP_NARROW});post({type:'height',h:Math.ceil(document.body.getBoundingClientRect().height)})};
window.wisp=Object.freeze({get state(){return st},get theme(){return th},save(s){st=s===undefined?null:JSON.parse(JSON.stringify(s));post({type:'save',state:st})},send(t){post({type:'send',text:String(t)})}});
addEventListener('message',(e)=>{const m=e.data||{};if(e.source!==parent)return;if(m.type==='theme'){document.getElementById('wisp-theme').textContent=m.css;th=m.scheme;dispatchEvent(new Event('wisp-theme'))}});
window.alert=window.confirm=window.prompt=()=>{};
addEventListener('DOMContentLoaded',()=>{new ResizeObserver(fit).observe(document.body);fit()});addEventListener('resize',fit);})()`;

// The theme as a :root rule. vars: { '--ink': '#171717', … }; scheme: 'light' | 'dark'.
export const themeCss = (vars = {}, scheme = 'light') =>
  `:root{${Object.entries(vars).map(([k, v]) => `${k}:${String(v).replace(/[;{}<]/g, '')}`).join(';')};color-scheme:${scheme === 'dark' ? 'dark' : 'light'}}`;

// The srcdoc for an app: CSP, theme, base styles, the bridge (with its saved state), then the
// agent's HTML as the body.
export function appDoc(html, { vars, scheme = 'light', state = null } = {}) {
  const init = JSON.stringify({ state, scheme }).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style id="wisp-theme">${themeCss(vars, scheme)}</style><style>${BASE}</style><script>${bridge(init)}</script></head><body>${String(html ?? '')}</body></html>`;
}

// Why an app can't be shown, or '' when it can.
export function appProblem(b) {
  if (typeof b?.html !== 'string' || !b.html.trim()) return 'The app has no html.';
  if (new TextEncoder().encode(b.html).length > APP_MAX_HTML) return `The app is larger than ${APP_MAX_HTML / 1000} KB.`;
  return '';
}

// A key for the block's saved state on its turn: its place in the presentation, else its content.
export function appKey(b, blocks) {
  const i = Array.isArray(blocks) ? blocks.indexOf(b) : -1;
  if (i >= 0) return `app:${i}`;
  let h = 0;
  for (const c of `${b?.title || ''}\n${b?.html || ''}`) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  return `app:h${(h >>> 0).toString(36)}`;
}
