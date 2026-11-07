// `wisp mcp` and `wisp grid …` belong to other parts of wisp: the mcp plugin (@wisp-plugin/mcp) serves
// MCP on stdio, and wisp Grid (apps/grid) has its own CLI. Each loads only when asked, so no other command
// pays for it, and a build without one says so instead of crashing.
import type { Ctx } from './context.ts';

type Fn = (...args: unknown[]) => unknown;
const fn = (v: unknown): Fn | null => (typeof v === 'function' ? (v as Fn) : null);

/** The module, or null when this build has no such module (a missing package, file or export path). */
async function optional(load: () => Promise<unknown>): Promise<Record<string, unknown> | null> {
  try {
    const mod = await load();
    return mod && typeof mod === 'object' ? (mod as Record<string, unknown>) : null;
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return null;
    throw err;
  }
}

export const MCP_MISSING = 'wisp mcp is not in this build: it comes with the mcp plugin (@wisp-plugin/mcp)';
export const GRID_MISSING = 'wisp grid is not in this build: it comes with wisp Grid (apps/grid, @wisp/grid/cli)';

/** stdout belongs to the MCP protocol from here on: nothing else may print to it. */
export async function mcp(ctx: Ctx): Promise<void> {
  const serve = fn((await optional(() => import('@wisp-plugin/mcp')))?.['serveMcp']);
  if (!serve) ctx.die(MCP_MISSING);
  await serve();
}

/** The grid parses its own flags (--data, --domain, …) from the raw arguments after `grid`. */
export async function grid(ctx: Ctx, args: string[]): Promise<void> {
  const run = fn((await optional(() => import('@wisp/grid/cli')))?.['gridCli']);
  if (!run) ctx.die(GRID_MISSING);
  await run(args);
}
