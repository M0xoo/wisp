// Turns a shell command into a short English sentence for the live ticker, e.g.
// `sed -n 15,50p src/a.js` → "Reading lines 15–50 of src/a.js". Best effort: a command we don't
// know falls back to "Running <command>", and the raw command stays in the activity detail.
// Pure (v1 server/adapters/commands.js, output for output).

import path from 'node:path';
import { clip, lower } from '../text.ts';
import { listed, operands, result, short, type Ctx, type Desc, type Describer, type Paths } from './argv.ts';
import { FILE_COMMANDS } from './files.ts';
import { parseStage, segments, stripHeredocs, type Stage } from './shell.ts';
import { SYSTEM_COMMANDS } from './system.ts';
import { describeTool, TOOL_COMMANDS } from './tools.ts';

export function describeCommand(command: unknown, paths: Paths): string {
  const raw = String(command ?? '').trim();
  const fallback = `Running ${clip(raw, 60)}`;
  if (!raw) return fallback;
  let parts: Desc[];
  try {
    parts = segments(stripHeredocs(raw))
      .map((pipe) => describePipeline(pipe, paths))
      .filter((d): d is Desc => d !== null);
  } catch {
    return fallback;
  }
  // Separators like `echo ---` or `cd x` only count when nothing better was found.
  const strong = parts.filter((p) => !p.weak);
  const texts = [...new Set((strong.length ? strong : parts).map((p) => p.text))];
  if (!texts.length || (!strong.length && texts.length > 1) || (texts.length === 1 && parts.every((p) => p.unknown))) return fallback;
  const [first, second] = texts;
  if (!second) return clip(first, 90);
  const more = texts.length > 2 ? ` (+${texts.length - 2} more)` : '';
  return clip(`${first}, then ${lower(second)}${more}`, 90);
}

const COMMANDS = new Map<string, Describer>();
for (const [names, describe] of [...SYSTEM_COMMANDS, ...FILE_COMMANDS, ...TOOL_COMMANDS]) {
  for (const name of names) {
    if (COMMANDS.has(name)) throw new Error(`commands: ${name} is described twice`);
    COMMANDS.set(name, describe);
  }
}

// A pipeline is described by its first stage that says something (`git log | head` → git log).
function describePipeline(stages: string[][], paths: Paths): Desc | null {
  let best: Desc | null = null;
  for (const words of stages) {
    const stage = parseStage(words);
    if (!stage.argv.length) continue;
    const d = describeStage(stage, paths, stages.length > 1);
    if (d && !d.weak && !d.unknown) return d;
    best ??= d;
  }
  return best;
}

function describeStage({ argv, out, input }: Stage, paths: Paths, piped: boolean): Desc | null {
  const [cmd0, ...args] = argv;
  // Only `while`/`until` with nothing after them get here empty. v1 threw on it, which made the whole
  // line fall back to the raw command; describeCommand's catch keeps that.
  if (cmd0 === undefined) throw new Error('commands: empty stage');
  const cmd = path.basename(cmd0);
  const f = (p: string | null | undefined): string => short(p, paths);
  if (out && /^(echo|printf|cat|tee)$/.test(cmd)) return result(`Writing ${f(out)}`);
  const describe = COMMANDS.get(cmd);
  if (!describe) return describeTool(argv, paths, false);
  const files = operands(args);
  const ctx: Ctx = {
    cmd,
    argv,
    args,
    out,
    input,
    paths,
    piped,
    f,
    files,
    target: listed(files, f),
    stage: (words) => describeStage(parseStage(words), paths, piped),
    script: (script) => describeInner(script, paths),
  };
  return describe(ctx);
}

// `bash -c '<script>'`: the script's own description, marked unknown when that is the raw fallback.
function describeInner(script: string | undefined, paths: Paths): Desc {
  const label = describeCommand(script, paths);
  return label === `Running ${clip(String(script ?? '').trim(), 60)}` ? { text: label, unknown: true } : result(label);
}
