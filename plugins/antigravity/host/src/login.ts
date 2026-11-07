// Antigravity's sign-in, as wisp.accounts reads it through the harness contract (v1
// server/agent-login.js LOGINS.antigravity + forgetAgy). Values are v1's, word for word.
//
// agy has no login command: a first prompt without a login prints Google's link and reads the code
// back, then answers it. Its own wait for the code is short (about a minute). It only asks on a
// terminal, so on Linux (a wisp Grid) it gets one from script(1). Signing out is only /logout inside
// its own TUI, so wisp removes the login where agy keeps it.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { HarnessLogin } from '@wisp-plugin/runtime-api';

/** What a sign-out function may run: the proc service's exec, handed in by wisp.accounts. */
export type LoginExec = (bin: string, args: readonly string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;
export interface LogoutOptions {
  home: string;
  platform: string;
  exec: LoginExec;
}

/** Proposed for HarnessLogin: a sign-out function also gets `exec` (agy's keychain item needs `security`). */
export type LoginWithExec = Omit<HarnessLogin, 'logout'> & { logout: string[] | ((o: LogoutOptions) => Promise<void>) };

/**
 * agy's login: the system keychain on macOS (service "gemini", account "antigravity"), a file in
 * ~/.gemini where there's no keychain (Linux, a wisp Grid).
 */
export async function forgetAgy({ home, platform, exec }: LogoutOptions): Promise<void> {
  await fs.rm(path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), { force: true });
  if (platform === 'darwin') await exec('security', ['delete-generic-password', '-s', 'gemini', '-a', 'antigravity']);
}

export const login: LoginWithExec = {
  bin: 'agy',
  binEnv: 'WISP_ANTIGRAVITY_BIN',
  args: ['-p', 'Reply with OK.'],
  tty: true,
  logout: forgetAgy,
  status: ['models'],
  keys: ['GEMINI_API_KEY'],
  signedIn: (out, code) => (/sign in|authenticat/i.test(out) ? false : code === 0 ? true : null),
  authFailed: /authentication (?:required|failed or timed out|timed out)|not logged into antigravity/i,
};
