// Codex's sign-in and accounts, as wisp.accounts reads them through the harness contract (v1
// server/agent-login.js LOGINS.codex + whoIs, server/accounts.js HOMES.codex + NAMES). Values are
// v1's, word for word.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HarnessAccounts, HarnessLogin } from '@wisp-plugin/runtime-api';

/** Proposed for HarnessAccounts: the folders made in the CLI's own folder before linking. */
export type AccountsWithDirs = HarnessAccounts & { dirs: string[] };

const said = (out: string): boolean | null => (/not (logged|signed) in/i.test(out) ? false : /(logged|signed) in/i.test(out) ? true : null);

const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const cap = (s: string): string => (s ? (s[0] ?? '').toUpperCase() + s.slice(1) : '');

export const login: HarnessLogin = {
  bin: 'codex',
  binEnv: 'WISP_CODEX_BIN',
  args: ['login', '--device-auth'],
  logout: ['logout'],
  status: ['login', 'status'],
  keys: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  signedIn: said,
  authFailed: /could not be refreshed|please (?:log out and )?sign in again|no codex credentials|run `?codex login|\b401 Unauthorized\b|refresh_token_invalidated/i,
  // Codex keeps its ChatGPT id token (a JWT with the email and plan) in auth.json.
  whoIs: async (_out, env) => {
    try {
      const home = env['CODEX_HOME'] || path.join(os.homedir(), '.codex');
      const token = rec(rec(JSON.parse(await fs.readFile(path.join(home, 'auth.json'), 'utf8')))['tokens'])['id_token'];
      const claims = rec(JSON.parse(Buffer.from((typeof token === 'string' ? token : '').split('.')[1] ?? '', 'base64url').toString('utf8')));
      const plan = rec(claims['https://api.openai.com/auth'])['chatgpt_plan_type'];
      return { email: typeof claims['email'] === 'string' ? claims['email'] : '', plan: cap(typeof plan === 'string' ? plan : '') };
    } catch {
      return {};
    }
  },
};

// Codex may tie its encrypted reasoning to the login's organisation, so a conversation doesn't
// resume on another account: it starts afresh with a handoff of the turns instead.
export const accounts: AccountsWithDirs = {
  env: 'CODEX_HOME',
  home: (env, home) => env['CODEX_HOME'] || path.join(home, '.codex'),
  own: ['auth.json', 'installation_id', 'app-server-control', 'app-server-daemon', 'mcp-oauth-locks'],
  resumes: false,
  extra: 'https://developers.openai.com/codex/pricing',
  label: 'Codex',
  dirs: ['sessions'],
};
