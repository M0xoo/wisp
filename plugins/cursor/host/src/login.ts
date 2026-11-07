// Cursor Agent's sign-in, as wisp.accounts reads it through the harness contract (v1
// server/agent-login.js LOGINS.cursor). Values are v1's, word for word.

import type { HarnessLogin } from '@wisp-plugin/runtime-api';

const said = (out: string): boolean | null => (/not (logged|signed) in/i.test(out) ? false : /(logged|signed) in/i.test(out) ? true : null);

export const login: HarnessLogin = {
  bin: 'cursor-agent',
  binEnv: 'WISP_CURSOR_BIN',
  args: ['login'],
  logout: ['logout'],
  status: ['status'],
  keys: ['CURSOR_API_KEY'],
  signedIn: said,
  extraEnv: { NO_OPEN_BROWSER: '1' },
  authFailed: /^(?:Error: )?(?:Authentication required|Not logged in)\b|run '(?:cursor-)?agent login'/im,
};
