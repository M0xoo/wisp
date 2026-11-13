// Add project's names (Projects.tsx): where a found repo is and the name a new project gets. Plain, so their
// tests needn't compile the pane.

/** Where a found repo is, as v1 showed it: its folder's parent, your home as `~` (`/Users/me/code/web` → `~/code`). */
export function whereIs(path: string): string {
  const parent = path.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';
  return parent.replace(/^\/(?:Users|home)\/[^/]+/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~');
}

/** A project's name from its folder or URL: its last part, without `.git`, as a resource name. */
export function nameFor(source: string, taken: readonly string[]): string {
  const last = source.trim().replace(/\/+$/, '').split(/[/:]/).pop() ?? '';
  const base =
    last
      .replace(/\.git$/, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project';
  let name = base;
  for (let i = 2; taken.includes(name); i++) name = `${base}-${i}`;
  return name;
}
