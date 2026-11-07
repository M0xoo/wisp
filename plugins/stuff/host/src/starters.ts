// The panes wisp ships with (v1 routes/stuff.js starters, followStarters): a folder each under
// ../starters, added to My Stuff once (the same item after that), pinned and allowed by you like any app.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { usesOf } from '@wisp-plugin/stuff-api';
import { followStarter } from './app-save.ts';
import { errorMessage } from './errors.ts';
import type { Shelf } from './shelf.ts';

export const STARTERS = fileURLToPath(new URL('../starters/', import.meta.url));
export const starterKey = (id: string): string => `starter:${id}`;

export interface Starter {
  id: string;
  name: string;
  description: string;
  uses: string[];
}

async function manifestOf(dir: string): Promise<Record<string, unknown>> {
  const m: unknown = JSON.parse(await fs.readFile(path.join(dir, 'wisp-app.json'), 'utf8'));
  return typeof m === 'object' && m !== null ? (m as Record<string, unknown>) : {};
}

export async function starters(dir = STARTERS): Promise<Starter[]> {
  const out: Starter[] = [];
  for (const d of await fs.readdir(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const m = await manifestOf(path.join(dir, d.name));
    out.push({ id: d.name, name: String(m['name'] ?? d.name), description: typeof m['description'] === 'string' ? m['description'] : '', uses: usesOf(m) });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * At start: copies of a starter nobody changed follow the version wisp ships. Its wisp-app.json's "was"
 * lists the folder hashes wisp shipped before (oldest first): each change to a starter appends the
 * hash it had. A starter that can't be read never stops wisp.
 */
export async function followStarters(shelf: Shelf, dir = STARTERS, warn: (msg: string) => void = () => {}): Promise<void> {
  for (const d of await fs.readdir(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try {
      const src = path.join(dir, d.name);
      const was = (await manifestOf(src))['was'];
      const it = Array.isArray(was) ? shelf.findKey(starterKey(d.name)) : undefined;
      if (it && Array.isArray(was)) await followStarter(shelf, it, src, was.filter((x): x is string => typeof x === 'string'));
    } catch (err) {
      warn(`starter ${d.name}: ${errorMessage(err)}`);
    }
  }
}
