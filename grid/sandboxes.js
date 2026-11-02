// Sandboxes: a box of its own for one task. `/sandbox <task>` in wisp (on a computer, or in the
// cloud wisp) asks for one here; the task then runs in it instead of on that computer or in the
// user's own box. A sandbox is one more of hostd's boxes (the same image, runtime, network and
// limits, started on demand and stopped when idle), with a home of its own, so nothing in it can
// read the user's box or their other sandboxes. It goes when its task is deleted.
//
//   address   sb-<id>--<handle>.<domain>, reached with its own token (never the device's): wisp
//             keeps it as a machine (kind 'grid', `sandbox`), and only that sandbox opens with it.
//   sign-ins  a box starts with an empty home, so no harness is signed in there. The user signs in
//             once for all their sandboxes (Settings → Cloud → Sandboxes, `claude setup-token`),
//             wisp sends the token here, sealed per user (secrets.js), and every sandbox starts with
//             it in its environment (CLAUDE_CODE_OAUTH_TOKEN). It never reaches the user's own box.
//   hostd     the box is { id: '<user id>-sb-<id>', handle: <label>, owner, sandbox }: hostd and
//             boxd key everything on that id (its container wisp-u-<id>, its home), the grid seals
//             its proxy secret under the owner.

import { randomBytes } from 'node:crypto';
import { bad } from './accounts.js';
import { safeEqual } from './secrets.js';

export const SANDBOX_DEFAULTS = { enabled: true, perUser: 10 };
export const SANDBOX_ID = /^[a-f0-9]{8}$/;
export const SANDBOX_LABEL = /^sb-([a-f0-9]{8})--([a-z0-9-]+)$/;
// Sign-ins a sandbox can start with: the env var that carries each, and what one looks like.
export const SANDBOX_LOGINS = {
  claude: { env: 'CLAUDE_CODE_OAUTH_TOKEN', test: /^sk-ant-oat01-[A-Za-z0-9_-]{20,400}$/, name: 'Claude' },
};

// Env vars people give their sandboxes (API keys, a database URL): sealed per user like the token.
// Not wisp's own or the shell's basics, which a sandbox needs as they are.
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ENV_RESERVED = /^(WISP_|CLAUDE_CODE_OAUTH_TOKEN$|PATH$|HOME$|USER$|SHELL$|LD_|NODE_OPTIONS$|HOSTNAME$)/;
export const SANDBOX_ENV_MAX = 40;

