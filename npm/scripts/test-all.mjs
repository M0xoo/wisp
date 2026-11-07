// Node 22+ reads `node --test npm/test/` as a glob, matches no file, and runs the folder as a module;
// npm/test/package.json points that module here so the documented command runs every test file.
// It lives outside test/ so the runner's own discovery never picks it up a second time.

import { readdirSync } from 'node:fs';

const dir = new URL('../test/', import.meta.url);
for (const f of readdirSync(dir).filter((n) => n.endsWith('.test.mjs')).sort()) await import(new URL(f, dir).href);
