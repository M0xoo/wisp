// The session's ext['wisp.ship'] slot, read and written through the runtime. Writes for one session
// run one after another: the poll, Ship it and Fix conflicts each read the slot fresh and change only
// what they change, so none of them loses another's update (v1 mutated one object in memory).

import type { Json, PluginContext } from '@wisp/kernel';
import { PLUGIN, type ShipExt, shipOf } from '@wisp-plugin/ship-api';
import { bad, type Sess } from './util.ts';

export class Slots {
  readonly #ctx: PluginContext;
  readonly #chains = new Map<string, Promise<unknown>>();
  /** told after every write: the poll's index of who has an open PR */
  onWrite: (id: string, ext: ShipExt) => void = () => {};

  constructor(ctx: PluginContext) {
    this.#ctx = ctx;
  }

  async session(id: string): Promise<Sess> {
    try {
      return await this.#ctx.run<Sess>('runtime.get', { id });
    } catch (e) {
      const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
      if (code === 'not_found') throw bad('no such session', 404);
      throw e;
    }
  }

  /** The session if it's still there, else null (deleted while a poll or a ship ran). */
  find(id: string): Promise<Sess | null> {
    return this.session(id).catch(() => null);
  }

  async read(id: string): Promise<ShipExt> {
    return structuredClone(shipOf(await this.session(id)));
  }

  /** Change the slot: fn gets a copy to edit (or returns a new one); the result is written. */
  update(id: string, fn: (ext: ShipExt, s: Sess) => ShipExt | void): Promise<ShipExt> {
    const prev = this.#chains.get(id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      const s = await this.session(id);
      const cur = structuredClone(shipOf(s));
      const out = fn(cur, s) ?? cur;
      const clean = Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as ShipExt;
      await this.#ctx.run('runtime.setExt', { id, plugin: PLUGIN, value: Object.keys(clean).length ? (clean as unknown as Json) : null });
      this.onWrite(id, clean);
      return clean;
    });
    this.#chains.set(id, next);
    const clear = (): void => void (this.#chains.get(id) === next && this.#chains.delete(id));
    next.then(clear, clear);
    return next;
  }
}
