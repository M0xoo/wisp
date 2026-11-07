// Seats, the waitlist and what people with a seat want next (more, bigger and GPU machines).
//
// maxUsers caps the accounts: a number, or "auto", which starts at auth.seats.min and opens one
// more seat at a time (every everyHours at most, up to cap) while the seats are taken and the
// host stayed below target of what it can run: nothing had to wait for room, and the most
// boxes up at once was under target × capacity (hostd.ts). It never takes seats away.

import type { GridConfig } from './config.ts';
import type { Db } from './db.ts';
import { bad } from './errors.ts';
import type { CountRow, WaitlistRow } from './rows.ts';

const HOUR = 3_600_000;
export const DAY = 86_400_000;
const WINDOW_MS = 7 * DAY; // how far back auto seats look at the load
// What people with a seat can ask for next, in the order the account page shows them.
export const MACHINE_WANTS: readonly string[] = ['more', 'bigger', 'gpu'];
const EMAIL = /^[^@\s<>"']{1,64}@[^@\s<>"']+\.[^@\s<>"']{2,}$/;

export type Audit = (userId: string | null, action: string, meta?: Record<string, unknown>) => void;

export interface SeatsView {
  open: boolean;
  invite: boolean;
  max: number | null;
  left: number | null;
  auto?: true;
}
export interface MachineWish {
  wants: string[];
  note: string;
  since: number;
}
export interface WaitResult {
  joined: boolean;
  invited: boolean;
  position: number;
}

