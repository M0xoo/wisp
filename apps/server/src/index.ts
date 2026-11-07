// wisp-agents: the published package. `startServer` boots wisp with the plugins of a group; the CLI
// (bin/wisp.ts) calls it, and so do tests with smaller groups.
import type { PluginGroup } from '@wisp/kernel';
import { BoxPlugins, DefaultPlugins, loadCatalog } from './groups.ts';
import { startServer as boot, type RunningServer, type ServerOptions as BootOptions } from './server.ts';

export { API_VERSION, DEFAULT_PORT, VERSION } from './meta.ts';
export { BoxPlugins, DefaultPlugins, HeadlessPlugins, MinimalPlugins, GROUPS, loadCatalog } from './groups.ts';
export { sessionToken, connectorToken, speaksFor } from './auth.ts';
export type { RunningServer };

export interface ServerOptions extends BootOptions {
  /** the CLI opens the page itself; accepted so its options pass straight through */
  open?: boolean;
}

/** DefaultPlugins on a computer, BoxPlugins on a grid box (WISP_GRID_URL), unless a group is given. */
export function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const { open: _open, ...rest } = opts;
  if (rest.group) return boot(rest);
  const catalog = loadCatalog();
  for (const [name, why] of catalog.missing) rest.log?.debug(`plugin ${name} not loaded: ${why}`);
  const group: PluginGroup = process.env['WISP_GRID_URL'] ? BoxPlugins(catalog) : DefaultPlugins(catalog);
  const parts = async (): Promise<unknown[]> => Promise.all([...catalog.entries.values()].map((e) => e.load().then((m) => m.openapi, () => undefined)));
  return boot({ ...rest, group, openapiParts: parts });
}
