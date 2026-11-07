// Injected into wisp's page, main frame only, before its scripts run (src/main.rs).
(() => {
  const invoke = (cmd) => window.__TAURI_INTERNALS__.invoke(cmd);
  window.wispDesktop = Object.freeze({ pickFolder: () => invoke('pick_folder') });

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
  addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.ctrlKey || !drags(e.target)) return;
    e.preventDefault(); // as in Electron, a drag region isn't the page's: no focus, no selection
    invoke(e.detail === 2 ? 'zoom_window' : 'start_drag');
  }, true);
})();
