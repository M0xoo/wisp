// SSE framing (WHATWG "server-sent events"). One wisp frame is one SSE event: `id:` is the cursor
// the client may resume from, `data:` is the frame's messages as one line of JSON (JSON.stringify
// escapes every CR and LF, so a message can never break the framing).

import type { EntityOp, ServerMessage } from '@wisp/protocol';

export const EVENT = 'sync';

/**
 * `opJson` may hold an op's JSON made once for every connection (the server's cache): a change sent
 * to 4 clients is stringified once, as v1's broadcast was. The output is the same either way.
 */
export function encodeFrame(seq: number | null, messages: readonly ServerMessage[], opJson?: ReadonlyMap<EntityOp, string> | WeakMap<EntityOp, string>): string {
  const id = seq === null ? '' : `id: ${seq}\n`;
  const data = opJson === undefined ? JSON.stringify(messages) : `[${messages.map((m) => (m.t === 'patch' ? patchJson(m, opJson) : JSON.stringify(m))).join(',')}]`;
  return `${id}event: ${EVENT}\ndata: ${data}\n\n`;
}

function patchJson(m: Extract<ServerMessage, { t: 'patch' }>, cache: ReadonlyMap<EntityOp, string> | WeakMap<EntityOp, string>): string {
  return `{"t":"patch","seq":${JSON.stringify(m.seq)},"ops":[${m.ops.map((o) => cache.get(o) ?? JSON.stringify(o)).join(',')}]}`;
}

/** A comment line: proxies and the tunnel see traffic, EventSource ignores it. */
export function heartbeat(): string {
  return ': hb\n\n';
}

/** `retry:` tells a browser's EventSource how long to wait before it reconnects by itself. */
export function retryField(ms: number): string {
  return `retry: ${Math.max(0, Math.floor(ms))}\n\n`;
}

export interface SseEvent {
  /** the last `id:` seen on the stream so far (it persists across events, per the spec) */
  id: string | undefined;
  event: string;
  data: string;
}

/**
 * Decodes an SSE byte stream into events. Chunks may split anywhere: inside a line, between CR and
 * LF, inside a UTF-8 sequence. LF, CR and CRLF all end a line. A leading BOM is skipped.
 */
export class SseParser {
  #decoder = new TextDecoder('utf-8');
  #line = '';
  #pendingCR = false;
  #started = false;
  #event = '';
  #data: string[] = [];
  #id: string | undefined;
  #retry: number | undefined;

  get lastEventId(): string | undefined {
    return this.#id;
  }

  /** the last `retry:` the server sent, in ms */
  get retry(): number | undefined {
    return this.#retry;
  }

  push(chunk: string | Uint8Array): SseEvent[] {
    let text = typeof chunk === 'string' ? chunk : this.#decoder.decode(chunk, { stream: true });
    if (!this.#started && text.length > 0) {
      this.#started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    const out: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      if (c === 10 && this.#pendingCR && i === start && this.#line === '') {
        // the LF of a CRLF whose CR ended the previous chunk
        this.#pendingCR = false;
        start = i + 1;
        continue;
      }
      this.#pendingCR = false;
      this.#onLine(this.#line + text.slice(start, i), out);
      this.#line = '';
      if (c === 13) {
        if (i + 1 < text.length) {
          if (text.charCodeAt(i + 1) === 10) i++;
        } else this.#pendingCR = true;
      }
      start = i + 1;
    }
    if (start < text.length) {
      this.#pendingCR = false;
      this.#line += text.slice(start);
    }
    return out;
  }

  #onLine(line: string, out: SseEvent[]): void {
    if (line === '') return this.#dispatch(out);
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.#data.push(value);
    else if (field === 'event') this.#event = value;
    else if (field === 'id' && !value.includes('\0')) this.#id = value;
    else if (field === 'retry' && /^\d+$/.test(value)) this.#retry = Number(value);
  }

  #dispatch(out: SseEvent[]): void {
    if (this.#data.length > 0) out.push({ id: this.#id, event: this.#event || 'message', data: this.#data.join('\n') });
    this.#data = [];
    this.#event = '';
  }
}

/** A decoded wisp frame: its cursor and messages. Null when the event isn't a wisp frame. */
export function decodeFrame(ev: SseEvent): { id: number | null; messages: ServerMessage[] } | null {
  if (ev.event !== EVENT) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(ev.data);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const messages = parsed.filter((m): m is ServerMessage => typeof m === 'object' && m !== null && typeof (m as { t?: unknown }).t === 'string');
  const n = ev.id === undefined || ev.id === '' ? NaN : Number(ev.id);
  return { id: Number.isSafeInteger(n) ? n : null, messages };
}
