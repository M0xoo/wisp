// Injected into wisp's page before its scripts run (src/main.rs). Main frame only on a Mac; WebView2
// runs every injected script in every frame, a preview's too, so there it stops here. Tauri's own
// stays in those frames, and Tauri checks the frame's own origin: capability.json refuses any other
// (qa/desktop-tauri-win.mjs, TAURI-W06b).
(() => {
  if (window !== window.top) return;
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  window.wispDesktop = Object.freeze({ pickFolder: () => invoke('pick_folder') });

  // A WKWebView's Notification never shows anything. This is the part web/js/features/notify.js uses,
  // so the page has one road on every shell: the same permission flow, and onclick opens the task
  // (src/notify.rs). The plugin's own script ran before this one and sets `permission` once it knows,
  // which on Windows is already: WebView2 runs each script to its end, and its promises with it.
  const notes = new Map();
  const KEEP = 200; // the newest ones a click can still find
  let seq = Math.floor(Date.now() / 1000); // ids from before a reload mustn't find a new note
  let permission = window.Notification?.permission ?? 'default';
  window.Notification = class {
    static get permission() {
      return permission;
    }
    static set permission(state) {
      permission = state;
    }
    static requestPermission() {
      return invoke('plugin:notification|request_permission').then((p) => (permission = p === 'prompt' ? 'default' : p));
    }
    onclick = null;
    constructor(title, { body = '' } = {}) {
      if (permission !== 'granted') return;
      const id = ++seq & 0x7fffffff;
      notes.set(id, this);
      if (notes.size > KEEP) notes.delete(notes.keys().next().value);
      invoke('notify_show', { id, title: String(title), body: String(body) });
    }
    close() {}
  };
  addEventListener('wisp-notify-click', (e) => {
    notes.get(e.detail)?.onclick?.();
    notes.delete(e.detail);
  });

  // A WKWebView keeps saying it has focus with another app in front, and notify.js stays quiet when
  // it does; nor does it fire window focus and blur, on which the page refreshes coming back. The
  // shell knows (src/main.rs).
  let shellFocus = true;
  const hasFocus = document.hasFocus.bind(document);
  document.hasFocus = () => shellFocus && hasFocus();
  addEventListener('wisp-window-focus', (e) => {
    if (shellFocus === e.detail) return;
    shellFocus = e.detail;
    dispatchEvent(new Event(shellFocus ? 'focus' : 'blur'));
  });

  // WebKit has no -webkit-app-region, so these are the same rules as web/css/responsive.css and
  // web/css/split.css, in their order: [selector, drags the window]. A test keeps them in step.
  const REGIONS = [
    ["body.electron .topbar", true],
    ["body.electron .crew-rail", true],
    ["body.electron .crew-rail button", false],
    ["body.electron .topbar button", false],
    ["body.electron .topbar a", false],
    ["body.electron .topbar .projects", false],
    ["body.electron .overlay", false],
    ["body.electron .overlay *", false],
    ["body.electron .menu", false],
    ["body.electron .menu *", false],
    ["body.electron .toasts", false],
    ["body.electron .toasts *", false],
    ["body.electron.split .split-head", true],
    ["body.electron.split .split-head button", false],
    ["body.electron.split .split-head a", false],
    ["body.electron.split .split-head .sh-title", false],
    ["body.electron.split.side-hidden .split-head", false],
    ["body.electron.split.side-hidden .split-head .sh-row", true],
    [".split-drag", true],
    ["body.electron.split.stack .pa-open .pa-bar", true],
    ["body.electron.split.stack .pa-open .pa-bar button", false],
  ];
  // The nearest element with a rule decides, as the regions of a child cut into its parent's.
  const drags = (target) => {
    for (let e = target; e instanceof Element; e = e.parentElement) {
      const rule = REGIONS.findLast(([selector]) => e.matches(selector));
      if (rule) return rule[1];
    }
    return false;
  };
  // Only where the page is the title bar. Windows has a title bar of its own, and there Electron's
  // regions do nothing: a click on the top bar is a click, and the window stays where it is. WebView2
  // would honour them, so they're turned off.
  if (/Mac/.test(navigator.platform)) {
    addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.ctrlKey || !drags(e.target)) return;
      e.preventDefault(); // as in Electron, a drag region isn't the page's: no focus, no selection
      invoke(e.detail === 2 ? 'zoom_window' : 'start_drag');
    }, true);
  } else {
    const noRegions = new CSSStyleSheet();
    noRegions.replaceSync('* { -webkit-app-region: no-drag !important; }');
    document.adoptedStyleSheets = [noRegions];
  }
})();
