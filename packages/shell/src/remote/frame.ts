// The frame an untrusted plugin's UI runs in (ADR-0048 §3): `sandbox="allow-scripts"` (an opaque origin: no cookies,
// no storage of wisp's, no popups, no navigating the app), a CSP that opens nothing (`default-src 'none'`: no
// fetch, no sockets, no images, no frames) but its own inline bootstrap and the blob Worker the plugin's module runs
// in. The Worker has no DOM: it can only post messages, and the frame passes them to the app and back, untouched.
// The app checks every one (descriptor.ts, the call's own plugin set at the edge).

/** No `allow-same-origin`, ever: with it, the frame's scripts could reach the app. */
export const SANDBOX = 'allow-scripts';
export const CSP = "default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; style-src 'none'; base-uri 'none'; form-action 'none'";

/** What the Worker's module sees as `wisp`: render, call, on, watch. Plain JS: it runs in the plugin's Worker. */
export const PRELUDE = `(() => {
  let n = 0;
  const waits = new Map();
  const handlers = new Map();
  self.onmessage = (e) => {
    const m = e.data || {};
    if (m.t === 'result') {
      const w = waits.get(m.id);
      if (!w) return;
      waits.delete(m.id);
      if (m.ok) w[0](m.value); else w[1](new Error(String(m.error || 'refused')));
    } else if (m.t === 'event') {
      const h = handlers.get(m.on);
      if (h) h(m.value);
    }
  };
  const call = (cmd, args) => new Promise((ok, no) => { n += 1; waits.set(n, [ok, no]); postMessage({ t: 'call', id: n, cmd: String(cmd), args: args === undefined ? {} : args }); });
  self.wisp = Object.freeze({
    render: (tree) => postMessage({ t: 'render', tree }),
    call,
    on: (id, fn) => { handlers.set(String(id), fn); },
  });
})();
`;

/** The frame's document: its bootstrap waits for the module, runs it in a Worker, and relays messages both ways. */
export function frameDoc(): string {
  const boot = `(() => {
  let w;
  const up = (m) => parent.postMessage(m, '*');
  addEventListener('message', (e) => {
    if (e.source !== parent) return;
    const m = e.data || {};
    if (m.t === 'load' && !w) {
      const url = URL.createObjectURL(new Blob([${JSON.stringify(PRELUDE)}, '\\n', String(m.code)], { type: 'text/javascript' }));
      w = new Worker(url);
      w.onmessage = (ev) => up(ev.data);
      w.onerror = (ev) => up({ t: 'error', message: String(ev.message || 'the plugin failed') });
    } else if (w) {
      w.postMessage(m);
    }
  });
  up({ t: 'ready' });
})();`;
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"></head><body><script>${boot}</script></body></html>`;
}
