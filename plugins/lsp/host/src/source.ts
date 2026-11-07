// A file the editor may ask about (v1 routes/workspace.js sourceFile): inside the task's folder, not
// under .git, and not a link out of it.
import { realpath } from 'node:fs/promises';
import path from 'node:path';

export async function sourceFile(root: string, rel: unknown): Promise<string | null> {
  if (!root || typeof rel !== 'string' || !rel || path.isAbsolute(rel)) return null;
  const file = path.resolve(root, rel);
  const within = (p: string, dir: string): boolean => p.startsWith(dir + path.sep);
  if (!within(file, root) || path.relative(root, file).split(path.sep)[0] === '.git') return null;
  try {
    return within(await realpath(file), await realpath(root)) ? file : null;
  } catch {
    return null; // gone (deleted by the task): nothing to ask about
  }
}
