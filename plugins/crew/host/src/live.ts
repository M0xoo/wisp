// Which of a member's jobs are running right now, kept from the runtime's events and the crew's own
// starts, so "is there room?" (busy) is a set's size: a tick over every member reads no sessions
// (ADR-0011: no full-list work per tick or per event).

export class LiveIndex {
  readonly #running = new Map<string, Set<string>>();
  /** session → member, for events that carry only the session id */
  readonly #owner = new Map<string, string>();
  /** jobs being launched (not sessions yet) */
  readonly #starting = new Map<string, number>();
  /** running check-ins, so "already checking in" is a lookup too */
  readonly #checkins = new Set<string>();

  running(memberId: string, sessionId: string, o: { checkin?: boolean } = {}): void {
    let set = this.#running.get(memberId);
    if (!set) this.#running.set(memberId, (set = new Set()));
    set.add(sessionId);
    this.#owner.set(sessionId, memberId);
    if (o.checkin) this.#checkins.add(sessionId);
  }

  /** The session stopped running (its turn ended, it was deleted). Returns its member, if one. */
  stopped(sessionId: string): string | undefined {
    const m = this.#owner.get(sessionId);
    if (m === undefined) return undefined;
    this.#running.get(m)?.delete(sessionId);
    this.#owner.delete(sessionId);
    this.#checkins.delete(sessionId);
    return m;
  }

  memberOf(sessionId: string): string | undefined {
    return this.#owner.get(sessionId);
  }

  starting(memberId: string, by: 1 | -1): void {
    const n = (this.#starting.get(memberId) ?? 0) + by;
    if (n > 0) this.#starting.set(memberId, n);
    else this.#starting.delete(memberId);
  }

  /** Jobs running plus jobs being launched. */
  busy(memberId: string): number {
    return (this.#running.get(memberId)?.size ?? 0) + (this.#starting.get(memberId) ?? 0);
  }

  checkingIn(memberId: string): boolean {
    for (const s of this.#running.get(memberId) ?? []) if (this.#checkins.has(s)) return true;
    return false;
  }

  forget(memberId: string): void {
    for (const s of this.#running.get(memberId) ?? []) {
      this.#owner.delete(s);
      this.#checkins.delete(s);
    }
    this.#running.delete(memberId);
    this.#starting.delete(memberId);
  }
}
