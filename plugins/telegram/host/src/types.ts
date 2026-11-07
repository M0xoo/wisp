// The parts of the Telegram Bot API wisp reads (https://core.telegram.org/bots/api#update).

export interface TgChat {
  id: number | string;
  type?: string;
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: { id: number | string; first_name?: string };
  date?: number;
  text?: string;
  reply_to_message?: { message_id: number };
  [field: string]: unknown;
}

export interface TgCallback {
  id: string;
  data?: string;
  message?: { message_id: number; chat?: TgChat };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
  [field: string]: unknown;
}

/** What v1 kept in config.remote.telegram. */
export interface TgConfig {
  [k: string]: unknown;
  enabled?: boolean;
  token?: string;
  chatId?: number | string | null;
  chatName?: string;
  linkCode?: string;
  allowStart?: boolean;
  options?: boolean;
  project?: string;
  hook?: { url?: string; secret?: string; held?: boolean; seen?: number[] };
  unhooking?: string[];
}

/** Where a task started here answers: its first message, and the ack once it's out. */
export interface TgThread {
  [k: string]: unknown;
  channel: string;
  chat: number | string;
  message: number;
  ack: number | null;
  session?: string;
}
