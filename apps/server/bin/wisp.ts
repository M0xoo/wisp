#!/usr/bin/env node
// wisp: launcher + queue for coding agents (`wisp --help` lists every command; src/cli/ runs them).
//
//   wisp                       open the wisp desktop app (or focus the running one)
//   wisp "fix the tests"       launch a wisp in the current folder
//   wisp ls | show | wait | reply | btw | stop    script sessions
//   wisp mcp                   stdio MCP server, so other agents and editors can use wisp
//   wisp grid <dev|init|serve|…>  run wisp for many people on your own server
//
// This file stays small on purpose: --version and --help answer before anything heavy loads.
import '../src/cli/warnings.ts';
import { HELP, parseArgs, UsageError } from '../src/cli/args.ts';
import { VERSION } from '../src/meta.ts';

function parse(): ReturnType<typeof parseArgs> {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`  ✗ ${e.message}`);
    process.exit(1);
  }
}

const parsed = parse();
if (parsed.action === 'version') console.log(VERSION);
else if (parsed.action === 'help') console.log(HELP);
else await (await import('../src/cli/main.ts')).main(parsed);
