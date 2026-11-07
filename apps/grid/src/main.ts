// wisp Grid on its own: `node apps/grid/src/main.ts grid serve` (or `… serve`). The published
// wisp-agents CLI reaches the same gridCli through `wisp grid …`.

import { gridCli } from './cli.ts';

const argv = process.argv.slice(2);
const args = argv[0] === 'grid' ? argv.slice(1) : argv;
gridCli(args).then(
  (code) => {
    if (code) process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`wisp grid: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
