// Not a harness: GitHub's CLI, signed in from wisp for git push and pull requests (Ship it), on a box
// with no other way in (v1 agent-login.js LOGINS.gh). Afterwards git uses gh's login, and commits get
// your GitHub name if git has none. wisp.accounts' own login: it never shows up in the harness list.

import type { LoginExec, LoginSpec } from './harnesses.ts';
import { rec, str } from './ports.ts';

const said = (out: string): boolean | null => (/not (logged|signed) in/i.test(out) ? false : /(logged|signed) in/i.test(out) ? true : null);

/** After gh signs in: git pushes with its login, and has a name and email for commits. */
export async function gitFromGh(exec: LoginExec, env: Record<string, string | undefined>): Promise<void> {
  const gh = env['WISP_GH_BIN'] || 'gh';
  await exec(gh, ['auth', 'setup-git', '--hostname', 'github.com']);
  const has = async (k: string): Promise<string> => (await exec('git', ['config', '--global', k])).stdout.trim();
  if ((await has('user.name')) && (await has('user.email'))) return;
  let u: Record<string, unknown>;
  try {
    u = rec(JSON.parse((await exec(gh, ['api', 'user'])).stdout));
  } catch {
    return;
  }
  const login = str(u['login']);
  if (!login) return;
  if (!(await has('user.name'))) await exec('git', ['config', '--global', 'user.name', str(u['name']) || login]);
  if (!(await has('user.email'))) await exec('git', ['config', '--global', 'user.email', str(u['email']) || `${str(u['id'])}+${login}@users.noreply.github.com`]);
}

export function ghLogin(env: Record<string, string | undefined>): LoginSpec {
  return {
    bin: 'gh',
    binEnv: 'WISP_GH_BIN',
    tool: true,
    args: ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https', '--skip-ssh-key'],
    logout: ['auth', 'logout', '--hostname', 'github.com'],
    status: ['auth', 'status', '--hostname', 'github.com'],
    keys: ['GH_TOKEN', 'GITHUB_TOKEN'],
    signedIn: said,
    after: (exec) => gitFromGh(exec, env),
  };
}
