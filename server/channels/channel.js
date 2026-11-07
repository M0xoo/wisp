// A channel: one way to reach wisp from outside. The hub (server/remote.js) owns the config, the
// public API and the fan-out; a channel owns its wire. To add one, extend this and give it:
//   ready        configured well enough to send
//   start(signal)  listen until the signal aborts (a poll loop, a socket)
//   publish(msg, s)  send { title, text, actions } about session s (or nothing in particular)
//   inbound(raw, headers)  a message the grid held for this cloud wisp (routes/channels.js): verify
//                it and handle it → { status, body }. A 4xx is final, and only a 2xx means it was for wisp and handled.
//   dropped(n)   the grid lost n of this channel's messages (a full grid, an hour asleep)
//   rotate()     replace this cloud wisp's inbound URL, and point the channel at the new one
// Inbound goes through policy.js's gate() and grammar.js's parseMessage(), then the hub's phone
// (services/phone.js) does the work.

import { Seen, approvalsHere, needsWisp, waitingLine } from './policy.js';

const AWAY_MAX = 200;
export const KIND = { a: 'answer', r: 'reply', d: 'done' };
export const CODE = { answer: 'a', reply: 'r', done: 'd' };
const SEND_TRIES = 3;
export const sleep = (ms, signal) => new Promise((r) => (signal?.aborted ? r() : (setTimeout(r, ms).unref?.(), signal?.addEventListener('abort', r, { once: true }))));

// A post whose connection broke: fetch rejects with a TypeError and no answer, where a kept-alive
// socket died under it or none could be had. Nothing says it wasn't heard, so it can show twice; that
// beats a question or a first reply that never comes. A refusal, a timeout and an abort aren't this.
export async function resend(send, tries = SEND_TRIES) {
  for (let left = tries; ; left--) {
    try {
      return await send();
    } catch (err) {
      if (err?.name !== 'TypeError') throw err;
      if (left <= 1) throw new Error(`${err.message}${err.cause?.code ? ` (${err.cause.code})` : ''}`); // fetch's own words hide why
    }
  }
}

export class Channel {
  constructor(hub, name) {
    this.hub = hub;
    this.name = name;
    this.asksSaid = new Seen();
    this.owed = new Map(); // thread -> sends the first reply that didn't get out
  }

  get ready() {
    return false;
  }

  get approvalsHere() {
    return approvalsHere(this.name);
  }

  // A publish about an ask that only wisp can answer: the line to post instead of the report, or
  // '' when this ask has been said here. null: no such ask. A restart ends every ask (runner), so
  // memory is enough to say each once.
  waiting(s, opts) {
    if (this.approvalsHere || !needsWisp(s?.ask)) return null;
    return this.asksSaid.first(s.ask.id) ? waitingLine(s.ask, opts) : '';
  }

  start() {}

  async publish() {}

  // A task on another machine has no s.remote here: its thread (fields) is kept in config, as hub.away
  // is memory and the task outlives a restart. Read back in the hub's constructor.
  keepAway(id, by, fields) {
    const hub = this.hub;
    const entry = { ...(by && { by }), ...fields, at: Date.now() };
    Object.assign(hub.away.get(id) || {}, entry);
    const cfg = (hub.cfg[this.name] ||= {});
    cfg.away = Object.fromEntries(Object.entries({ ...cfg.away, [id]: entry }).slice(-AWAY_MAX));
    hub.store.saveConfig();
  }

  // Keeps the first reply when it couldn't be sent: the task is running, so it's still true.
  owe(key, send) {
    return (err) => {
      this.owed.set(key, send);
      throw err;
    };
  }

  // It goes ahead of the next thing said in that thread, or stays for the one after.
  async pay(key) {
    const send = this.owed.get(key);
    if (!send) return;
    this.owed.delete(key);
    await send().catch(() => this.owed.set(key, send));
  }

  async inbound() {
    return { status: 404, body: { error: 'This channel has no inbound here.' } };
  }

  async dropped() {}

  async rotate() {
    return { status: 404, body: { error: 'This channel has no URL to rotate.' } };
  }

  // Health for Settings: the latest result, merged over the last one.
  mark(st) {
    this.hub.status[this.name] = { ...this.hub.status[this.name], ...st, at: Date.now() };
    this.hub.onChange();
  }
}
