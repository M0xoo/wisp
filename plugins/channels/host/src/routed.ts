// A message wisp Grid sent here through the tunnel (`on laptop`, grid/route.js): the grid verified who
// it's from and picked this computer, and this computer decides whether to take it. Only with Accept
// tasks from channels on (`channels.acceptChannels`, which only this computer can switch on), and it
// goes no further than here: this computer's own projects, no other machine, no crew (so no
// delegates, whose mode is their own). Plan unless asked, Edits at most.
//
// The computer never holds the bot. All it keeps of the chat is the thread the grid gave it
// (remote.routed), and its report goes back through the grid under that.

import type { Json } from '@wisp/kernel';
import type { ChannelCtx, ChannelHub, Mode, Msg, SessionView, Thread, TransportDef } from '@wisp-plugin/channels-api';
import { Channel, RateLimit, Seen, capMode, defuse, gate, parseMessage, refusal, resend, scrubOut, truncate } from '@wisp-plugin/channels-api/kit';

const CAP: Mode = 'edits';
const FALLBACK: Mode = 'plan';
const OFF = 'That computer doesn’t accept tasks from channels. Turn on Settings → Notifications → Accept tasks from channels on it.';
const clean = (t: string): string => truncate(defuse(scrubOut(t).text), 4000);
// A report that couldn't get out is the task's result and there may be nothing after it to carry it,
// so it goes on its own. A grid restart takes seconds to minutes.
export const LATER_MS = [15_000, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
const LATE_MAX = 20; // per thread, newest dropped
// The grid heard it and said no. Busy (429) isn't no.
const refused = (err: unknown): boolean => {
  const st = Number((err as { status?: number })?.status);
  return st >= 400 && st < 500 && st !== 429;
};

export interface RoutedIn {
  channel?: string;
  name?: string;
  text: string;
  sender?: string;
  id: string;
  at?: number;
  thread: string;
  follow?: boolean;
}

type Said = (reply: string, status?: number) => { status: number; body: Json };

export class Routed extends Channel {
  readonly kind = 'thread' as const;
  readonly seen = new Seen();
  limit = new RateLimit();
  readonly late = new Map<string, string[]>(); // thread → reports waiting for the grid, oldest first
  readonly #accepting: () => boolean;

  constructor(hub: ChannelHub, accepting: () => boolean) {
    super(hub, 'routed');
    this.#accepting = accepting;
  }

  // Sending needs a grid to send through. The switch is for what comes in: a task already running
  // still says how it went.
  override get ready(): boolean {
    return !!this.hub.phone.onGrid();
  }

  get accepting(): boolean {
    return this.#accepting();
  }

  reports(s: SessionView | null): boolean {
    return !!s?.remote?.routed;
  }

  override async publish(msg: Msg, s: SessionView | null): Promise<void> {
    const ref = s?.remote?.routed;
    if (!s || !ref) return;
    const wait = this.waiting(s);
    if (wait === '') return;
    const text = clean(wait ?? `${msg.title}\n\n${msg.text}`);
    const behind = this.late.get(ref);
    if (behind) {
      if (behind.length < LATE_MAX) behind.push(text); // in order, behind what's waiting
      return;
    }
    await this.#post(ref, text).catch((err: unknown) => {
      if (refused(err)) throw err;
      this.late.set(ref, [text]);
      this.#retry(ref);
    });
  }

  // The grid says a broken connection with a 502, where resend looks for fetch's TypeError.
  #post(ref: string, text: string): Promise<unknown> {
    return resend(() =>
      this.hub.phone.gridReply(ref, text).catch((err: unknown) => {
        throw (err as { status?: number })?.status === 502 ? new TypeError(err instanceof Error ? err.message : String(err)) : err;
      }),
    );
  }

  #retry(ref: string, tries = 0): void {
    const go = async (): Promise<void> => {
      const waiting = this.late.get(ref) ?? [];
      try {
        while (waiting.length) {
          await this.#post(ref, waiting[0] ?? '');
          waiting.shift();
        }
        this.late.delete(ref);
      } catch (err) {
        if (!refused(err) && tries + 1 < LATER_MS.length) return this.#retry(ref, tries + 1);
        this.late.delete(ref);
        this.hub.log.warn(`wisp: routed: a report didn’t get out: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    const ms = this.hub.tune['routedRetryMs'];
    this.hub.timeout(typeof ms === 'number' ? ms : (LATER_MS[tries] ?? 0), () => void go());
  }

  threadStarted(s: SessionView | null, thread: Thread, by: { name: string } | null): void {
    if (!s) return;
    thread.session = s.id;
    this.hub.markStarted(s.id, this.name, by?.name);
    if (s.id.includes('@')) return; // only a task here keeps a row
    this.hub.setRemote(s.id, { ...this.hub.remoteOf(s.id), routed: String(thread.ref ?? '') });
  }

  // Only what's here: a message mustn't hop from this computer to one it can reach.
  async #here(): Promise<ChannelCtx> {
    const ctx = await this.hub.phone.context();
    const projects = ctx.projects.filter((p) => !p.machine);
    return { ...ctx, projects, machines: [], crew: [], crewView: [], sandbox: false, defaultProject: ctx.defaultProject?.machine ? projects[0] || null : ctx.defaultProject };
  }

  /** What the grid forwarded → { status, body: { reply?, off? } }. reply is what the grid says in the chat. */
  async take({ channel = 'routed', name = 'a chat', text, sender = '', id, at, thread, follow }: RoutedIn): Promise<{ status: number; body: Json }> {
    const { phone } = this.hub;
    const said: Said = (reply, status = 200) => ({ status, body: { reply: clean(reply) } });
    if (!this.accepting) {
      phone.count('refused', 'routed-off');
      return { status: 403, body: { off: true, reply: OFF } };
    }
    const g = gate({ sender: 'grid', senders: ['grid'], id, at, seen: this.seen, limit: this.limit, rateKey: String(sender) });
    if (!g.ok) {
      phone.count('refused', g.why);
      return g.reply ? said(g.reply, g.why === 'stale' ? 409 : 429) : { status: 200, body: {} };
    }
    const ctx = await this.#here();
    if (follow) return this.#follow(thread, text, ctx, { name, sender, said });
    const p = parseMessage(text, ctx);
    if (p.command && p.command !== 'new') return said('Only a task goes to a computer. Say that without “on”, to your cloud wisp.', 400);
    if (p.problems.length) return said(refusal(p.problems), 400);
    if (!p.prompt) return said('What should it do? Say it after the computer’s name.', 400);
    const asked = capMode(p.mode, CAP, FALLBACK);
    if (asked.refused) {
      phone.count('refused', 'mode');
      return said(`${asked.refused}\n\nNothing started.`, 403);
    }
    if (p.machine || (p.project || ctx.defaultProject)?.machine) return said('Only this computer can take this.', 403);
    if (!p.project && !ctx.defaultProject) return said('No projects on that computer yet. Open a folder in wisp there first.', 400);
    const started: Thread = { channel: this.name, ref: thread, ack: null };
    try {
      const out = await phone.startParsed(p, { channel, name, sender, cap: CAP, fallback: FALLBACK, thread: started, ctx });
      return said(out.ack);
    } catch (err) {
      return said(`Couldn’t start it: ${truncate(err instanceof Error ? err.message : String(err), 300)}`, 500);
    }
  }

  async #follow(thread: string, text: string, ctx: ChannelCtx, { name, sender, said }: { name: string; sender: string; said: Said }): Promise<{ status: number; body: Json }> {
    const { phone } = this.hub;
    const id = this.hub.findRemote((r) => r.routed === thread)[0];
    if (!id) return said('That task isn’t on this computer any more.', 404);
    const p = parseMessage(text, { ...ctx, thread: await phone.threadCtx(id) });
    if (p.command === 'stop') return said(await phone.stop(id));
    if (p.command === 'status') return said(await phone.status(id));
    if (p.command === 'done') return said(await this.hub.act({ sessionId: id, kind: 'done', ref: '', index: 0 }));
    if (p.command && p.command !== 'btw') return said('Only a task goes to a computer. Say that without replying, to your cloud wisp.', 400);
    if (p.problems.length) return said(refusal(p.problems), 400);
    if (!p.prompt) return said('What should it do? Say it in your reply.', 400);
    const line = await phone.run(id, p, { name, sender, cap: CAP, approvals: false, btw: p.command === 'btw' }).catch((err: unknown) => `Couldn’t send that: ${truncate(err instanceof Error ? err.message : String(err), 300)}`);
    return said(line);
  }
}

export const routedDef = (accepting: () => boolean): TransportDef => ({ name: 'routed', create: (hub) => new Routed(hub, accepting) });
