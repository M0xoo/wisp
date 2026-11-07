// The parts of `on laptop` (route.ts) that talk to Telegram and to a computer: the sealed bot, the
// threads a computer's report goes back on, sending a line, and the one forward through the tunnel.

import type { Db } from './db.ts';
import { bad } from './errors.ts';
import type { ChannelThreadRow, ComputerRow, UserRow } from './rows.ts';
import { safeEqual, sha256, token as newToken, type Secrets } from './secrets.ts';
import type { Tunnels } from './tunnels.ts';

/** A routed message for a computer (trust.ts MARKS): only forward() sets it; the computer's edge drops it from all else. */
export const ROUTE_MARK = 'x-wisp-route';
const TEXT_MAX = 4000;
const FETCH_MS = 15_000;
const PAGE_MS = 3_000; // the account page waits for this, so not long
const THREAD_TTL_MS = 7 * 86_400_000; // a task can take a while to report
const THREAD_MSGS = 40; // per thread, oldest gone first
export const BOX_BOT = 'route:box-bot'; // the botMark of the bot this user's box says it has
const sealedAs = (channel: string): string => `route:${channel}`;
// The box makes the same one from its token. A token is too long to guess from this.
export const botMark = (token: string): string => sha256(`wisp bot|${token}`);

/** What the grid keeps of a bot it owns, sealed: never shown, never given to a box. */
export interface Route {
  bot: string;
  name: string;
  secret: string;
  senders: string[];
}

/** The parts of a Telegram update the grid reads. */
export interface TgMessage {
  message_id: number;
  text?: unknown;
  date?: number;
  chat: { id: number | string; type?: string };
  from?: { id: number | string; is_bot?: boolean; first_name?: string };
  forward_origin?: unknown;
  forward_date?: unknown;
  reply_to_message?: { message_id?: number; from?: { is_bot?: boolean } };
}
export interface TgUpdate {
  update_id?: unknown;
  message?: TgMessage;
}

export type RouteTunnels = Pick<Tunnels, 'online' | 'ask'>;

