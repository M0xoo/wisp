// `npm run build` in packages/tokens: renders tokens/*.json into dist/tokens.css and
// src/generated.ts. Both are committed; test/fresh.test.ts fails when they fall behind the JSON.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, type TokenFiles } from './render.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CSS_OUT = join(ROOT, 'dist', 'tokens.css');
export const TS_OUT = join(ROOT, 'src', 'generated.ts');

export function readTokenFiles(root: string = ROOT): TokenFiles {
  const read = (name: string): unknown => JSON.parse(readFileSync(join(root, 'tokens', `${name}.json`), 'utf8'));
  return {
    color: read('color'),
    tone: read('tone'),
    space: read('space'),
    radius: read('radius'),
    font: read('font'),
    shadow: read('shadow'),
    size: read('size'),
    motion: read('motion'),
    z: read('z'),
    breakpoint: read('breakpoint'),
  };
}

export function build(): void {
  const { css, ts } = render(readTokenFiles());
  mkdirSync(dirname(CSS_OUT), { recursive: true });
  writeFileSync(CSS_OUT, css);
  writeFileSync(TS_OUT, ts);
}

// Run as a script (`node src/build.ts`); imported by the freshness test, it does nothing.
if (process.argv[1] === fileURLToPath(import.meta.url)) build();
