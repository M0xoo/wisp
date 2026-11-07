// Check Codex while work waits (Settings → Usage, defaults.liveLimits, off by default): while work
// on a Codex account waits for its plan (Automations stop at, Ask near the limit, Wait for the
// reset), wisp asks Codex's app-server how that account's windows stand, every 10 minutes. The
// read is what Codex's own status line does: no model turn, nothing spent. When a window has reset
// early (OpenAI's banked resets), Budget.record sees it and the waiting work goes (onReset).
// Claude Code has no such read: its windows come only with a run, as before. wisp never redeems a
// reset credit (account/rateLimitResetCredit/consume): that's the user's to spend.
//
// One read before held-back work (before()): with an Automations stop line set for Codex, work
// nobody started by hand reads the account first when its last reading is over 15 minutes old. It
// needs no switch: it's a single read, only when you've set a stop line and work is about to start,
// and it spends nothing. Without it a line meant to protect your chats would judge by old numbers:
// once chats and Codex share one allowance, they move the windows between runs. A failed read
// changes nothing: the work goes on what wisp knew, as it did before.
//
// Banked resets: the same answer says how many reset credits the account has and, when Codex lists
// them, when each expires (codexBanked). Plan budget shows it; the phone hears once per credit, the
// day before it expires (noteBanked, each tick, on whatever the last read said). Only ever read.

import { spawn, killTree } from './proc.js';
import { codexBanked, codexLive, stopFor } from './budget.js';

const EVERY_MS = 10 * 60_000;
const STALE_MS = 15 * 60_000;
const TICK_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const TIMEOUT_MS = 15_000;

// What a read gives Budget.record: the windows and the banked resets.
const fromRead = (res, now) => {
  const limits = codexLive(res, { now });
  const banked = codexBanked(res, { now });
  return limits ? { ...limits, ...(banked && { banked }) } : banked ? { windows: [], banked } : null;
};

// The phone note for a banked reset that expires within a day: "tomorrow at 17:00".
export function bankedNote({ credit, count, name = 'Codex', label = '', now = Date.now() }) {
  const at = new Date(credit.expiresAt);
  const day = at.toDateString() === new Date(now).toDateString() ? 'today' : 'tomorrow';
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const who = `${name}${label ? ` (${label})` : ''}`;
  const more = count > 1 ? ` You have ${count} banked resets; this is the first to go.` : '';
  return { title: `⏳ A banked ${who} reset expires ${day} ${time}`, text: `${who} has a banked reset that expires ${day} at ${time}.${more} wisp never spends one: redeem it in Codex if you want it.`, actions: [] };
}

// One account/rateLimits/read over `codex app-server`'s stdio (JSON lines), then the process goes.
// env: the account's (CODEX_HOME). → the result, or throws.
export function readCodex({ bin = process.env.WISP_CODEX_BIN || 'codex', env = {}, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['app-server'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let buf = '';
    let done = false;
    const end = (err, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killTree(child);
      err ? reject(err) : resolve(v);
    };
    const timer = setTimeout(() => end(new Error('codex app-server didn’t answer')), timeout);
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    child.on('error', (err) => end(err));
    child.stdin.on('error', (err) => end(err)); // it went mid-handshake: EPIPE here would take wisp down
    child.on('exit', () => end(new Error('codex app-server stopped')));
    child.stdout.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0; ) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          if (m.error) return end(new Error(m.error.message || 'initialize failed'));
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else if (m.id === 2) {
          if (m.error) return end(new Error(m.error.message || 'account/rateLimits/read failed'));
          end(null, m.result);
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'wisp', version: '1' } } });
  });
}

// app: { store, budget, accounts }. waiting(agent, account): work waits on that account's plan.
// read(env): the read (tests pass a fake: no network there).
// notify(note): the phone (app.remote.send when it's set up), or null when it isn't: the note waits.
export function createLiveLimits({ store, budget, accounts, waiting, read = (env) => readCodex({ env }), now = () => Date.now(), notify = () => null, label = () => '' }) {
  const due = new Map(); // account → { at, backoff }
  const reading = new Map(); // account → before()'s read in flight
  // One go at it, whatever came of it: a read that fails is not tried again at every gate.
  const readOnce = async (id) => {
    try {
      const limits = fromRead(await live.read(accounts.envFor('codex', id)), now());
      if (!limits) throw new Error('no usage in its answer');
      budget.record('codex', id, { ...limits, read: true });
    } catch (err) {
      console.warn(`wisp: codex usage: ${err.message}`);
    }
  };
  const live = {
    read,
    tried: new Map(), // account → when a read last began (before() and tick())
    // Just before work that a stop line could hold back. Resolves when the reading is as fresh as
    // it'll get; never rejects, and never blocks the run. check() stays synchronous and reads nothing.
    before(agent, account) {
      if (agent !== 'codex' || !stopFor(store.config.defaults, 'codex')) return;
      const id = account || 'default';
      const at = budget.state.codex?.[id]?.at;
      if (at && now() - at < STALE_MS) return;
      if (reading.has(id)) return reading.get(id);
      const last = live.tried.get(id);
      if (last !== undefined && now() - last < STALE_MS) return;
      live.tried.set(id, now());
      // In a .finally, not in readOnce: that one can end before there's a promise to forget.
      const p = readOnce(id).finally(() => reading.delete(id));
      reading.set(id, p);
      return p;
    },
    // The day before a banked reset expires, one note per credit. Marked sent only once it went: a
    // phone set up later still hears of it in time. Works on stored readings: it reads nothing.
    noteBanked() {
      let n = 0;
      for (const { account, credit, count } of budget.bankedDue?.('codex') || []) {
        const sent = notify(bankedNote({ credit, count, label: label(account), now: now() }));
        if (!sent) continue;
        budget.bankedSent('codex', account, credit);
        Promise.resolve(sent).catch((err) => console.warn(`wisp: phone: ${err.message}`));
        n++;
      }
      return n;
    },
    // One pass: each Codex account with work waiting on it, when its next read is due.
    async tick() {
      live.noteBanked();
      if (store.config.defaults.liveLimits !== 'on') return 0;
      let n = 0;
      for (const id of accounts.supports('codex') ? accounts.list('codex').map((a) => a.id) : ['default']) {
        const d = due.get(id);
        if ((d && d.at > now()) || !waiting('codex', id)) continue;
        live.tried.set(id, now());
        try {
          const limits = fromRead(await live.read(accounts.envFor('codex', id)), now());
          if (limits) budget.record('codex', id, { ...limits, read: true });
          due.set(id, { at: now() + EVERY_MS, backoff: 0 });
          n++;
        } catch (err) {
          // Signed out, an old CLI without the method, offline: try less often, up to hourly.
          const backoff = Math.min(MAX_BACKOFF_MS, (d?.backoff || EVERY_MS / 2) * 2);
          due.set(id, { at: now() + backoff, backoff });
          console.warn(`wisp: codex usage: ${err.message}`);
        }
      }
      return n;
    },
    start() {
      live.stop();
      live.timer = setInterval(() => live.tick().catch(() => {}), TICK_MS);
      live.timer.unref?.();
    },
    stop() {
      clearInterval(live.timer);
    },
  };
  return live;
}
