// A real hub over fakes, for transport tests (a transport's test can't import wisp.channels' host).
// The phone records what it was asked and answers like v1's phone does in the simple cases; the net
// sends each fetch to an in-process handler, so a test plays Telegram or Slack with no socket open.

import type {
  ActArgs, BoxApi, BoxGrid, ChannelConfig, ChannelCtx, Net, Parsed, Phone, ProjectView, Remote, RunOpts, SessionView, StartOpts, TransportDef,
} from './index.ts';
import { Hub, type HubCrypto } from './kit/hub.ts';

/** A deterministic, non-cryptographic stand-in: tests need stable strings, not secrecy. */
function fnv(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 0x5bd1e995) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(4);
}

const seq = { n: 0 }; // api packages keep no module-level let
export const testCrypto: HubCrypto = {
  hmac: (key, data) => Buffer.from(fnv(`${key}|${data}`), 'hex').toString('base64url'),
  sha256: (s) => fnv(s),
  randomInt: (min, max) => min + ((seq.n++ * 7919) % Math.max(1, max - min)),
  randomHex: (n) => fnv(String(seq.n++)).slice(0, n * 2).padEnd(n * 2, '0'),
};

export type Handler = (req: Request) => Response | Promise<Response>;

/** Every fetch goes to `handler`; `calls` keeps each request's url, method and body text. */
export function fakeNet(handler: Handler): Net & { calls: { url: string; method: string; body: string; headers: Record<string, string> }[] } {
  const calls: { url: string; method: string; body: string; headers: Record<string, string> }[] = [];
  return {
    calls,
    async fetch(url, init = {}) {
      const { timeoutMs: _t, ...rest } = init;
      const req = new Request(url, rest);
      const body = req.body ? await req.clone().text() : '';
      calls.push({ url, method: req.method, body, headers: Object.fromEntries(req.headers) });
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return handler(req);
    },
  };
}

export const json = (o: unknown, status = 200): Response => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

export interface PhoneCall {
  fn: string;
  args: unknown[];
}

/** v1's phone as the tests stub it: records every call; override any method. */
export function fakePhone(over: Partial<Phone> & { ctx?: Partial<ChannelCtx>; sessions?: Record<string, SessionView> } = {}): Phone & { calls: PhoneCall[] } {
  const calls: PhoneCall[] = [];
  const rec = (fn: string, args: unknown[]): void => void calls.push({ fn, args });
  const sessions: Record<string, SessionView> = over.sessions ?? {};
  const projects: ProjectView[] = over.ctx?.projects ?? [{ id: 'p1', name: 'api', path: '/work/api' }];
  const ctx: ChannelCtx = {
    projects,
    machines: [],
    agents: [{ id: 'claude', name: 'Claude Code', available: true, models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }], efforts: ['low', 'high'] }],
    adapters: [{ id: 'claude', name: 'Claude Code' }],
    crew: [],
    goals: ['cheap', 'best'],
    defaultProject: projects[0] ?? null,
    defaultAgent: 'claude',
    sandbox: false,
    tasks: [],
    ...over.ctx,
  };
  const phone: Phone & { calls: PhoneCall[] } = {
    calls,
    context: async () => (rec('context', []), ctx),
    count: (kind, detail) => rec('count', [kind, detail]),
    onGrid: () => false,
    gridReply: async (thread, text) => (rec('gridReply', [thread, text]), {}),
    threadSaved: () => rec('threadSaved', []),
    threadCtx: async (id) => (rec('threadCtx', [id]), { agent: sessions[id]?.agent ?? 'claude', machine: '' }),
    startParsed: async (p: Parsed, o: StartOpts) => {
      rec('startParsed', [p, o]);
      const session: SessionView = { id: `s${calls.length}`, title: p.prompt, state: 'running', agent: 'claude', turns: [] };
      sessions[session.id] = session;
      return { session, ack: `▶ ${p.project?.name ?? ctx.defaultProject?.name ?? ''}\n  ${p.prompt}` };
    },
    stop: async (id) => (rec('stop', [id]), '■ Stopped.'),
    status: async (id) => (rec('status', [id]), `Working: ${sessions[id]?.title ?? id}`),
    run: async (id: string, p: Parsed, o: RunOpts) => (rec('run', [id, p, o]), '✓ Sent'),
    mention: async (id, p, o) => (rec('mention', [id, p, o]), { ack: `▶ ${p.crew?.name ?? ''} has it` }),
    launch: async (o) => {
      rec('launch', [o]);
      const s: SessionView = { id: `l${calls.length}`, title: o.prompt, state: 'running', agent: 'claude', turns: [] };
      sessions[s.id] = s;
      return s;
    },
    act: async (a: ActArgs) => (rec('act', [a]), '✓ Sent'),
    projects: async () => projects,
    session: async (id) => sessions[id] ?? null,
    sessions: async () => Object.values(sessions),
    ...over,
  };
  return phone;
}

