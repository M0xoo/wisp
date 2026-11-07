// opencode's sign-in, as wisp.accounts reads it through the harness contract (v1
// server/agent-login.js KEYS.opencode). Values are v1's, word for word.
//
// opencode signs in with an API key pasted into wisp rather than a login command: its own `auth
// login` only asks on a terminal, so wisp keeps the key where it does (auth.json, as
// `{ type: 'api', key }` per provider); `opencode run` reads it from there. Zen and Go are two
// providers with keys from the same page.

import path from 'node:path';
import type { HarnessKeys } from '@wisp-plugin/runtime-api';

export const keys: HarnessKeys = {
  env: 'OPENCODE_API_KEY',
  url: 'https://opencode.ai/auth',
  providers: [
    { id: 'opencode', name: 'Zen' },
    { id: 'opencode-go', name: 'Go' },
  ],
  // opencode's data folder (xdg-basedir: the same rule on every OS).
  file: (env, home) => path.join(env['XDG_DATA_HOME'] || path.join(home, '.local', 'share'), 'opencode', 'auth.json'),
  // A bad key. A paid provider with no key at all says 'Unexpected server error', which can't be
  // told from any other: that stays an ordinary failure.
  authFailed: /invalid credential|invalid api key|\b401\b|unauthorized/i,
};
