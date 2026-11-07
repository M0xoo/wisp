// Settings → Diagnostics (plan §6.11.2 rule 2): the last failures per plugin and the traces of refused
// calls, in ring buffers so a noisy plugin can't grow memory.

export interface Failure {
  at: number;
  plugin: string;
  /** 'command', 'interceptor', 'event', 'service', 'setup', 'exec', 'dispose', 'setting' */
  kind: string;
  code: string;
  message: string;
  /** `${plugin}:${hook}` frames, root first */
  stack?: readonly string[];
}

export class Ring<T> {
  readonly #items: T[] = [];
  readonly #size: number;
  constructor(size: number) {
    this.#size = Math.max(1, size);
  }
  push(x: T): void {
    this.#items.push(x);
    if (this.#items.length > this.#size) this.#items.shift();
  }
  list(): T[] {
    return [...this.#items];
  }
}

export class Diagnostics {
  readonly #size: number;
  readonly #byPlugin = new Map<string, Ring<Failure>>();
  readonly #refusals: Ring<Failure>;
  constructor(size = 50) {
    this.#size = size;
    this.#refusals = new Ring(size * 4);
  }
  record(f: Failure): void {
    let r = this.#byPlugin.get(f.plugin);
    if (!r) this.#byPlugin.set(f.plugin, (r = new Ring(this.#size)));
    r.push(f);
  }
  /** a call the kernel refused (permission, depth, re-entry, read-only): kept with its trace */
  refuse(f: Failure): void {
    this.#refusals.push(f);
    this.record(f);
  }
  failures(plugin: string): Failure[] {
    return this.#byPlugin.get(plugin)?.list() ?? [];
  }
  refusals(): Failure[] {
    return this.#refusals.list();
  }
}
