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

  // Dragging the window by the page (the top bar, the rail, a task's head) is the page's own: v2's frame marks those
  // [data-drag] and asks start_drag and zoom_window on a Mac (packages/shell/src/platform/desktop.ts), as v1's rules
  // here did. Windows and Linux have a title bar of their own, where a click on the top bar is a click and the window
  // stays put: WebView2 would honour a -webkit-app-region a page or a plugin's style sets, so it's turned off.
  if (!/Mac/.test(navigator.platform)) {
    const noRegions = new CSSStyleSheet();
    noRegions.replaceSync('* { -webkit-app-region: no-drag !important; }');
    document.adoptedStyleSheets = [noRegions];
  }
})();