export function createSeats({ db, cfg, audit }: { db: Db; cfg: GridConfig; audit: Audit }) {
  const now = (): number => Date.now();
  const auto = cfg.auth.maxUsers === 'auto';
  const sc = cfg.auth.seats;
  const meta = (k: string): string | undefined => db.get<{ v: string }>('SELECT v FROM meta WHERE k = ?', k)?.v;
  const setMeta = (k: string, v: unknown): void => void db.run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v));
  const count = (sql: string, ...a: (string | number)[]): number => db.get<CountRow>(sql, ...a)?.n ?? 0;
  const users = (): number => count('SELECT COUNT(*) AS n FROM users');
  const holdSince = (): number => now() - sc.holdDays * DAY;
  // Seats kept for invited people from the waitlist who haven't signed up yet.
  const held = (): number => count('SELECT COUNT(*) AS n FROM waitlist WHERE invited_at > ? AND joined_at IS NULL', holdSince());
  const maxSeats = (): number | null => {
    if (auto) return Math.min(sc.cap, Math.max(sc.min, Number(meta('seats.max') || 0)));
    return typeof cfg.auth.maxUsers === 'number' ? cfg.auth.maxUsers : null;
  };

  // Room for new people: whether sign-ups are open, invite-only (an allow list), and how many of
  // the seats are left (null with no cap). The sign-in page and trywisp.dev (GET /api/seats) use it.
  function seats(): SeatsView {
    const a = cfg.auth.allow || {};
    const max = maxSeats();
    const left = max ? Math.max(0, max - users() - held()) : null;
    return { open: cfg.auth.signup !== 'closed', invite: Object.values(a).some((v) => Array.isArray(v) && v.length > 0), max, left, ...(auto && { auto: true as const }) };
  }

  // One more seat, if the last while says the host has room for more people.
  function grow(): boolean {
    const max = maxSeats();
    if (!auto || max === null || max >= sc.cap || users() + held() < max) return false;
    const since = Math.max(Number(meta('seats.grewAt') || 0), now() - WINDOW_MS);
    const w = db.get<{ first: number | null; peak: number; capacity: number; waits: number }>('SELECT MIN(at) AS first, MAX(running) AS peak, MIN(capacity) AS capacity, SUM(waits) AS waits FROM load_samples WHERE at >= ?', since);
    // A whole everyHours of watching at this size first (the grid may have restarted meanwhile).
    if (!w?.first || now() - w.first < sc.everyHours * HOUR * 0.9) return false;
    if (w.waits > 0 || w.peak > sc.target * w.capacity) return false;
    setMeta('seats.max', max + 1);
    setMeta('seats.grewAt', now());
    audit(null, 'seats.grow', { max: max + 1, peak: w.peak, capacity: w.capacity });
    return true;
  }

  // Free seats go to the waitlist, oldest first: held for them for holdDays.
  function invite(): number {
    const max = maxSeats();
    if (!max) return 0;
    const free = max - users() - held();
    if (free <= 0) return 0;
    const next = db.all<{ email: string }>('SELECT email FROM waitlist WHERE invited_at IS NULL AND joined_at IS NULL ORDER BY created_at, email LIMIT ?', free);
    for (const r of next) db.run('UPDATE waitlist SET invited_at = ? WHERE email = ?', now(), r.email);
    if (next.length) audit(null, 'waitlist.invite', { n: next.length });
    return next.length;
  }

  // How busy the host was since the last sample (hostd.takePeak, hostd.capacity); every few minutes.
  function sample({ running, capacity, waits = 0 }: { running: number; capacity: number; waits?: number }): boolean {
    db.run('INSERT OR REPLACE INTO load_samples (at, running, capacity, waits) VALUES (?, ?, ?, ?)', now(), running, capacity, waits);
    db.run('DELETE FROM load_samples WHERE at < ?', now() - WINDOW_MS - DAY);
    const grew = grow();
    invite();
    return grew;
  }

  // On the waitlist (again: once is enough). position: how many are waiting up to them.
  function waitFor(raw: unknown, source = 'site'): WaitResult {
    const email = String(raw || '').trim().toLowerCase();
    if (email.length > 254 || !EMAIL.test(email)) throw bad('An email address, please.');
    db.run('INSERT OR IGNORE INTO waitlist (email, source, created_at) VALUES (?, ?, ?)', email, source, now());
    invite();
    const me = db.get<WaitlistRow>('SELECT * FROM waitlist WHERE email = ?', email);
    if (!me) throw bad('An email address, please.');
    const position = count('SELECT COUNT(*) AS n FROM waitlist WHERE joined_at IS NULL AND invited_at IS NULL AND (created_at < ? OR (created_at = ? AND email <= ?))', me.created_at, me.created_at, email);
    return { joined: !!me.joined_at, invited: !!me.invited_at && !me.joined_at, position: me.invited_at || me.joined_at ? 0 : position };
  }

  const waitlist = (): WaitlistRow[] => db.all<WaitlistRow>('SELECT email, source, created_at, invited_at, joined_at FROM waitlist ORDER BY created_at, email');

  /** A seat held for this (verified) email: someone the waitlist invited. */
  const invited = (email: string): boolean => !!email && !!db.get('SELECT 1 FROM waitlist WHERE email = ? AND invited_at > ? AND joined_at IS NULL', email, holdSince());

  // On the list for what's next: wants is some of MACHINE_WANTS, note a line about what for. No
  // wants: off the list.
  function wishMachines(userId: string, wants: unknown = [], rawNote: unknown = ''): MachineWish | null {
    const list = Array.isArray(wants) ? wants : String(wants).split(',');
    const w = [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
    const odd = w.find((x) => !MACHINE_WANTS.includes(x));
    if (odd) throw bad(`"${odd}" isn’t something to wait for: ${MACHINE_WANTS.join(', ')}.`);
    if (!w.length) {
      db.run('DELETE FROM machine_wishes WHERE user_id = ?', userId);
      audit(userId, 'machines.unwish');
      return null;
    }
    const note = String(rawNote || '').trim().slice(0, 500);
    db.run('INSERT INTO machine_wishes (user_id, wants, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET wants = excluded.wants, note = excluded.note, updated_at = excluded.updated_at', userId, w.join(','), note || null, now(), now());
    audit(userId, 'machines.wish', { wants: w });
    return machineWish(userId);
  }

  function machineWish(userId: string): MachineWish | null {
    const r = db.get<{ wants: string; note: string | null; created_at: number }>('SELECT wants, note, created_at FROM machine_wishes WHERE user_id = ?', userId);
    return r ? { wants: r.wants.split(','), note: r.note || '', since: r.created_at } : null;
  }

  const machineWishes = () => db.all<{ handle: string; email: string | null; wants: string; note: string | null; created_at: number }>('SELECT u.handle, u.email, m.wants, m.note, m.created_at FROM machine_wishes m JOIN users u ON u.id = m.user_id ORDER BY m.created_at');

  return { seats, sample, waitFor, waitlist, invite, invited, wishMachines, machineWish, machineWishes };
}

export type SeatsApi = ReturnType<typeof createSeats>;
