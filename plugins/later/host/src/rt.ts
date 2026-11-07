// The runtime commands wisp.later sends, typed once. `Runner` is a plugin context (a timer, a
// listener) or the call a command runs in (same trace, the caller's capability set).
import { COMMANDS } from '@wisp-plugin/runtime-api';
import type { CardArgs, FollowUpArgs, Session, SessionState, StartArgs, Turn } from '@wisp-plugin/runtime-api';
import type { Json } from '@wisp/kernel';

export interface Runner {
  run<R = unknown>(cmd: string, args?: unknown): Promise<R>;
}

const codeOf = (e: unknown): string | undefined => (typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : undefined);

export class Rt {
  readonly #r: Runner;
  constructor(r: Runner) {
    this.#r = r;
  }

  /** the task, or undefined when it's gone */
  async get(id: string): Promise<Session | undefined> {
    try {
      return await this.#r.run<Session>(COMMANDS.get, { id });
    } catch (e) {
      if (codeOf(e) === 'not_found') return undefined;
      throw e;
    }
  }
  async last(id: string): Promise<Turn | undefined> {
    return (await this.#r.run<Turn[]>(COMMANDS.turns, { id })).at(-1);
  }
  async turn(id: string, turnId: string): Promise<Turn | undefined> {
    const list = await this.#r.run<Turn[]>(COMMANDS.turns, { id });
    return list.find((t) => t.id === turnId) ?? list.at(-1);
  }
  setExt(id: string, value: Json): Promise<unknown> {
    return this.#r.run(COMMANDS.setExt, { id, plugin: 'wisp.later', value });
  }
  /** the turn's own record of the follow-up it carries; optional (an older runtime may lack it) */
  async turnExt(id: string, turnId: string, value: Json): Promise<void> {
    await this.#r.run(COMMANDS.turnExt, { id, turnId, plugin: 'wisp.later', value }).catch(() => undefined);
  }
  followUp(a: FollowUpArgs): Promise<{ turnId?: string; queued?: string | boolean; held?: boolean }> {
    return this.#r.run(COMMANDS.followUp, a);
  }
  create(a: StartArgs): Promise<{ id: string }> {
    return this.#r.run(COMMANDS.create, a);
  }
  card(a: CardArgs): Promise<{ id: string }> {
    return this.#r.run(COMMANDS.card, a);
  }
  setState(id: string, state: SessionState): Promise<unknown> {
    return this.#r.run(COMMANDS.setState, { id, state });
  }
  markRead(id: string, unread: boolean): Promise<unknown> {
    return this.#r.run(COMMANDS.markRead, { id, unread });
  }
  unarchive(id: string): Promise<unknown> {
    return this.#r.run(COMMANDS.archive, { id, archived: false });
  }
  delete(id: string): Promise<unknown> {
    return this.#r.run(COMMANDS.delete, { id });
  }
}
