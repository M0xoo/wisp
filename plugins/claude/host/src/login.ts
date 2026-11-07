// Claude Code's sign-in and accounts, as wisp.accounts reads them through the harness contract (v1
// server/agent-login.js LOGINS.claude + whoIs, server/accounts.js HOMES.claude + NAMES + the
// .claude.json special case). Values are v1's, word for word.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { HarnessAccounts, HarnessLogin } from '@wisp-plugin/runtime-api';

/**
 * Proposed for HarnessAccounts (wisp.accounts reads both when present): `dirs`, the folders made in
 * the CLI's own folder before linking, so a link to them is never dangling; `sync`, what can't be a
 * link, brought over after linking.
 */
export type AccountsWithSync = HarnessAccounts & {
  dirs: string[];
  sync(o: { dir: string; base: string; env: Record<string, string | undefined>; userHome: string }): Promise<void>;
};

export const login: HarnessLogin = {
  bin: 'claude',
  binEnv: 'WISP_CLAUDE_BIN',
  args: ['auth', 'login', '--claudeai'],
  logout: ['auth', 'logout'],
  status: ['auth', 'status'],
  keys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'],
  signedIn: (out) => {
    const said = /"loggedIn":\s*(true|false)/.exec(out)?.[1];
    return said === 'true' ? true : said === 'false' ? false : null;
  },
  authFailed: /^(?:Not logged in|Login expired|OAuth token revoked|Login reached its time limit|Authentication required|Failed to authenticate)\b|please run \/login|run \/login to (?:sign in|re-?authenticate)|oauth (?:access )?token has (?:expired|been revoked)|authentication_error|authentication_failed/im,
  // Claude's status is JSON: { loggedIn, email, subscriptionType }.
  whoIs: async (out) => {
    try {
      const j: unknown = JSON.parse(out.slice(out.indexOf('{')));
      const o = typeof j === 'object' && j !== null ? (j as Record<string, unknown>) : {};
      const email = typeof o['email'] === 'string' ? o['email'] : '';
      const sub = typeof o['subscriptionType'] === 'string' ? o['subscriptionType'] : '';
      return { email, plan: sub ? (sub[0] ?? '').toUpperCase() + sub.slice(1) : '' };
    } catch {
      return {};
    }
  },
};

// Keys in .claude.json that say who is signed in: never copied from one account to another.
const NO_SYNC = new Set(['oauthAccount', 'userID', 'primaryApiKey', 'customApiKeyResponses', 'claudeCodeFirstTokenDate', 's1mAccessCache', 'cachedGrowthBookFeatures', 'cachedStatsigGates']);

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const exists = (p: string): Promise<boolean> => fs.lstat(p).then(() => true, () => false);

export const accounts: AccountsWithSync = {
  env: 'CLAUDE_CONFIG_DIR',
  home: (env, home) => env['CLAUDE_CONFIG_DIR'] || path.join(home, '.claude'),
  own: ['.credentials.json', '.claude.json', '.claude.json.lock', 'backups', 'statsig', 'session-env', 'shell-snapshots'],
  resumes: true,
  extra: 'https://support.claude.com/en/articles/11145838',
  label: 'Claude',
  dirs: ['projects', 'todos', 'plans', 'file-history', 'skills', 'agents', 'commands'],
  // Claude keeps the login and your MCP servers in one file (.claude.json), so it can't be linked.
  // The account's copy gets everything from the default one except who's signed in. The default's
  // file sits next to ~/.claude unless CLAUDE_CONFIG_DIR moved it into that folder.
  async sync({ dir, base, env, userHome }) {
    const from = (await readJson(env['CLAUDE_CONFIG_DIR'] ? path.join(base, '.claude.json') : path.join(userHome, '.claude.json'))) ?? {};
    const file = path.join(dir, '.claude.json');
    const mine = (await readJson(file)) ?? {};
    const next: Record<string, unknown> = { ...mine };
    for (const [k, v] of Object.entries(from)) if (!NO_SYNC.has(k)) next[k] = v;
    if (!(await exists(file)) || JSON.stringify(next) !== JSON.stringify(mine)) {
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      await fs.rename(tmp, file);
    }
  },
};