export function createSandboxes({ db, cfg, secrets }) {
  const opts = { ...SANDBOX_DEFAULTS, ...(cfg.sandboxes || {}) };
  const now = () => Date.now();
  const get = (id) => (SANDBOX_ID.test(String(id || '')) ? db.get('SELECT * FROM sandboxes WHERE id = ?', id) : null);
  const tokenOf = (row) => secrets.ensure(row.user_id, `sandbox:${row.id}`);
  const readEnv = (userId) => {
    try {
      return JSON.parse(secrets.open(userId, 'sandbox-env') || '{}');
    } catch {
      return {};
    }
  };

  return {
    opts,
    get,
    list: (userId) => db.all('SELECT * FROM sandboxes WHERE user_id = ? ORDER BY created_at', userId),
    byLabel: (label) => db.get('SELECT * FROM sandboxes WHERE label = ?', String(label || '').toLowerCase()),
    // What hostd runs: its own box, keyed apart from the owner's.
    box: (row, user) => ({ id: `${row.user_id}-sb-${row.id}`, handle: row.label, owner: row.user_id, sandbox: row.id, ownerHandle: user?.handle || '' }),
    view: (row) => ({ id: row.id, name: row.name, url: cfg.instanceUrl(row.label), createdAt: row.created_at }),

    create(user, name, { taken = () => false } = {}) {
      if (!opts.enabled) throw bad('This grid doesn’t make sandboxes.', 403);
      const have = db.get('SELECT count(*) AS n FROM sandboxes WHERE user_id = ?', user.id).n;
      if (have >= opts.perUser) throw bad(`You have ${have} sandboxes, the most this grid keeps. Delete a sandboxed task you’re done with first.`, 409);
      let id;
      let label;
      do {
        id = randomBytes(4).toString('hex');
        label = `sb-${id}--${user.handle}`;
      } while (get(id) || taken(label));
      const row = { id, user_id: user.id, label, name: String(name || '').trim().replace(/\s+/g, ' ').slice(0, 60) || 'Sandbox', created_at: now() };
      db.run('INSERT INTO sandboxes (id, user_id, label, name, created_at) VALUES (?, ?, ?, ?, ?)', row.id, row.user_id, row.label, row.name, row.created_at);
      return { row, token: tokenOf(row) };
    },
    remove(row) {
      db.run('DELETE FROM sandboxes WHERE id = ?', row.id);
      secrets.drop(row.user_id, `sandbox:${row.id}`);
      secrets.drop(row.user_id, `wisp-proxy:sb:${row.id}`);
    },

    // Its own bearer token: "Bearer wsb_<sandbox id>_<secret>". Only that sandbox opens with it.
    bearer: (row) => `wsb_${row.id}_${tokenOf(row)}`,
    byBearer(auth) {
      const m = /^Bearer\s+wsb_([a-f0-9]{8})_(\S+)$/.exec(String(auth || ''));
      const row = m && get(m[1]);
      return row && safeEqual(m[2], secrets.open(row.user_id, `sandbox:${row.id}`) || '') ? row : null;
    },
    proxySecret: (row) => secrets.ensure(row.user_id, `wisp-proxy:sb:${row.id}`),

    // Which sign-ins the user's sandboxes start with (never the tokens).
    logins: (userId) => Object.fromEntries(Object.keys(SANDBOX_LOGINS).map((a) => [a, !!secrets.open(userId, `sandbox-login:${a}`)])),
    setLogin(userId, agent, token) {
      const l = SANDBOX_LOGINS[agent];
      if (!l) throw bad(`Sandboxes can start signed in to ${Object.values(SANDBOX_LOGINS).map((x) => x.name).join(', ')} only.`);
      const t = String(token || '').trim();
      if (!l.test.test(t)) throw bad(`That isn’t a ${l.name} token (from \`claude setup-token\`).`);
      secrets.seal(userId, `sandbox-login:${agent}`, t);
    },
    dropLogin(userId, agent) {
      if (!SANDBOX_LOGINS[agent]) throw bad('No such sign-in.', 404);
      secrets.drop(userId, `sandbox-login:${agent}`);
    },
    // Their env vars: names only, never the values.
    envKeys: (userId) => Object.keys(readEnv(userId)).sort(),
    setEnv(userId, key, value) {
      const k = String(key || '').trim();
      if (!ENV_KEY.test(k)) throw bad('A name like DATABASE_URL: letters, digits and _, not starting with a digit.');
      if (ENV_RESERVED.test(k)) throw bad(`${k} is wisp’s own: pick another name.`);
      const v = String(value ?? '');
      if (!v || v.length > 8192 || /[\r\n\0]/.test(v)) throw bad('A value on one line, up to 8 KB.');
      const env = readEnv(userId);
      if (!(k in env) && Object.keys(env).length >= SANDBOX_ENV_MAX) throw bad(`Up to ${SANDBOX_ENV_MAX} env vars.`);
      env[k] = v;
      secrets.seal(userId, 'sandbox-env', JSON.stringify(env));
    },
    dropEnv(userId, key) {
      const env = readEnv(userId);
      delete env[String(key || '')];
      if (Object.keys(env).length) secrets.seal(userId, 'sandbox-env', JSON.stringify(env));
      else secrets.drop(userId, 'sandbox-env');
    },
    // A sandbox's environment: its owner's env vars, then the sign-ins they gave sandboxes.
    envFor(userId) {
      const out = { ...readEnv(userId) };
      for (const [a, l] of Object.entries(SANDBOX_LOGINS)) {
        const t = secrets.open(userId, `sandbox-login:${a}`);
        if (t) out[l.env] = t;
      }
      return out;
    },
  };
}
