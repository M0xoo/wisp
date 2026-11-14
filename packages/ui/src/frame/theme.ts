// wisp's theme for a framed page: the design tokens as CSS variables, so an app, a pane or an
// answer's interactive block matches light and dark (v1 web/js/app-doc.js APP_TOKENS, themeCss).
// A frame on another origin can't read our styles, so the owner posts these to it, or writes them
// into a srcdoc.

/** The tokens a framed page gets, by name. Stable: apps people made read them. */
export const FRAME_TOKENS = [
  '--bg', '--bg-2', '--surface', '--surface-2', '--ink', '--ink-2', '--muted', '--faint', '--line', '--line-2',
  '--accent', '--accent-ink', '--accent-soft', '--good', '--warn', '--bad', '--info', '--add-bg', '--del-bg',
  '--shadow-1', '--shadow-2', '--radius', '--sans', '--mono', '--display',
] as const;

export type FrameScheme = 'light' | 'dark';
export interface FrameTheme {
  readonly vars: Readonly<Record<string, string>>;
  readonly scheme: FrameScheme;
}

/** The theme as a `:root` rule; a value can't close the rule or open a tag. */
export function themeCss(vars: Readonly<Record<string, string>> = {}, scheme: FrameScheme = 'light'): string {
  const decls = Object.entries(vars).map(([k, v]) => `${k}:${String(v).replace(/[;{}<]/g, '')}`);
  return `:root{${decls.join(';')};color-scheme:${scheme === 'dark' ? 'dark' : 'light'}}`;
}

/** The page's scheme: `data-theme` on the root wins, else the OS's. */
export function currentScheme(doc: Document = document): FrameScheme {
  const t = doc.documentElement.getAttribute('data-theme');
  if (t === 'dark' || t === 'light') return t;
  return doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** The tokens' values as they are now on this page. */
export function readTheme(doc: Document = document): FrameTheme {
  const cs = doc.defaultView?.getComputedStyle(doc.documentElement);
  const vars: Record<string, string> = {};
  for (const name of FRAME_TOKENS) {
    const v = cs?.getPropertyValue(name).trim();
    if (v) vars[name] = v;
  }
  return { vars, scheme: currentScheme(doc) };
}

/**
 * Calls `fn` with the new theme each time it changes (`data-theme` on the root, or the OS's scheme),
 * once the new styles apply. Returns the function that stops it.
 */
export function watchTheme(fn: (t: FrameTheme) => void, doc: Document = document): () => void {
  const win = doc.defaultView;
  let frame = 0;
  const fire = (): void => {
    if (!win) return fn(readTheme(doc));
    win.cancelAnimationFrame(frame);
    frame = win.requestAnimationFrame(() => fn(readTheme(doc)));
  };
  const mo = new MutationObserver(fire);
  mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const mq = win?.matchMedia?.('(prefers-color-scheme: dark)');
  mq?.addEventListener?.('change', fire);
  return () => {
    mo.disconnect();
    mq?.removeEventListener?.('change', fire);
    win?.cancelAnimationFrame(frame);
  };
}

/**
 * The script-less document a locked frame sits in: only a CSP, whose `frame-src` decides where the
 * page inside may navigate (a frame's navigations answer to the CSP of the document holding it,
 * and the sandbox has no such rule). A frame that isn't shown yet waits hidden on top.
 */
export function lockDoc(csp: string): string {
  const safe = csp.replace(/["<>]/g, '');
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${safe}"><style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}iframe[data-pending]{position:absolute;top:0;left:0;visibility:hidden}</style></head><body></body></html>`;
}