/** Not on a grid unless `grid` is given. */
export function fakeBox(o: { grid?: BoxGrid | null; inBox?: boolean; urls?: Record<string, { url?: string; address?: string; dropped?: number; held?: boolean } | null> } = {}): BoxApi & { calls: PhoneCall[] } {
  const calls: PhoneCall[] = [];
  return {
    calls,
    grid: () => o.grid ?? null,
    inBox: () => o.inBox ?? !!o.grid,
    botMark: (t) => fnv(`wisp bot|${t}`).slice(0, 43),
    channelUrl: async (_b, channel, bot, opts) => (calls.push({ fn: 'channelUrl', args: [channel, bot, opts] }), o.urls?.[channel] ?? null),
    rotateUrl: async (_b, channel) => (calls.push({ fn: 'rotateUrl', args: [channel] }), o.urls?.[channel] ?? {}),
    mailReply: async (_b, m) => (calls.push({ fn: 'mailReply', args: [m] }), { messageId: '<m1@grid>' }),
    setChannelKey: async (_b, channel, key, linked) => (calls.push({ fn: 'setChannelKey', args: [channel, key, linked] }), true),
  };
}

export interface TestHub {
  hub: Hub;
  phone: Phone & { calls: PhoneCall[] };
  saved: { cfg: Record<string, ChannelConfig>; events: string[]; secret: string }[];
  remotes: Map<string, Remote>;
  changes: number;
}

/** A real Hub with the given transports over fakes. `cfg` seeds the config as v1's config.remote held it. */
export function makeHub(o: {
  transports: readonly TransportDef[];
  phone?: Phone & { calls: PhoneCall[] };
  net?: Net;
  box?: BoxApi;
  cfg?: Record<string, ChannelConfig>;
  events?: string[];
  remotes?: Record<string, Remote>;
  tune?: Record<string, number | (() => number)>;
  now?: () => number;
}): TestHub {
  const out: TestHub = { hub: undefined as unknown as Hub, phone: o.phone ?? fakePhone(), saved: [], remotes: new Map(), changes: 0 };
  out.hub = new Hub({
    phone: out.phone,
    net: o.net ?? fakeNet(() => json({ ok: true })),
    box: o.box ?? fakeBox(),
    clock: { now: o.now ?? (() => Date.now()) },
    log: { warn: () => {}, info: () => {} },
    crypto: testCrypto,
    transports: o.transports,
    state: { cfg: o.cfg ?? {}, ...(o.events && { events: o.events }), remotes: o.remotes ?? {} },
    persist: (s) => void out.saved.push(structuredClone({ cfg: s.cfg, events: s.events, secret: s.secret })),
    persistRemote: (id, r) => void out.remotes.set(id, r),
    changed: () => void out.changes++,
    timeout: (ms, fn) => void setTimeout(fn, ms).unref?.(),
    tune: { ntfyPollMs: 5, tgLongPoll: 0, ghPollMs: 5, slackBackoffMs: 5, slackPingMs: 1000, discordBackoffMs: 5, discordHelloMs: 1000, discordIdentifyMs: 0, discordInvalidMs: 5, discordJitter: () => 0, ...o.tune },
  });
  return out;
}

/** Polls `fn` until it gives something truthy (a test's wait on a background loop). */
export async function until<T>(fn: () => T | Promise<T>, ms = 3000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
