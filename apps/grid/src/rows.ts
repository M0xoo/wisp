// The rows of grid.db (migrations.ts), as the queries read them. One shape per table: a module that
// selects fewer columns uses Pick<> of these, so a renamed column fails the type check everywhere.

export interface UserRow {
  [k: string]: unknown;
  id: string;
  handle: string;
  email: string | null;
  name: string | null;
  avatar: string | null;
  created_at: number;
  disabled: number;
}

export interface IdentityRow {
  [k: string]: unknown;
  provider: string;
  subject: string;
  user_id: string;
  email: string | null;
  login: string | null;
  created_at: number;
}

export interface SessionRow {
  [k: string]: unknown;
  id_hash: string;
  user_id: string;
  scope: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  ua: string | null;
}

export interface DeviceRow {
  [k: string]: unknown;
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

export interface DeviceCodeRow {
  [k: string]: unknown;
  code_hash: string;
  user_code: string;
  name: string;
  user_id: string | null;
  created_at: number;
  expires_at: number;
  approved_at: number | null;
  denied_at: number | null;
  consumed_at: number | null;
  last_poll_at: number | null;
}

export interface TicketRow {
  [k: string]: unknown;
  hash: string;
  user_id: string;
  expires_at: number;
  used_at: number | null;
  scope: string | null;
}

export interface InstanceRow {
  [k: string]: unknown;
  user_id: string;
  state: string;
  host: string | null;
  created_at: number;
  started_at: number | null;
  stopped_at: number | null;
  last_active_at: number | null;
  next_wake_at: number | null;
  stop_reason: string | null;
}

export interface ComputerRow {
  [k: string]: unknown;
  id: string;
  user_id: string;
  device_id: string;
  name: string;
  label: string;
  created_at: number;
  last_seen_at: number | null;
}

export interface WaitlistRow {
  [k: string]: unknown;
  email: string;
  source: string;
  created_at: number;
  invited_at: number | null;
  joined_at: number | null;
  user_id: string | null;
}

export interface SiteRow {
  [k: string]: unknown;
  id: string;
  user_id: string;
  key: string;
  label: string;
  title: string;
  entry: string;
  files: number;
  size: number;
  db: string | null;
  created_at: number;
  updated_at: number;
}

export interface ShareRow {
  [k: string]: unknown;
  id: string;
  user_id: string;
  key: string;
  title: string;
  pass: string | null;
  size: number;
  meta: string;
  created_at: number;
  updated_at: number;
}

export interface SandboxRow {
  [k: string]: unknown;
  id: string;
  user_id: string;
  label: string;
  name: string;
  created_at: number;
}

export interface ApiKeyRow {
  [k: string]: unknown;
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  hint: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface ChannelUrlRow {
  [k: string]: unknown;
  user_id: string;
  channel: string;
  token_hash: string;
  created_at: number;
  dropped: number;
}

export interface ChannelInboxRow {
  [k: string]: unknown;
  id: number;
  user_id: string;
  channel: string;
  event_key: string;
  headers: string;
  body: Uint8Array;
  size: number;
  at: number;
  tries: number;
  next_at: number;
  done_at: number | null;
  verified: number;
}

export interface MailThreadRow {
  [k: string]: unknown;
  user_id: string;
  message_id: string;
  to_addr: string;
  refs: string;
  at: number;
}

export interface ChannelRouteRow {
  [k: string]: unknown;
  user_id: string;
  channel: string;
  token_hash: string;
  created_at: number;
}

export interface ChannelThreadRow {
  [k: string]: unknown;
  id: string;
  user_id: string;
  computer_id: string;
  channel: string;
  chat: string;
  message: number;
  created_at: number;
}

/** Who a box runs for: a user, or a sandbox (`sandbox` its id, `owner` the user it belongs to). */
export interface BoxUser {
  id: string;
  handle: string;
  sandbox?: string;
  owner?: string;
}

/** COUNT(*) AS n */
export interface CountRow {
  [k: string]: unknown;
  n: number;
}
