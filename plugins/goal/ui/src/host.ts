// What this UI reads beyond PluginClient: what's open (nav). The shell exposes it to screens through
// useShell().nav; PluginClient doesn't carry it yet, so it is read duck-typed here and falls back to
// Home on a host that lacks it. One place to change once @wisp/shell's useShell() ships.

import { initialNav, type Nav, type PluginClient, type Readable } from '@wisp/client';

const HOME_NAV = initialNav(1440);

export function navOf(c: PluginClient): Readable<Nav> {
  return (c as PluginClient & { nav?: Readable<Nav> }).nav ?? (() => HOME_NAV);
}