export function createTelegram({ db, cfg, secrets, tunnels }: { db: Db; cfg: { publicUrl: string; channels?: { telegramApi?: string } | undefined }; secrets: Secrets; tunnels: RouteTunnels }) {
  const base = String(cfg.channels?.telegramApi || 'https://api.telegram.org').replace(/\/+$/, '');

  async function telegram(bot: string, method: string, body: Record<string, unknown>, ms = FETCH_MS): Promise<Record<string, unknown> | undefined> {
    const r = await fetch(`${base}/bot${bot}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: unknown };
    if (!j.ok) throw bad(`Telegram said: ${j.description || r.status}`);
    return typeof j.result === 'object' && j.result !== null ? (j.result as Record<string, unknown>) : undefined;
  }

  const open = (userId: string): Route | null => {
    const raw = secrets.open(userId, sealedAs('telegram'));
    return raw ? (JSON.parse(raw) as Route) : null;
  };

  // Whether this user's box has proved it holds the bot routing uses.
  const shared = (userId: string): boolean => {
    const r = open(userId);
    const box = r && secrets.open(userId, BOX_BOT);
    return !!r && !!box && safeEqual(box, botMark(r.bot));
  };

  const routeHash = (userId: string): string | undefined => db.get<{ token_hash: string }>('SELECT token_hash FROM channel_routes WHERE user_id = ? AND channel = ?', userId, 'telegram')?.token_hash;
  const keep = (userId: string, sealed: string, tokenHash: string | undefined): void => {
    secrets.seal(userId, sealedAs('telegram'), sealed);
    db.run('INSERT INTO channel_routes (user_id, channel, token_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, channel) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at', userId, 'telegram', tokenHash ?? '', Date.now());
  };
  const forget = (userId: string): void => {
    secrets.drop(userId, sealedAs('telegram'));
    db.run('DELETE FROM channel_routes WHERE user_id = ?', userId);
  };

  // Whether something else set this bot's webhook. Telegram not answering says nothing either way.
  async function moved(userId: string, r: Route): Promise<boolean> {
    const info = await telegram(r.bot, 'getWebhookInfo', {}, PAGE_MS).catch(() => undefined);
    const url = info?.['url'];
    if (typeof url !== 'string') return false;
    const token = url.startsWith(`${cfg.publicUrl}/_route/`) ? url.split('/_route/')[1] : undefined;
    return !token || sha256(token) !== routeHash(userId);
  }

  const expired = (thread: ChannelThreadRow): boolean => thread.created_at < Date.now() - THREAD_TTL_MS;
  // A thread's token: all a computer holds of the chat.
  const threadRef = (id: string): string => `${id}.${secrets.sign(`thread|${id}`)}`;
  const threadOf = (ref: unknown): ChannelThreadRow | null => {
    const [id, sig, more] = String(ref || '').split('.');
    const row = id && sig && more === undefined && secrets.verify(`thread|${id}`, sig) ? db.get<ChannelThreadRow>('SELECT * FROM channel_threads WHERE id = ?', id) : undefined;
    return row && !expired(row) ? row : null;
  };
  function newThread(user: UserRow, c: ComputerRow, m: TgMessage): ChannelThreadRow {
    const id = newToken('', 12);
    db.run('INSERT INTO channel_threads (id, user_id, computer_id, channel, chat, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, user.id, c.id, 'telegram', String(m.chat.id), m.message_id, Date.now());
    const row = db.get<ChannelThreadRow>('SELECT * FROM channel_threads WHERE id = ?', id);
    if (!row) throw new Error('a thread just written is gone');
    return row;
  }
  const noteSent = (thread: ChannelThreadRow | null, messageId: unknown): void => {
    if (!thread || typeof messageId !== 'number') return;
    db.run('INSERT OR IGNORE INTO channel_thread_msgs (user_id, chat, message, thread_id, at) VALUES (?, ?, ?, ?, ?)', thread.user_id, thread.chat, messageId, thread.id, Date.now());
    db.run('DELETE FROM channel_thread_msgs WHERE thread_id = ? AND message NOT IN (SELECT message FROM channel_thread_msgs WHERE thread_id = ? ORDER BY at DESC, message DESC LIMIT ?)', thread.id, thread.id, THREAD_MSGS);
  };

  async function say(route: Route, chat: number | string, text: string, replyTo?: number, thread: ChannelThreadRow | null = null): Promise<void> {
    const sent = await telegram(route.bot, 'sendMessage', { chat_id: chat, text: String(text).slice(0, TEXT_MAX), ...(replyTo && { reply_to_message_id: replyTo, allow_sending_without_reply: true }) });
    noteSent(thread, sent?.['message_id']);
  }

  // Through the tunnel, one try. Whatever comes of it, the person hears, and nothing waits anywhere.
  // The route mark goes on this request and no other: the computer's edge drops it from everything else.
  async function forward(route: Route, c: ComputerRow, u: TgUpdate & { message: TgMessage }, text: string, thread: ChannelThreadRow, follow: boolean): Promise<void> {
    const m = u.message;
    const lost = (line: string): Promise<void> => {
      if (!follow) db.run('DELETE FROM channel_threads WHERE id = ?', thread.id);
      return say(route, m.chat.id, line, m.message_id);
    };
    const offline = `${c.name} is offline, so nothing was sent to it. Send this again when it’s back.`;
    if (!tunnels.online(c.id)) return lost(offline);
    const body = JSON.stringify({ channel: 'telegram', name: 'Telegram', text, sender: m.from?.first_name || '', id: String(u.update_id), at: m.date, thread: threadRef(thread.id), ...(follow && { follow: true }) });
    let r: { status: number; body: string } | null;
    try {
      r = await tunnels.ask(c.id, { path: '/api/channels/routed', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), [ROUTE_MARK]: 'grid' }, body });
    } catch {
      // It may be running: the thread stays, or its report would have nowhere to go.
      return say(route, m.chat.id, `${c.name} didn’t answer, so this may or may not have started. Open wisp there to check.`, m.message_id, thread);
    }
    if (!r) return lost(offline);
    let reply = '';
    try {
      const j: unknown = JSON.parse(r.body);
      const v = typeof j === 'object' && j !== null ? (j as { reply?: unknown }).reply : undefined;
      if (typeof v === 'string') reply = v;
    } catch {
      // no answer worth reading
    }
    if (r.status === 404 && !reply) return lost(`${c.name} needs a newer wisp to take this.`);
    if (r.status >= 300) return lost(reply || `${c.name} couldn’t take this.`);
    if (reply) await say(route, m.chat.id, reply, m.message_id, thread);
  }

  return { telegram, open, shared, keep, forget, routeHash, moved, expired, threadOf, newThread, say, forward };
}

export type TelegramParts = ReturnType<typeof createTelegram>;
