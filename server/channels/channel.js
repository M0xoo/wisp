// A channel: one way to reach wisp from outside. The hub (server/remote.js) owns the config, the
// public API and the fan-out; a channel owns its wire. To add one, extend this and give it:
//   ready        configured well enough to send
//   start(signal)  listen until the signal aborts (a poll loop, a socket)
//   publish(msg, s)  send { title, text, actions } about session s (or nothing in particular)
// Inbound goes through policy.js's gate() and grammar.js's parseMessage(), then the hub's phone
// (services/phone.js) does the work.

import { Seen, approvalsHere, needsWisp, waitingLine } from './policy.js';

const AWAY_MAX = 200;
export const KIND = { a: 'answer', r: 'reply', d: 'done' };
export const CODE = { answer: 'a', reply: 'r', done: 'd' };
export const sleep = (ms, signal) => new Promise((r) => (signal?.aborted ? r() : (setTimeout(r, ms).unref?.(), signal?.addEventListener('abort', r, { once: true }))));

export class Channel {
  constructor(hub, name) {
    this.hub = hub;
    this.name = name;
    this.asksSaid = new Seen();
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

  // Health for Settings: the latest result, merged over the last one.
  mark(st) {
    this.hub.status[this.name] = { ...this.hub.status[this.name], ...st, at: Date.now() };
    this.hub.onChange();
  }
}
