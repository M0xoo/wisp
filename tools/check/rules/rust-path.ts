// rust-path (ADR-0057: one PATH for every lookup and child): the desktop app hands its server the login shell's
// PATH after start (`wisp_proc::set_path`); the process environment keeps the inherited one. Code that reads
// `std::env::var("PATH")` / `var_os("PATH")` itself finds programs on, or starts children with, the PATH the user's
// CLIs aren't on. Go through wisp-proc (`which`, `spawn`, `exec`, `search_path()`, `vars()`); a read that wants the
// inherited PATH on purpose (the grid's own servers, a CLI run from a terminal) says why in a
// `// path: inherited <why>` comment on its line or the line above. crates/wisp-proc (the PATH's home) and tests
// are exempt.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { finding } from '../core/report.ts';
import { codeLines, crates, isTestFile, rustFiles } from '../core/rust.ts';
import type { Finding, Rule } from '../core/types.ts';

/** `// path: inherited <why>` (a reason given). */
const INHERITED = /\/\/\s*path:\s*inherited\s+\S/;
/** The read, in the raw line (the string literal is blanked in the code line). */
const READ = /(?:\benv::|(?<![.\w:]))var(?:_os)?\(\s*"PATH"\s*\)/;
/** The same call in the code line, so a mention in a comment doesn't count. `env::var`, or a bare `var` imported
 * from it (`use std::env::var`); a method (`w.var("PATH")`) is someone else's lookup. */
const CALL = /(?:\benv::|(?<![.\w:]))var(?:_os)?\(\s*""\s*\)/;
const HOME = 'crates/wisp-proc/';
/** The file's test module: `#[cfg(test)]`, or `#[cfg(all(test, …))]` (a test for one platform). */
const TESTS = /^\s*#\[cfg\((?:all\(\s*)?test\b/;

/** Findings for one file's text: each PATH read with no reason (exported for the rule's test). */
export function pathReads(file: string, text: string): Finding[] {
  const raw = text.split('\n');
  const code = codeLines(text);
  const at = code.findIndex((l) => TESTS.test(l));
  const end = at < 0 ? code.length : at;
  const out: Finding[] = [];
  for (let i = 0; i < end; i++) {
    const line = raw[i] ?? '';
    if (!READ.test(line) || !CALL.test(code[i] ?? '')) continue;
    // the line above counts only when it holds nothing but the comment
    const above = i > 0 && (code[i - 1] ?? '').trim() === '' ? (raw[i - 1] ?? '') : '';
    if (INHERITED.test(line) || INHERITED.test(above)) continue;
    out.push(
      finding(
        file,
        i + 1,
        'rust-path',
        'reads the inherited PATH itself, not the one the desktop app handed over (ADR-0057): use wisp_proc::search_path() / vars() / the proc service, or say why the inherited PATH is right in a `// path: inherited <why>` comment',
        'error',
      ),
    );
  }
  return out;
}

export const rustPath: Rule = {
  id: 'rust-path',
  description: 'PATH is read through wisp-proc (the handed-over one, ADR-0057) unless a `// path: inherited <why>` says why',
  run(ctx) {
    const out: Finding[] = [];
    for (const c of crates(ctx.root).filter((x) => !`${x.dir}/`.startsWith(HOME))) {
      for (const f of rustFiles(ctx.root, `${c.dir}/src`).filter((x) => !isTestFile(x))) {
        out.push(...pathReads(f, readFileSync(join(ctx.root, f), 'utf8')));
      }
    }
    return out;
  },
};
