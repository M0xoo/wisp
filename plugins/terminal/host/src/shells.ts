// The shell beside a task (v1 routes/workspace.js + app.shells): the user's login shell, in the
// task's folder. Where that folder is belongs to whoever knows (wisp.worktrees, through the
// `terminal.folder` point); without one, the session's own cwd.

import { access } from 'node:fs/promises';
import type { Session } from '@wisp-plugin/runtime-api';
import type { FolderSource, TaskFolder } from '@wisp-plugin/terminal-api';
import { type Env, shellArgv } from './env.ts';
import type { Terms } from './terms.ts';

const exists = (p: string): Promise<boolean> => (p ? access(p).then(() => true, () => false) : Promise.resolve(false));

export class Shells {
  readonly terms: Terms;
  readonly #sources: () => readonly FolderSource[];
  readonly #env: Env;
  readonly #home: string;

  constructor(terms: Terms, sources: () => readonly FolderSource[], env: Env, home: string) {
    this.terms = terms;
    this.#sources = sources;
    this.#env = env;
    this.#home = home;
  }

  argv(): string[] {
    return shellArgv(this.#env);
  }

  /** The worktree, else the project folder; a gone worktree (merged with its branch) says so. */
  async folder(s: Session): Promise<TaskFolder> {
    for (const src of this.#sources()) {
      const f = await src.folder(s).catch(() => null);
      if (f) return f;
    }
    if (await exists(s.cwd)) return { dir: s.cwd, root: s.cwd, gone: false };
    return { dir: this.#home, root: s.cwd, gone: true };
  }

  async start(s: Session, o: { cols?: unknown; rows?: unknown; restart?: boolean }): Promise<TaskFolder> {
    if (o.restart) this.terms.close(s.id);
    const f = await this.folder(s);
    this.terms.open(s.id, { argv: this.argv(), cwd: f.dir, cols: o.cols, rows: o.rows });
    return f;
  }

  stop(id: string): boolean {
    return this.terms.close(id);
  }
}
