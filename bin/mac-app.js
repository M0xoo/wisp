// macOS names the Dock tile, menu bar and Cmd-Tab entry after the running .app bundle's
// Info.plist, not app.setName(). So run Electron from a clone of Electron.app renamed to wisp
// (APFS clone: instant, no extra disk), cached per Electron version.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REV = 1; // bump when the patching below changes
const ICON = fileURLToPath(new URL('../electron/icon.png', import.meta.url));

// electronBin: …/Electron.app/Contents/MacOS/Electron → the same binary inside wisp.app, or the
// original path if anything goes wrong (worst case the Dock says "Electron" again).
export function wispAppBinary(electronBin) {
  try {
    const src = path.resolve(electronBin, '../../..');
    if (!src.endsWith('.app')) return electronBin;
    const version = readFileSync(path.join(src, '../version'), 'utf8').trim();
    const root = path.join(os.homedir(), 'Library/Caches/wisp');
    const app = path.join(root, `electron-${version}-r${REV}`, 'wisp.app');
    const bin = path.join(app, 'Contents/MacOS', path.basename(electronBin));
    if (existsSync(bin)) return bin;

    mkdirSync(root, { recursive: true });
    const tmp = mkdtempSync(path.join(root, 'build-'));
    const out = path.join(tmp, 'wisp.app');
    try {
      execFileSync('cp', ['-cR', src, out], { stdio: 'ignore' });
    } catch {
      execFileSync('cp', ['-R', src, out], { stdio: 'ignore' }); // not APFS
    }
    const plist = path.join(out, 'Contents/Info.plist');
    const set = (key, value) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
    set('CFBundleName', 'wisp');
    set('CFBundleDisplayName', 'wisp');
    set('CFBundleIdentifier', 'dev.wisp.app');
    try {
      makeIcns(path.join(out, 'Contents/Resources/wisp.icns'), tmp);
      set('CFBundleIconFile', 'wisp.icns');
    } catch {}

    mkdirSync(path.dirname(app), { recursive: true });
    rmSync(app, { recursive: true, force: true });
    renameSync(out, app);
    rmSync(tmp, { recursive: true, force: true });
    return bin;
  } catch {
    return electronBin;
  }
}

function makeIcns(dest, tmp) {
  const set = path.join(tmp, 'wisp.iconset');
  mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    for (const [scale, suffix] of [[1, ''], [2, '@2x']]) {
      const px = String(s * scale);
      execFileSync('sips', ['-z', px, px, ICON, '--out', path.join(set, `icon_${s}x${s}${suffix}.png`)], { stdio: 'ignore' });
    }
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', dest], { stdio: 'ignore' });
}
