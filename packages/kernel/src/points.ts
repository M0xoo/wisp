// List points (plan §6.1): a typed, versioned list owned by a plugin. Others contribute into it from
// their manifest (live before any code runs) or from setup; the owner reads the list. A contribution
// may name the version it was written for (`runtime.harness@1`), and a mismatch is refused.
import type { Disposable } from './contract.ts';
import { fail } from './errors.ts';

export interface PointDecl {
  id: string;
  version: number;
  kind: 'list' | 'interceptor' | 'subscriber';
}

interface Point {
  owner: string;
  decl: PointDecl;
  items: { by: string; item: unknown; seq: number }[];
}

/** 'runtime.harness@1' → {id, version}. */
export function pointRef(ref: string): { id: string; version: number | undefined } {
  const m = /^(.*)@(\d+)$/.exec(ref);
  return m ? { id: m[1] ?? ref, version: Number(m[2]) } : { id: ref, version: undefined };
}

export class Points {
  readonly #points = new Map<string, Point>();
  // contributions that arrived before their point's owner was declared: kept, applied when it is
  readonly #waiting: { by: string; id: string; version: number | undefined; item: unknown; seq: number }[] = [];
  #seq = 0;

  declare(owner: string, decls: readonly PointDecl[]): Disposable {
    for (const d of decls) {
      const had = this.#points.get(d.id);
      if (had && had.owner !== owner) throw fail('conflict', `the point ${d.id} is already declared by ${had.owner}`);
    }
    for (const d of decls) {
      const items = this.#waiting.filter((w) => w.id === d.id && (w.version === undefined || w.version === d.version));
      for (const w of items) this.#waiting.splice(this.#waiting.indexOf(w), 1);
      this.#points.set(d.id, { owner, decl: d, items: items.map(({ by, item, seq }) => ({ by, item, seq })).sort((a, b) => a.seq - b.seq) });
    }
    return {
      dispose: () => {
        for (const d of decls) {
          const p = this.#points.get(d.id);
          if (p?.owner !== owner) continue;
          this.#points.delete(d.id);
          for (const it of p.items) this.#waiting.push({ by: it.by, id: d.id, version: undefined, item: it.item, seq: it.seq });
        }
      },
    };
  }

  /** Contribute `item` into `ref`. With `wait`, an unknown point keeps it until its owner declares it. */
  contribute(by: string, ref: string, item: unknown, wait = false): Disposable {
    const { id, version } = pointRef(ref);
    const p = this.#points.get(id);
    const seq = this.#seq++;
    if (!p) {
      if (!wait) throw fail('not_found', `no plugin declares the point ${id}`);
      const w = { by, id, version, item, seq };
      this.#waiting.push(w);
      return { dispose: () => this.#drop(by, id, item) };
    }
    if (p.decl.kind !== 'list') throw fail('invalid', `${id} is an ${p.decl.kind} point, not a list`);
    if (version !== undefined && version !== p.decl.version) throw fail('invalid', `${by} contributes to ${id}@${version}, but ${p.owner} declares version ${p.decl.version}`);
    p.items.push({ by, item, seq });
    return { dispose: () => this.#drop(by, id, item) };
  }

  #drop(by: string, id: string, item: unknown): void {
    const p = this.#points.get(id);
    if (p) {
      const i = p.items.findIndex((x) => x.by === by && x.item === item);
      if (i >= 0) p.items.splice(i, 1);
    }
    const w = this.#waiting.findIndex((x) => x.by === by && x.id === id && x.item === item);
    if (w >= 0) this.#waiting.splice(w, 1);
  }

  owner(id: string): string | undefined {
    return this.#points.get(id)?.owner;
  }
  decl(id: string): PointDecl | undefined {
    return this.#points.get(id)?.decl;
  }

  /** Items with who contributed each, in contribution order. */
  entries(id: string): { by: string; item: unknown }[] {
    const p = this.#points.get(pointRef(id).id);
    if (!p) throw fail('not_found', `no plugin declares the point ${id}`);
    return p.items.map(({ by, item }) => ({ by, item }));
  }

  /** contributions alive from `by` (the leak check reads it) */
  countBy(by: string): number {
    let n = this.#waiting.filter((w) => w.by === by).length;
    for (const p of this.#points.values()) n += p.items.filter((x) => x.by === by).length;
    return n;
  }
}
