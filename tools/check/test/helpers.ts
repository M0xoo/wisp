// Fixture trees: one text file per scenario under fixtures/, each file of the tree introduced by a
// `=== path` line. They are text, not .ts, so tsc and the checker's own run never read the bad code.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import { createCtx } from '../core/ctx.ts';
import { formatFinding } from '../core/report.ts';
import type { Rule } from '../core/types.ts';

const ROOT_PACKAGE = JSON.stringify({ name: 'fixture', private: true, type: 'module', workspaces: ['packages/*', 'plugins/*/api', 'plugins/*/host', 'plugins/*/ui', 'apps/*'] });
const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

export function parseTree(text: string): Map<string, string> {
  const files = new Map<string, string>();
  let path: string | undefined;
  let body: string[] = [];
  const end = (): void => {
    if (path) files.set(path, `${body.join('\n').replace(/\n+$/, '')}\n`);
  };
  for (const line of text.split('\n')) {
    const m = /^=== (\S+)\s*$/.exec(line);
    if (m?.[1]) {
      end();
      path = m[1];
      body = [];
    } else if (path) body.push(line);
  }
  end();
  return files;
}

/** Writes a tree into a fresh temp dir (removed after the test file) and returns its path. */
export function writeTree(files: ReadonlyMap<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'wisp-check-'));
  made.push(root);
  if (!files.has('package.json')) writeFileSync(join(root, 'package.json'), ROOT_PACKAGE);
  for (const [path, body] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

export function fixture(name: string): string {
  return writeTree(parseTree(readFileSync(join(import.meta.dirname, 'fixtures', `${name}.tree`), 'utf8')));
}

/** `file:line rule` of each finding (messages change; locations and rules are the contract). */
export async function run(rule: Rule, root: string): Promise<string[]> {
  const found = await rule.run(createCtx(root));
  return found.map((f) => `${f.file}:${f.line} ${f.severity === 'warn' ? `warn:${f.rule}` : f.rule}`).sort();
}

export async function messages(rule: Rule, root: string): Promise<string[]> {
  return (await rule.run(createCtx(root))).map(formatFinding).sort();
}

/** A package.json for a fixture package. */
export function pkg(name: string, deps: readonly string[] = [], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name, type: 'module', exports: { '.': './src/index.ts' }, dependencies: Object.fromEntries(deps.map((d) => [d, '*'])), ...extra });
}
