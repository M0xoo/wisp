// Check Codex while work waits (Settings → Usage, defaults.liveLimits, off by default): while work
// on a Codex account waits for its plan (Automations stop at, Ask near the limit, Wait for the
// reset), wisp asks Codex's app-server how that account's windows stand, every 10 minutes. The
// read is what Codex's own status line does: no model turn, nothing spent. When a window has reset
// early (OpenAI's banked resets), Budget.record sees it and the waiting work goes (onReset).
// Claude Code has no such read: its windows come only with a run, as before. wisp never redeems a
// reset credit (account/rateLimitResetCredit/consume): that's the user's to spend.

import { spawn, killTree } from './proc.js';
import { codexLive } from './budget.js';

const EVERY_MS = 10 * 60_000;
const TICK_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const TIMEOUT_MS = 15_000;

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
export function createLiveLimits({ store, budget, accounts, waiting, read = (env) => readCodex({ env }), now = () => Date.now() }) {
  const due = new Map(); // account → { at, backoff }
  const live = {
    read,
    // One pass: each Codex account with work waiting on it, when its next read is due.
    async tick() {
      if (store.config.defaults.liveLimits !== 'on') return 0;
      let n = 0;
      for (const id of accounts.supports('codex') ? accounts.list('codex').map((a) => a.id) : ['default']) {
        const d = due.get(id);
        if ((d && d.at > now()) || !waiting('codex', id)) continue;
        try {
          const limits = codexLive(await live.read(accounts.envFor('codex', id)));
          if (limits) budget.record('codex', id, limits);
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
