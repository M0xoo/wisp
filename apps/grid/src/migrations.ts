// grid.db's migrations, in order. Forward only: a migration is never edited once released, and a
// new one is appended. Each runs in its own transaction (db.ts). The index + 1 is the schema version
// kept in meta('schema'), so the order is the contract with every grid.db already out there.

export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL, email TEXT, name TEXT, avatar TEXT,
     created_at INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE identities (
     provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     email TEXT, login TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (provider, subject));
   CREATE INDEX identities_user ON identities(user_id);
   CREATE TABLE sessions (
     id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, scope TEXT NOT NULL,
     created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, ua TEXT);
   CREATE TABLE devices (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
     token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER);
   CREATE TABLE device_codes (
     code_hash TEXT PRIMARY KEY, user_code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, user_id TEXT,
     created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, approved_at INTEGER, denied_at INTEGER,
     consumed_at INTEGER, last_poll_at INTEGER);
   CREATE TABLE tickets (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
   CREATE TABLE instances (
     user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, state TEXT NOT NULL, host TEXT,
     created_at INTEGER NOT NULL, started_at INTEGER, stopped_at INTEGER, last_active_at INTEGER,
     next_wake_at INTEGER, stop_reason TEXT);
   CREATE TABLE keys (user_id TEXT PRIMARY KEY, kid TEXT NOT NULL, wrapped TEXT NOT NULL);
   CREATE TABLE user_secrets (user_id TEXT NOT NULL, purpose TEXT NOT NULL, sealed TEXT NOT NULL, PRIMARY KEY (user_id, purpose));
   CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT NOT NULL, meta TEXT, at INTEGER NOT NULL);`,
  // Computers added to the grid (wisp on a desktop: Machines → This computer), one per device,
  // reached at <label>.<domain> through the tunnel the computer holds open (grid/tunnels.js).
  `CREATE TABLE computers (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     device_id TEXT UNIQUE NOT NULL REFERENCES devices(id) ON DELETE CASCADE, name TEXT NOT NULL,
     label TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER);
   CREATE INDEX computers_user ON computers(user_id);`,
  // People waiting for a seat (the site's form, or a sign-in the full grid turned away): the
  // oldest get the next seats, held for them a while. How busy the host was, every few minutes,
  // which is what opens seats with auth.maxUsers "auto". And what more people with a seat want
  // (another machine, a bigger one, a GPU), from their account page.
  `CREATE TABLE waitlist (
     email TEXT PRIMARY KEY, source TEXT NOT NULL, created_at INTEGER NOT NULL, invited_at INTEGER,
     joined_at INTEGER, user_id TEXT);
   CREATE TABLE load_samples (at INTEGER PRIMARY KEY, running INTEGER NOT NULL, capacity INTEGER NOT NULL, waits INTEGER NOT NULL);
   CREATE TABLE machine_wishes (
     user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, wants TEXT NOT NULL, note TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  // Apps people published from My Stuff (grid/sites.js), open to anyone at <label>.<domain>. key:
  // the item in their My Stuff, so publishing it again updates the same link. db: null, or its
  // database's seed file ('' for none) when its wisp-app.json asks for one (server/app-db.js).
  `CREATE TABLE sites (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL,
     label TEXT UNIQUE NOT NULL, title TEXT NOT NULL, entry TEXT NOT NULL, files INTEGER NOT NULL,
     size INTEGER NOT NULL, db TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (user_id, key));`,
  // Tasks people shared from their wisp (grid/shares.js), at <publicUrl>/s/<id>. key: the task on
  // their wisp, so sharing it again updates the same link. pass: the passkey's scrypt hash, or null.
  `CREATE TABLE shares (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL,
     title TEXT NOT NULL, pass TEXT, size INTEGER NOT NULL, meta TEXT NOT NULL,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (user_id, key));`,
  // Sandboxes (grid/sandboxes.js): a box of its own for one task (/sandbox in wisp), at
  // <label>.<domain> (label "sb-<id>--<handle>"). Its home is its own; it goes when its task does.
  `CREATE TABLE sandboxes (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     label TEXT UNIQUE NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE INDEX sandboxes_user ON sandboxes(user_id);`,
  // API keys (grid/accounts.js): a script's way in to its user's own wisp, and nowhere else. hint:
  // the key's last 4 characters, so a person can tell keys apart; the key itself is never kept.
  `CREATE TABLE api_keys (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
     token_hash TEXT UNIQUE NOT NULL, hint TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
   CREATE INDEX api_keys_user ON api_keys(user_id);`,
  // What a ticket is good for. 'preview:<label>': that one box's or computer's preview addresses (a
  // preview link, which anything on a box can ask for, must never become a session anywhere else).
  // NULL: the user's own addresses, never a preview's.
  `ALTER TABLE tickets ADD COLUMN scope TEXT;`,
  // Channels on a box (grid/inbox.js): one unguessable URL per user and channel, and what came to it
  // while the box slept. The token itself is sealed in user_secrets; dropped: lost messages the box
  // hasn't been told about. event_key stops a sender's retry; a delivered row keeps only that, until
  // its hour is up.
  `CREATE TABLE channel_urls (
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, channel TEXT NOT NULL,
     token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, dropped INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (user_id, channel));
   CREATE TABLE channel_inbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     channel TEXT NOT NULL, event_key TEXT NOT NULL, headers TEXT NOT NULL, body BLOB NOT NULL,
     size INTEGER NOT NULL, at INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0,
     next_at INTEGER NOT NULL DEFAULT 0, done_at INTEGER, UNIQUE (user_id, event_key));
   CREATE INDEX channel_inbox_held ON channel_inbox(user_id, done_at, id);`,
  // Mail (grid/mail.js): a message a box accepted, which is all it may answer, and the replies of the
  // last hour, which is how many it may. The address and ids stay in the clear: the grid has to use them.
  `CREATE TABLE mail_threads (
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, message_id TEXT NOT NULL,
     to_addr TEXT NOT NULL, refs TEXT NOT NULL, at INTEGER NOT NULL,
     PRIMARY KEY (user_id, message_id));
   CREATE TABLE mail_sent (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, at INTEGER NOT NULL);
   CREATE INDEX mail_sent_user ON mail_sent(user_id, at);`,
  // `on laptop` (grid/route.js). channel_routes: a bot's webhook URL, by its token's hash; the token,
  // the bot's and the webhook's secret are sealed in user_secrets. channel_threads: one per routed
  // message, where a computer's report goes; channel_thread_msgs: what the grid sent there, for a
  // reply to it. verified: the grid checked this row itself, so the box doesn't have to.
  `CREATE TABLE channel_routes (
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, channel TEXT NOT NULL,
     token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, channel));
   CREATE TABLE channel_threads (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     computer_id TEXT NOT NULL REFERENCES computers(id) ON DELETE CASCADE, channel TEXT NOT NULL,
     chat TEXT NOT NULL, message INTEGER NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE channel_thread_msgs (
     user_id TEXT NOT NULL, chat TEXT NOT NULL, message INTEGER NOT NULL,
     thread_id TEXT NOT NULL REFERENCES channel_threads(id) ON DELETE CASCADE, at INTEGER NOT NULL,
     PRIMARY KEY (user_id, chat, message));
   ALTER TABLE channel_inbox ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;`,
];

/** Every table the migrations make, for tests and `wisp grid backup` checks. */
export const TABLES: readonly string[] = [...new Set(MIGRATIONS.flatMap((m) => [...m.matchAll(/CREATE TABLE (\w+)/g)].map((x) => x[1] ?? '')))];
