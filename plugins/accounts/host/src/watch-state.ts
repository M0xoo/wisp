// Harness watch's state (v1 server/harness-watch.js HarnessWatch, which kept harnesses.json): one row
// per harness in `accounts_watch`, its pin and its open change, written through the store so the
// change feed tells Settings. observe() pins a harness the first time, and records a change when
// what runs is not the pinned program.

import { stat } from 'node:fs/promises';
import type { EntityDef, Migration, Row, Store } from '@wisp/store';
import { TOPIC } from '@wisp-plugin/accounts-api';
import { classify, type Change, type Fingerprints, type Pin, shown } from './watch-pin.ts';
import { isObj } from './shape.ts';

/** its own migration owner: the module migrates on its own, next to the accounts core's tables */
export const WATCH_OWNER = 'wisp.accounts.watch';

export const WATCH_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `CREATE TABLE accounts_watch (
      id TEXT PRIMARY KEY,
      pin TEXT,
      open TEXT
    ) STRICT;`,
  },
];

export interface WatchRow extends Row {
  id: string;
  pin: unknown;
  open: unknown;
}

export function watchEntity(store: Store): EntityDef<WatchRow> {
  store.migrate(WATCH_OWNER, WATCH_MIGRATIONS);
  return store.defineEntity<WatchRow>({
    kind: 'accounts.watch',
    table: 'accounts_watch',
    key: 'id',
    columns: { id: 'text', pin: 'text', open: 'text' },
    json: ['pin', 'open'],
    topics: () => [TOPIC],
  });
}

const isPin = (v: unknown): v is Pin => isObj(v) && typeof v['real'] === 'string' && typeof v['sha256'] === 'string';
const isChange = (v: unknown): v is Change => isObj(v) && (v['kind'] === 'update' || v['kind'] === 'warn') && isObj(v['from']) && isObj(v['to']) && typeof v['to']['sha256'] === 'string';

export class HarnessWatch {
  readonly #store: Store;
  readonly #entity: EntityDef<WatchRow>;
  readonly #now: () => number;
  readonly #prints: Fingerprints;
  readonly #pins = new Map<string, Pin>();
  readonly #open = new Map<string, Change>();
  /** id → the observe() in flight, so two runs at once hash once */
  readonly #busy = new Map<string, Promise<Change | null>>();

  constructor(o: { store: Store; entity: EntityDef<WatchRow>; now: () => number; prints: Fingerprints }) {
    this.#store = o.store;
    this.#entity = o.entity;
    this.#now = o.now;
    this.#prints = o.prints;
    for (const r of o.store.query(o.entity, { select: ['id', 'pin', 'open'] })) {
      if (isPin(r.pin)) this.#pins.set(r.id, r.pin);
      if (isChange(r.open)) this.#open.set(r.id, r.open);
    }
  }

  get prints(): Fingerprints {
    return this.#prints;
  }

  #save(id: string): void {
    this.#store.tx((w) => w.upsert(this.#entity, { id, pin: this.#pins.get(id) ?? null, open: this.#open.get(id) ?? null }));
  }

  /**
   * Without hashing: true when `bin` may not be the pinned program (it moved, or its size or mtime
   * differ). Holds a run before it starts; observe() then says what it really is.
   */
  async suspect(id: string, bin: string): Promise<boolean> {
    const pin = this.#pins.get(id);
    if (!pin) return false;
    if (this.#open.has(id)) return true;
    const at = await this.#prints.resolve(bin);
    if (!at) return false;
    try {
      const st = await stat(at.real);
      return at.real !== pin.real || st.size !== pin.size || st.mtimeMs !== pin.mtimeMs;
    } catch {
      return false;
    }
  }

  /** Looks at `bin` for harness `id` now. Resolves the open change, or null. */
  observe(id: string, bin: string, version = ''): Promise<Change | null> {
    const busy = this.#busy.get(id);
    if (busy) return busy;
    const p = this.#observe(id, bin, version).finally(() => this.#busy.delete(id));
    this.#busy.set(id, p);
    return p;
  }

  async #observe(id: string, bin: string, version: string): Promise<Change | null> {
    const fp = await this.#prints.of(bin);
    if (!fp) return this.#open.get(id) ?? null;
    const now = { ...shown({ ...fp, version }), mtimeMs: fp.mtimeMs };
    const pin = this.#pins.get(id);
    if (!pin) {
      this.#pins.set(id, { ...now, at: this.#now() });
      this.#save(id);
      return null;
    }
    if (pin.sha256 === now.sha256 && pin.real === now.real) {
      // the same program (touched, or a version we didn't know yet): keep the pin current
      if (pin.mtimeMs !== now.mtimeMs || (now.version && pin.version !== now.version) || this.#open.has(id)) {
        this.#pins.set(id, { ...pin, mtimeMs: now.mtimeMs, ...(now.version && { version: now.version }) });
        this.#open.delete(id);
        this.#save(id);
      }
      return null;
    }
    const open = this.#open.get(id);
    if (open && open.to.sha256 === now.sha256 && open.to.real === now.real) return open;
    // a change on top of an untrusted change still compares with what you last trusted
    const c: Change = { kind: classify(pin, now), from: { ...shown(pin), at: pin.at }, to: now, at: this.#now() };
    this.#open.set(id, c);
    this.#save(id);
    return c;
  }

  change(id: string): Change | null {
    return this.#open.get(id) ?? null;
  }

  /** Trust this version: what's there now becomes the pin. false when nothing changed. */
  trust(id: string): boolean {
    const c = this.#open.get(id);
    if (!c) return false;
    this.#pins.set(id, { ...c.to, at: this.#now() });
    this.#open.delete(id);
    this.#save(id);
    return true;
  }

  /** For the harness list: its pin date and open change (v1 `app.harnessWatch.view(id)`). */
  view(id: string): { pinnedAt?: number; changed?: Change } {
    const pin = this.#pins.get(id);
    const c = this.#open.get(id);
    return { ...(pin && { pinnedAt: pin.at }), ...(c && { changed: c }) };
  }
}
