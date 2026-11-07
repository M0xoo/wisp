// Runs a parsed `wisp` command line. bin/wisp.ts loads this only after --version and --help are ruled
// out; each branch then loads only what it needs.
import type { Parsed } from './args.ts';
import { makeCtx, type Ctx } from './context.ts';
import type { TryChange } from '../client.ts';
import type { Scripted } from './scripted.ts';

/** --try: the second run's change. What's wrong with it is said here, before anything has to start. */
async function tryChange(ctx: Ctx): Promise<TryChange> {
  const { tryProblem, tryRuns } = await import('../client.ts');
  const problem = tryProblem(ctx.flags);
  if (problem) ctx.die(problem);
  try {
    return tryRuns(ctx.flags.try);
  } catch (e) {
    return ctx.die(e instanceof Error ? e.message : String(e));
  }
}

async function dispatch(ctx: Ctx, { command, words, argv }: Parsed): Promise<void> {
  const { flags } = ctx;
  const tried = flags.try.length && !command ? await tryChange(ctx) : null;
  if (command === 'grid') return (await import('./delegate.ts')).grid(ctx, argv.slice(argv.indexOf('grid') + 1));
  if (command === 'mcp') return (await import('./delegate.ts')).mcp(ctx);
  if (command === 'skill') return (await import('./skill.ts')).skill(ctx, words[1]);
  const { scripted } = await import('./scripted.ts');
  if (command && command !== 'add') return scripted(ctx, command satisfies Scripted, words.slice(1), tried);
  if (!command && words.length && (flags.json || flags.wait || tried)) return scripted(ctx, 'launch', words, tried);
  return (await import('./interactive.ts')).interactive(ctx, words, command === 'add');
}

/** Prints a failure as `  ✗ message` and exits 1, as v1 did for every scripted command. */
export async function main(parsed: Parsed): Promise<void> {
  const ctx = makeCtx(parsed.flags);
  try {
    await dispatch(ctx, parsed);
  } catch (e) {
    console.error(`  ✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
