// What's left of an Electron build's folder once Tauri's installer has removed it
// (desktop/src-tauri/installer-hooks.nsh). The Electron build that ran the update started the installer
// from a cmd.exe standing in that folder, and Windows won't delete a folder a process stands in until
// it's gone. The installer starts this hidden, on the bundled Node, and doesn't wait for it.
//
//   node remove-electron.mjs <%LOCALAPPDATA%\Programs\wisp-agents>

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Only electron-builder's folder for wisp, whatever the caller says.
export const isElectronFolder = (dir) => /^wisp-agents$/i.test(path.win32.basename(dir || '')) && /^programs$/i.test(path.win32.basename(path.win32.dirname(dir)));

export async function removeLeftover(dir, { tries = 240, every = 500, rm = fs.rmSync, exists = fs.existsSync } = {}) {
  if (!isElectronFolder(dir)) return false;
  for (let i = 0; i < tries; i++) {
    try {
      rm(dir, { recursive: true, force: true });
    } catch {} // still in use
    if (!exists(dir)) return true;
    await new Promise((r) => setTimeout(r, every));
  }
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = (await removeLeftover(process.argv[2])) ? 0 : 1;
}
