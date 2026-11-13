// rust-typed-commands (ADR-0003: a plugin talks to another through its api package): a plugin crate that
// calls another plugin's command by its string id with hand-built JSON (`ctx.run_json(call, "runtime.create",
// json!(…))`, `self.cmd("runtime.get", …)`) when that plugin's -api crate defines the command as a typed
// `Command` gets a finding naming the type to call instead. A call that must stay by name (a peer's command over its
// HTTP edge, an id only known at run time) says why in a `// by-name: <why>` comment on its line or the line above.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { finding } from '../core/report.ts';
import { crates, isTestFile, rustFiles } from '../core/rust.ts';
import type { Finding, Rule } from '../core/types.ts';
import { commandTypes } from './rust-mcp.ts';

/** A call with a dotted string literal among its first four arguments, after plain ones: `f("a.b"`,
 *  `x.f(call, "a.b"`, `f(&c.clone(), "a.b"`, `route(ctx, call, &machine, "a.b"`. */
const CALL = /\b\w+\s*\(\s*(?:&?[\w.]+(?:\(\))?\s*,\s*){0,3}"([a-z][\w-]*(?:\.[\w-]+)+)"/g;

/** `// by-name: <why>` (a reason given) on the call's line or the line above it. */
const BY_NAME = /\/\/\s*by-name:\s*\S/;

/** The text with `//` comments and the `#[cfg(test)]` module blanked, newlines kept (so offsets map to lines). */
function code(text: string): string {
  const at = text.search(/^\s*#\[cfg\(test\)\]/m);
  const body = at < 0 ? text : text.slice(0, at);
  return body.replace(/(^|[^:"])\/\/.*$/gm, (m, p: string) => p + ' '.repeat(m.length - p.length));
}

export const rustTypedCommands: Rule = {
  id: 'rust-typed-commands',
  description: "a plugin calls another plugin's typed command through its -api type, not by string id with hand-built JSON (ADR-0003)",
  run(ctx) {
    const all = crates(ctx.root);
    // id → (owner plugin, `crate::Type`)
    const typed = new Map<string, { plugin: string; name: string }>();
    for (const c of all.filter((x) => x.plugin && x.role === 'api')) {
      const crate = c.name.replaceAll('-', '_');
      for (const f of rustFiles(ctx.root, `${c.dir}/src`)) {
        for (const [t, id] of commandTypes(readFileSync(join(ctx.root, f), 'utf8'))) typed.set(id, { plugin: c.plugin ?? '', name: `${crate}::${t}` });
      }
    }
    const out: Finding[] = [];
    for (const c of all.filter((x) => x.plugin && x.role !== 'api')) {
      for (const f of rustFiles(ctx.root, `${c.dir}/src`).filter((x) => !isTestFile(x))) {
        const raw = readFileSync(join(ctx.root, f), 'utf8');
        const lines = raw.split('\n');
        const text = code(raw);
        for (const m of text.matchAll(CALL)) {
          const id = m[1] ?? '';
          const t = typed.get(id);
          if (!t || t.plugin === c.plugin) continue;
          const line = text.slice(0, (m.index ?? 0) + m[0].length).split('\n').length;
          if (BY_NAME.test(lines[line - 1] ?? '') || BY_NAME.test(lines[line - 2] ?? '')) continue;
          out.push(finding(f, line, 'rust-typed-commands', `"${id}" is called by name with hand-built JSON: call the typed ${t.name} (wisp-${t.plugin}-api), or say why it can't be in a \`// by-name: <why>\` comment`, 'error'));
        }
      }
    }
    return out;
  },
};
