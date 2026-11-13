// The channels' default project row (v1 phone.js Telegram "Default project"): Last used first, naming the
// project the newest task ran in, then every project. The hub resolves it the same way
// (plugins/channels/core/src/default_project.rs): the picked one, else the last used, else the first.

import { projectOf, type ProjectView } from '@wisp/shell';
import type { SelectOption } from '@wisp/ui';

/** The project the newest task (by when it started) ran in, if any task is in one. */
export function lastUsed(projects: readonly ProjectView[], sessions: readonly unknown[]): ProjectView | undefined {
  let at = -1;
  let found: ProjectView | undefined;
  for (const s of sessions) {
    const top = (s ?? {}) as Readonly<Record<string, unknown>>;
    const body = typeof top['body'] === 'object' && top['body'] !== null ? (top['body'] as Readonly<Record<string, unknown>>) : {};
    const r = { ...body, ...top }; // a row's fields at the top or in its body
    const t = r['createdAt'] ?? r['created_at'];
    const when = typeof t === 'number' ? t : -1;
    const p = typeof r['cwd'] === 'string' ? projectOf(r['cwd'], projects) : undefined;
    if (p && when > at) {
      at = when;
      found = p;
    }
  }
  return found;
}

/** The picker's options: '' is Last used (with its name when there is one), then the projects. */
export function projectItems(projects: readonly ProjectView[], last: ProjectView | undefined, say: (name?: string) => string): SelectOption[] {
  return [{ value: '', label: say(last?.name) }, ...projects.map((p) => ({ value: p.id, label: p.name }))];
}
