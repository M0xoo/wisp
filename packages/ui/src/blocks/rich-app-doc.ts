// The `app` block's sandboxed document (v1 web/js/app-doc.js), DOM-free. The frame is
// `sandbox="allow-scripts"`: its own opaque origin, so no cookies, no wisp API, no popups and no
// alert(). The CSP comes first in <head>: a later policy can only tighten it, so the agent's HTML
// can't fetch or send anything out. It reaches wisp only through `wisp.send(text)` / `wisp.save(state)`.

export const APP_MAX_HTML = 200_000; // bytes of html a block may carry
export const APP_MAX_STATE = 32_000; // bytes of JSON wisp.save() may keep
export const APP_HEIGHT: readonly [number, number] = [80, 1000]; // px the frame follows its content between
export const APP_NARROW = 520; // px: under this the app gets html.narrow
export const APP_MAX_SEND = 20_000; // characters of text an app may offer to send

/** wisp's theme, passed in as CSS variables so an app matches light and dark. */
export const APP_TOKENS: readonly string[] = ['--bg', '--bg-2', '--surface', '--surface-2', '--ink', '--ink-2', '--muted', '--faint', '--line', '--line-2', '--accent', '--accent-ink', '--accent-soft', '--good', '--warn', '--bad', '--info', '--add-bg', '--del-bg', '--shadow-1', '--shadow-2', '--radius', '--sans', '--mono', '--display'];

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

// Small screens: nothing may push the frame wider than the card, long words wrap, media shrink.
const BASE = `*,*::before,*::after{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;padding:0;font:13px/1.45 var(--sans);color:var(--ink);background:var(--surface);overflow-wrap:break-word}img,svg,canvas,video{max-width:100%}button,input,select,textarea{font:inherit;color:inherit}`;

// What the page's scripts get as `wisp`. Height follows the body; html.narrow under APP_NARROW.
const bridge = (init: string): string => `(()=>{const post=(m)=>parent.postMessage({wispApp:1,...m},'*');let {state:st,scheme:th}=${init};
const fit=()=>{document.documentElement.classList.toggle('narrow',innerWidth<${APP_NARROW});post({type:'height',h:Math.ceil(document.body.getBoundingClientRect().height)})};
window.wisp=Object.freeze({get state(){return st},get theme(){return th},save(s){st=s===undefined?null:JSON.parse(JSON.stringify(s));post({type:'save',state:st})},send(t){post({type:'send',text:String(t)})}});
addEventListener('message',(e)=>{const m=e.data||{};if(e.source!==parent)return;if(m.type==='theme'){document.getElementById('wisp-theme').textContent=m.css;th=m.scheme;dispatchEvent(new Event('wisp-theme'))}});
window.alert=window.confirm=window.prompt=()=>{};
addEventListener('DOMContentLoaded',()=>{new ResizeObserver(fit).observe(document.body);fit()});addEventListener('resize',fit);})()`;

export type Scheme = 'light' | 'dark';

/** The theme as a :root rule. vars: { '--ink': '#171717', … }. */
export function themeCss(vars: Readonly<Record<string, string>>, scheme: Scheme): string {
  const decls = Object.entries(vars).map(([k, v]) => `${k}:${v.replace(/[;{}<]/g, '')}`);
  return `:root{${decls.join(';')};color-scheme:${scheme === 'dark' ? 'dark' : 'light'}}`;
}

/** The srcdoc for an app: CSP, theme, base styles, the bridge with its saved state, then the agent's HTML. */
export function appDoc(html: string, opts: { readonly vars: Readonly<Record<string, string>>; readonly scheme: Scheme; readonly state: unknown }): string {
  let init: string;
  try {
    init = JSON.stringify({ state: opts.state ?? null, scheme: opts.scheme });
  } catch {
    init = JSON.stringify({ state: null, scheme: opts.scheme });
  }
  init = init.replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style id="wisp-theme">${themeCss(opts.vars, opts.scheme)}</style><style>${BASE}</style><script>${bridge(init)}</script></head><body>${html}</body></html>`;
}

/** Why an app can't be shown ('noHtml' | 'tooBig'), or undefined when it can. */
export function appProblem(html: unknown): 'noHtml' | 'tooBig' | undefined {
  if (typeof html !== 'string' || !html.trim()) return 'noHtml';
  if (new TextEncoder().encode(html).length > APP_MAX_HTML) return 'tooBig';
  return undefined;
}

export const appHeight = (h: unknown): number => {
  const n = typeof h === 'number' || typeof h === 'string' ? Number(h) : Number.NaN;
  return Math.min(Math.max(Math.round(Number.isFinite(n) && n > 0 ? n : 320), APP_HEIGHT[0]), APP_HEIGHT[1]);
};

/** What a message from an app's frame asks for, or undefined when it isn't one of ours. */
export type AppMessage = { readonly type: 'height'; readonly h: number } | { readonly type: 'save'; readonly state: unknown } | { readonly type: 'send'; readonly text: string };

export function readAppMessage(data: unknown): AppMessage | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const m = data as Readonly<Record<string, unknown>>;
  if (!m['wispApp']) return undefined;
  if (m['type'] === 'height' && typeof m['h'] === 'number' && Number.isFinite(m['h'])) return { type: 'height', h: m['h'] };
  if (m['type'] === 'save') return { type: 'save', state: m['state'] ?? null };
  if (m['type'] === 'send' && typeof m['text'] === 'string' && m['text'].trim()) return { type: 'send', text: m['text'].slice(0, APP_MAX_SEND) };
  return undefined;
}

/** A state an app may keep: JSON within APP_MAX_STATE. */
export function keepable(state: unknown): boolean {
  try {
    return (JSON.stringify(state ?? null) ?? '').length <= APP_MAX_STATE;
  } catch {
    return false;
  }
}
