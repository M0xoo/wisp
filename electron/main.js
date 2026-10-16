// wisp desktop shell. The Node server runs inside Electron's main process and
// the window loads the same UI the browser mode serves.

import { app, BrowserWindow, shell, nativeTheme, Menu, dialog, ipcMain, clipboard } from 'electron';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WISP_PORT) || 4477;
const URL_BASE = `http://localhost:${PORT}`;
const DEV = process.env.WISP_DEV === '1';

// Apps launched from Finder/Dock get a minimal PATH, so `claude` (nvm, homebrew,
// ~/.local/bin…) wouldn't be found. Borrow the PATH from the user's login shell.
function inheritShellPath() {
  if (process.platform === 'win32') return;
  try {
    const sh = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(sh, ['-ilc', 'printf "__WISP__%s__WISP__" "$PATH"'], { encoding: 'utf8', timeout: 5000 });
    const m = out.match(/__WISP__(.*)__WISP__/);
    if (m?.[1]) process.env.PATH = m[1];
  } catch {}
}

if (DEV) app.commandLine.appendSwitch('remote-debugging-port', process.env.WISP_DEBUG_PORT || '9339');
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let server = null;

async function ensureServer() {
  try {
    await fetch(`${URL_BASE}/api/config`);
    return; // a wisp server (e.g. from the CLI) is already running — just attach to it
  } catch {}
  const { startServer } = await import('../server/index.js');
  server = await startServer({ port: PORT, handleSignals: false });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 720,
    minHeight: 520,
    title: 'wisp',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111111' : '#ffffff',
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(here, 'preload.cjs') },
  });

  win.loadURL(URL_BASE);
  win.once('ready-to-show', () => win.show());

  // Editor links (vscode://…), docs links etc. open outside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(URL_BASE)) shell.openExternal(url);
    else return { action: 'allow' };
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(URL_BASE)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // The page title carries the "needs you" count: "(3) wisp" → dock badge.
  win.on('page-title-updated', (e, title) => {
    e.preventDefault();
    const n = Number(title.match(/^\((\d+)\)/)?.[1] || 0);
    app.setBadgeCount(n);
  });

  // Electron has no right-click menu by default: give text and links the usual one.
  win.webContents.on('context-menu', (_, p) => {
    const f = p.editFlags;
    const items = [
      ...p.dictionarySuggestions.map((w) => ({ label: w, click: () => win.webContents.replaceMisspelling(w) })),
      ...(p.misspelledWord ? [{ type: 'separator' }] : []),
      ...(p.linkURL ? [{ label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) }, { type: 'separator' }] : []),
      ...(p.isEditable ? [{ role: 'undo', enabled: f.canUndo }, { role: 'redo', enabled: f.canRedo }, { type: 'separator' }] : []),
      ...(p.isEditable ? [{ role: 'cut', enabled: f.canCut }] : []),
      ...(p.isEditable || p.selectionText ? [{ role: 'copy', enabled: f.canCopy }] : []),
      ...(p.isEditable ? [{ role: 'paste', enabled: f.canPaste }, { role: 'pasteAndMatchStyle', enabled: f.canPaste }] : []),
      { role: 'selectAll', enabled: f.canSelectAll },
      ...(DEV ? [{ type: 'separator' }, { label: 'Inspect Element', click: () => win.webContents.inspectElement(p.x, p.y) }] : []),
    ];
    Menu.buildFromTemplate(items).popup({ window: win });
  });

  win.on('closed', () => (win = null));
}

ipcMain.handle('wisp:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Add project' });
  return r.canceled ? null : r.filePaths[0];
});

app.on('second-instance', () => {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.focus();
});

// Agents keep running with the window closed; quitting stops them.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => !win && createWindow());
app.on('before-quit', () => server?.shutdown());

// Dev: web/ edits reload the window, server/ or electron/ edits relaunch the app.
// Agents run inside this process, so when wisp is working on itself a relaunch
// would kill them mid-task: hold it until nothing is running.
function watchForDev() {
  const root = path.join(here, '..');
  let timer;
  let pending = null;
  const debounce = (fn) => (clearTimeout(timer), (timer = setTimeout(fn, 120)));
  const busy = () => server?.runner.live.size || 0;
  const relaunch = () => {
    if (busy()) return;
    clearInterval(pending);
    console.log('[wisp dev] relaunching');
    server?.shutdown();
    app.relaunch();
    app.exit(0);
  };
  fs.watch(path.join(root, 'web'), { recursive: true }, () =>
    debounce(() => BrowserWindow.getAllWindows().forEach((w) => w.webContents.reloadIgnoringCache())),
  );
  for (const dir of ['server', 'electron'])
    fs.watch(path.join(root, dir), { recursive: true }, (_, file) =>
      debounce(() => {
        if (!busy()) return relaunch();
        console.log(`[wisp dev] ${dir}/${file} changed — relaunching once ${busy()} running session(s) finish`);
        pending ??= setInterval(relaunch, 2000);
      }),
    );
  console.log('[wisp dev] watching web/ (reload) and server/, electron/ (relaunch when idle)');
}

app.whenReady().then(async () => {
  app.setName('wisp');
  if (process.platform === 'darwin') app.dock?.setIcon(path.join(here, 'icon.png'));
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
  inheritShellPath();
  await ensureServer();
  createWindow();
  if (DEV) watchForDev();
});
