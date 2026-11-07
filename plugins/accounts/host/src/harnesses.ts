// What this plugin knows about each harness, read generically from the `runtime.harness` point: its
// sign-in (`login`), its login folder (`accounts`) and its key sign-in (`keys`). Nothing here names a
// harness (ADR-0003); gh, which isn't one, is this plugin's own built-in login (gh.ts).

import type { Harness, HarnessAccounts, HarnessKeys, HarnessLogin } from '@wisp-plugin/runtime-api';
import type { ExecResult } from './ports.ts';

/** What a sign-out function may run (proposed for HarnessLogin.logout: `exec` next to home and platform). */
export type LoginExec = (bin: string, args: readonly string[]) => Promise<ExecResult>;

/** A sign-in as this plugin runs it: a harness's HarnessLogin, or gh's. */
export interface LoginSpec extends Omit<HarnessLogin, 'logout' | 'authFailed'> {
  logout: readonly string[] | ((o: { home: string; platform: string; exec: LoginExec }) => Promise<void>);
  authFailed?: RegExp;
  /** after it signs in (gh: git pushes with its login) */
  after?(exec: LoginExec): Promise<void>;
}

/** HarnessAccounts plus the two fields proposed for it (`dirs`, `sync`); both optional here. */
export interface AccountsSpec extends HarnessAccounts {
  dirs?: readonly string[];
  sync?(o: { dir: string; base: string; env: Record<string, string | undefined>; userHome: string }): Promise<void>;
}

// Longer than this and a failed run is quoting the words, not saying them: signed-out errors are one
// or two lines, and agy's, the longest, is about 800 with its sign-in link.
const AUTH_FAILED_MAX = 1200;

const fn = (v: unknown): boolean => typeof v === 'function';

/** The harness list as a lookup. Built per read: the point's list is what's live right now. */
export class HarnessTable {
  readonly #read: () => readonly Harness[];
  readonly #builtins: ReadonlyMap<string, LoginSpec>;

  constructor(read: () => readonly Harness[], builtins: ReadonlyMap<string, LoginSpec>) {
    this.#read = read;
    this.#builtins = builtins;
  }

  all(): readonly Harness[] {
    return this.#read();
  }

  get(id: string): Harness | undefined {
    return this.#read().find((h) => h.id === id);
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  /** a harness's sign-in, or a built-in one (gh) */
  login(id: string): LoginSpec | undefined {
    // A harness's logout takes { home, platform }: the `exec` it is handed besides is one it may ignore.
    const own: LoginSpec | undefined = this.get(id)?.login;
    return own ?? this.#builtins.get(id);
  }

  keys(id: string): HarnessKeys | undefined {
    return this.get(id)?.keys;
  }

  /** the harness's login folder, when it can have several accounts */
  accounts(id: string): AccountsSpec | undefined {
    const a = this.get(id)?.accounts;
    if (!a) return undefined;
    const more = a as AccountsSpec;
    const dirs = Array.isArray(more.dirs) ? more.dirs.filter((d): d is string => typeof d === 'string') : [];
    return { ...a, dirs, ...(fn(more.sync) && more.sync && { sync: more.sync.bind(a) }) };
  }

  label(id: string): string {
    return this.get(id)?.accounts?.label ?? this.get(id)?.name ?? id;
  }

  /** Whether a failed run's text says its harness is signed out, in the CLI's own words (v1 signedOutBy). */
  signedOutBy(id: string, text: unknown): boolean {
    const h = this.get(id);
    const words = h?.login?.authFailed ?? h?.keys?.authFailed;
    const t = String(text ?? '');
    return !!words && t.length <= AUTH_FAILED_MAX && words.test(t);
  }
}
