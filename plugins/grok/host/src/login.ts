// Grok's sign-in, as wisp.accounts reads it through the harness contract (v1 server/agent-login.js
// LOGINS.grok). Values are v1's, word for word. Its status is `grok models`, which says whether it
// is authenticated before it lists anything.

import type { HarnessLogin } from '@wisp-plugin/runtime-api';

export const login: HarnessLogin = {
  bin: 'grok',
  binEnv: 'WISP_GROK_BIN',
  args: ['login', '--device-auth'],
  logout: ['logout'],
  status: ['models'],
  keys: ['XAI_API_KEY'],
  signedIn: (out) => (/not authenticated/i.test(out) ? false : /logged in/i.test(out) ? true : null),
  authFailed: /^(?:Error: )?Not signed in\b|run `?grok login|run \/login to|re-authenticate/im,
};
