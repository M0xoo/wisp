// rust-set-ext (lost updates on a task's ext slots): a plugin crate that builds `SetExtArgs { …, expect: None }`
// writes its slot whole, over whatever another writer put there since it last looked. Two CI flakes came from a
// read-then-write like that (wisp.goal's judging round, wisp.history's offer vs save). A read-then-write goes
// through `wisp_runtime_api::ext::update_ext` (a compare-and-set that decides again on conflict); a write that is
// provably whole (one writer, nothing read back) says why in a `// set-ext: whole <why>` comment on the literal's
// first line, the line above it, or any line inside it. Tests and the api crates (the type's home) are exempt.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { finding } from '../core/report.ts';
import { codeLines, crates, isTestFile, rustFiles, testStart } from '../core/rust.ts';
import type { Finding, Rule } from '../core/types.ts';

/** `// set-ext: whole <why>` (a reason given). */
const WHOLE = /\/\/\s*set-ext:\s*whole\s+\S/;
const START = /\bSetExtArgs\s*\{/g;
const NONE = /\bexpect\s*:\s*None\b/;

/** Where the `{` opened at `line`/`col` closes: [line, col] (braces counted on code lines only). */
function closing(lines: readonly string[], line: number, col: number): [number, number] {
  let depth = 0;
  for (let i = line; i < lines.length; i++) {
    const l = lines[i] ?? '';
    for (let j = i === line ? col : 0; j < l.length; j++) {
      if (l[j] === '{') depth++;
      else if (l[j] === '}' && --depth === 0) return [i, j];
    }
  }
  return [lines.length - 1, (lines.at(-1) ?? '').length];
}

/** `..rest` struct update syntax (after `{` or `,`): the fields it fills leave `expect` at None too. */
const UPDATE = /[{,]\s*\.\.(?!=)/;

/** Findings for one file's text: each whole `SetExtArgs` literal with no reason (exported for the rule's test). */
export function wholeWrites(file: string, text: string): Finding[] {
  const raw = text.split('\n');
  const code = codeLines(text);
  const end = testStart(code);
  const out: Finding[] = [];
  for (let i = 0; i < end; i++) {
    for (const m of (code[i] ?? '').matchAll(START)) {
      const col = (m.index ?? 0) + m[0].length - 1;
      const [last, at] = closing(code, i, col);
      const lines = code.slice(i, last + 1);
      const first = lines[0] ?? '';
      const body = last === i ? first.slice(col, at + 1) : [first.slice(col), ...lines.slice(1, -1), (lines.at(-1) ?? '').slice(0, at + 1)].join('\n');
      if (!NONE.test(body) && !UPDATE.test(body)) continue;
      // the line above counts only when it holds nothing but the comment (not another literal's trailing reason)
      const above = i > 0 && (code[i - 1] ?? '').trim() === '' ? [raw[i - 1] ?? ''] : [];
      if ([...above, ...raw.slice(i, last + 1)].some((l) => WHOLE.test(l))) continue;
      out.push(
        finding(
          file,
          i + 1,
          'rust-set-ext',
          'SetExtArgs with `expect: None` (or `..rest`) writes the slot whole over any write since: read-then-write through wisp_runtime_api::ext::update_ext (compare-and-set), or say why it is whole in a `// set-ext: whole <why>` comment',
          'error',
        ),
      );
    }
  }
  return out;
}

export const rustSetExt: Rule = {
  id: 'rust-set-ext',
  description: 'a plugin writes its ext slot with expect: None only when it says why the write is whole (lost updates)',
  run(ctx) {
    const out: Finding[] = [];
    for (const c of crates(ctx.root).filter((x) => x.plugin && x.role !== 'api')) {
      for (const f of rustFiles(ctx.root, `${c.dir}/src`).filter((x) => !isTestFile(x))) {
        out.push(...wholeWrites(f, readFileSync(join(ctx.root, f), 'utf8')));
      }
    }
    return out;
  },
};
