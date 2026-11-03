// The PATH of the user's login shell, for an app started from Finder or the Dock (electron/main.js).
// No Electron imports, so the tests can run it.

import { execFile } from 'node:child_process';

// Resolves to the shell's PATH, or '' when it fails or takes longer than `ms`. execFile's own
// timeout isn't enough: it sends SIGTERM, which an interactive zsh ignores, so a slow ~/.zshrc
// kept the first window from opening until the shell was done. So the clock is ours, the kill is
// SIGKILL, and stdin is closed so a prompt in an rc file reads end-of-file instead of waiting.
export function readShellPath(sh = process.env.SHELL || '/bin/zsh', ms = 5000) {
  return new Promise((resolve) => {
    let child;
    const timer = setTimeout(() => {
      child?.kill('SIGKILL');
      resolve('');
    }, ms);
    child = execFile(sh, ['-ilc', 'printf "__WISP__%s__WISP__" "$PATH"'], { encoding: 'utf8' }, (err, out) => {
      clearTimeout(timer);
      resolve(String(out || '').match(/__WISP__(.*)__WISP__/)?.[1] || '');
    });
    child.stdin?.end();
    child.on('error', () => {});
  });
}
