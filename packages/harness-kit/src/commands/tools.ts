// Build tools, package managers and language runtimes: npm, npx, node, python, pip, cargo, go,
// make, docker, brew, and the dev tools they run (tsc, vitest, eslint, vite …).

import path from 'node:path';
import { clip } from '../text.ts';
import { operands, pick, result, short, stripFlags, type Desc, type Paths, type ShowPath, type Table } from './argv.ts';
import { describeGh, describeGit } from './vcs.ts';

// Dev tools that run on their own or through npx / pnpm exec / uv run.
export function describeTool(argv: readonly (string | undefined)[], paths: Paths, viaRunner: boolean): Desc | null {
  const [cmd0, ...rest] = argv;
  if (!cmd0) return null;
  const args = rest.map((a) => a ?? '');
  const cmd = path.basename(cmd0.replace(/@[^/]*$/, '')); // npx tsc@5 → tsc
  const known = knownTool(cmd, args);
  if (known) return known;
  if (/^\.{0,2}\//.test(cmd0) || /\.(sh|js|mjs|cjs|ts|py|rb)$/.test(cmd0)) return result(`Running ${short(cmd0, paths)}`);
  return { text: `Running ${viaRunner ? cmd : clip(argv.join(' '), 50)}`, unknown: !viaRunner };
}

function knownTool(cmd: string, args: readonly string[]): Desc | null {
  if (/^(jest|vitest|mocha|ava|tap|pytest|playwright|cypress|karma|jasmine|uvu)$/.test(cmd)) {
    if (cmd === 'playwright' && args[0] === 'install') return result('Installing browsers for Playwright');
    return result(args.includes('--watch') ? 'Running tests in watch mode' : 'Running tests');
  }
  if (cmd === 'tsc' || cmd === 'vue-tsc') return result(args.includes('--watch') || args.includes('-w') ? 'Type-checking in watch mode' : 'Type-checking');
  if (/^(eslint|biome|oxlint|stylelint|ruff|flake8|pylint|golangci-lint|rubocop|shellcheck|standard|xo)$/.test(cmd)) {
    if ((cmd === 'biome' || cmd === 'ruff') && args[0] === 'format') return result('Formatting code');
    return result(args.includes('--fix') ? 'Fixing lint issues' : 'Linting');
  }
  if (/^(prettier|black|isort|gofmt|rustfmt|dprint|clang-format)$/.test(cmd)) return result(args.includes('--check') || args.includes('-c') ? 'Checking formatting' : 'Formatting code');
  if (/^(vite|next|nuxt|astro|webpack|rollup|esbuild|parcel|tsup|turbo|nx|svelte-kit|remix)$/.test(cmd)) {
    const sub = args.find((a) => !a.startsWith('-'));
    if (!sub || /^(dev|serve|start|preview)$/.test(sub)) return result(cmd === 'esbuild' || cmd === 'rollup' || cmd === 'tsup' ? 'Building the project' : 'Starting the dev server');
    if (/^(lint|test|typecheck)$/.test(sub)) return describeTarget(sub);
    return result('Building the project');
  }
  if (/^(mypy|pyright)$/.test(cmd)) return result('Type-checking');
  if (cmd === 'electron' || cmd === 'electron-builder' || cmd === 'electron-forge') return result(cmd === 'electron' ? 'Starting the Electron app' : 'Packaging the app');
  if (cmd === 'serve' || cmd === 'http-server') return result('Starting a local web server');
  if (cmd === 'prisma' || cmd === 'drizzle-kit') return result(/migrate|push/.test(args.join(' ')) ? 'Migrating the database' : 'Generating the database client');
  if (/^create-/.test(cmd)) return result('Scaffolding a new project');
  return null;
}

// `make test`, `npm run lint`, `just build` …
export function describeTarget(t: string): Desc {
  const n = t.replace(/^(npm|pnpm|yarn|bun):/, '');
  if (/^(test|tests|spec|check:test)(:|$)|^test[-_]/.test(n)) return result(n === 'test' || n === 'tests' ? 'Running tests' : `Running tests (${n})`);
  if (/^(build|compile|bundle|dist|package)(:|$)/.test(n)) return result('Building the project');
  if (/^(lint|eslint)(:|$)/.test(n)) return result(/fix/.test(n) ? 'Fixing lint issues' : 'Linting');
  if (/^(format|fmt|prettier)(:|$)/.test(n)) return result('Formatting code');
  if (/^(typecheck|type-check|types|tsc|check-types)(:|$)/.test(n)) return result('Type-checking');
  if (/^(dev|start|serve|watch|preview)(:|$)/.test(n)) return result(n === 'start' ? 'Starting the app' : 'Starting the dev server');
  if (/^(clean)(:|$)/.test(n)) return result('Cleaning build output');
  if (/^(install|deps|setup|bootstrap)(:|$)/.test(n)) return result('Setting up the project');
  if (/^(release|publish|deploy)(:|$)/.test(n)) return result(n.startsWith('deploy') ? 'Deploying' : 'Publishing a release');
  if (/^(bench|benchmark)(:|$)/.test(n)) return result('Running benchmarks');
  if (/^(e2e|integration)(:|$)/.test(n)) return result('Running end-to-end tests');
  if (/^(docs?)(:|$)/.test(n)) return result('Building the docs');
  return result(`Running the ${n} script`);
}

const PM_FIXED: Record<string, string> = {
  start: 'Starting the app',
  publish: 'Publishing the package',
  pack: 'Packing the package',
  outdated: 'Checking for outdated dependencies',
  audit: 'Auditing dependencies',
  ls: 'Inspecting dependencies',
  list: 'Inspecting dependencies',
  why: 'Inspecting dependencies',
  explain: 'Inspecting dependencies',
  init: 'Scaffolding a new project',
  create: 'Scaffolding a new project',
  link: 'Linking a local package',
  config: 'Checking npm settings',
};

// npm, pnpm, yarn and bun.
function describePackageManager(pm: string, args: readonly string[], paths: Paths): Desc | null {
  const [sub, ...more] = stripFlags(args);
  if (!sub) return result(pm === 'yarn' ? 'Installing dependencies' : `Running ${pm}`);
  if (/^(i|install|ci|add)$/.test(sub)) {
    const pkgs = operands(more);
    return result(pkgs.length ? `Installing ${clip(pkgs.join(', '), 50)}` : 'Installing dependencies');
  }
  if (/^(un|uninstall|remove|rm)$/.test(sub)) return result(`Removing ${operands(more).join(', ') || 'a dependency'}`);
  if (/^(up|update|upgrade)$/.test(sub)) return result('Updating dependencies');
  if (/^(t|test|tst)$/.test(sub)) return result('Running tests');
  if (sub === 'run' || sub === 'run-script') return more[0] ? describeTarget(more[0]) : result('Listing scripts');
  if (sub === 'exec' || sub === 'dlx' || sub === 'x') return describeTool(stripFlags(more), paths, true);
  if (sub === 'version') return result(more[0] ? `Bumping the version (${more[0]})` : 'Bumping the version');
  if (/^(view|info|show)$/.test(sub)) return result(`Looking up ${more[0] ?? 'a package'} on the registry`);
  const fixed = pick(PM_FIXED, sub);
  if (fixed) return result(fixed);
  if (/^(-v|--version)$/.test(args[0] ?? '')) return result(`Checking the ${pm} version`);
  // `yarn build`, `pnpm lint`, `bun dev`: a script name directly.
  if (pm !== 'npm') return describeTarget(sub);
  return result(`Running npm ${sub}`);
}

function describePip(args: readonly string[]): Desc {
  const [sub, ...more] = stripFlags(args);
  if (sub === 'install') return result(operands(more).length && !more.includes('-r') ? `Installing ${clip(operands(more).join(', '), 50)}` : 'Installing Python packages');
  if (sub === 'uninstall') return result('Removing Python packages');
  if (sub === 'list' || sub === 'freeze' || sub === 'show') return result('Checking installed Python packages');
  return result(`Running pip ${sub ?? ''}`.trim());
}

const PY_MODULES: Record<string, string> = {
  pytest: 'Running tests',
  unittest: 'Running tests',
  venv: 'Creating a virtual environment',
  virtualenv: 'Creating a virtual environment',
  'http.server': 'Starting a local web server',
  'json.tool': 'Formatting JSON',
};

function describePython(args: readonly string[], f: ShowPath, input: string | null | undefined): Desc | null {
  if (args[0] === '-c') return result('Running a Python snippet');
  if (args[0] === '-m') {
    const mod = args[1];
    const fixed = pick(PY_MODULES, mod);
    if (fixed) return result(fixed);
    if (mod === 'pip') return describePip(args.slice(2));
    return describeTool([mod, ...args.slice(2)], '', false); // no cwd: v1 named modules as given
  }
  if (args.includes('--version') || args.includes('-V')) return result('Checking the Python version');
  const script = operands(args.filter((a) => !/^-[IuOBESsq]+$/.test(a)))[0];
  if (script && script !== '-') return result(`Running ${f(script)}`);
  return result(input ? `Running a Python script on ${f(input)}` : 'Running a Python script');
}

function describeNode({ cmd, args, f }: { cmd: string; args: string[]; f: ShowPath }): Desc {
  if (cmd === 'deno' && args[0] === 'test') return result('Running tests');
  if (args.includes('--test')) return result('Running tests');
  if (args.some((a) => a === '-e' || a === '--eval' || a === '-p' || a === '--print')) return result('Running a Node snippet');
  if (args.includes('--version') || args.includes('-v')) return result('Checking the Node version');
  const script = operands(args)[0];
  return result(script ? `Running ${f(script)}` : 'Running a Node script');
}

function describeUv(args: readonly string[], paths: Paths): Desc | null {
  if (/^(add|sync|install|lock)$/.test(args[0] ?? '')) return result('Installing Python packages');
  if (args[0] === 'pip') return describePip(args.slice(1));
  if (args[0] === 'run') return describeTool(stripFlags(args.slice(1)), paths, false) ?? result('Running a Python script');
  return null;
}

const CARGO: Record<string, string> = {
  build: 'Building the project',
  b: 'Building the project',
  test: 'Running tests',
  t: 'Running tests',
  run: 'Running the program',
  r: 'Running the program',
  check: 'Checking the code compiles',
  c: 'Checking the code compiles',
  clippy: 'Linting',
  fmt: 'Formatting code',
  add: 'Adding a dependency',
  install: 'Installing a crate',
  bench: 'Running benchmarks',
  doc: 'Building docs',
};

const GO = (args: readonly string[]): Record<string, string> => ({
  build: 'Building the project',
  test: 'Running tests',
  run: 'Running the program',
  vet: 'Checking the code',
  fmt: 'Formatting code',
  get: 'Adding a dependency',
  install: 'Installing a Go tool',
  mod: args[1] === 'tidy' ? 'Tidying Go modules' : 'Managing Go modules',
  generate: 'Generating code',
});

const COMPOSE: Record<string, string> = { up: 'Starting containers', down: 'Stopping containers', build: 'Building containers', logs: 'Reading container logs', ps: 'Listing containers', exec: 'Running a command in a container' };
const DOCKER: Record<string, string> = { build: 'Building a Docker image', run: 'Starting a container', ps: 'Listing containers', exec: 'Running a command in a container', logs: 'Reading container logs', pull: 'Pulling a Docker image', push: 'Pushing a Docker image', stop: 'Stopping a container', images: 'Listing Docker images' };

function describeDocker(args: readonly string[]): Desc {
  const [sub, action] = stripFlags(args);
  if (sub === 'compose' || sub === 'docker-compose') return result(pick(COMPOSE, action) ?? 'Managing containers');
  return result(pick(DOCKER, sub) ?? `Running docker ${sub ?? ''}`.trim());
}

function describeBrew(args: readonly string[]): Desc {
  if (/^(install|upgrade|reinstall)$/.test(args[0] ?? '')) return result(`Installing ${operands(args.slice(1)).join(', ') || 'packages'}`);
  return result(args[0] === 'list' ? 'Listing installed packages' : `Running brew ${args[0] ?? ''}`.trim());
}

export const TOOL_COMMANDS: Table = [
  [['git'], ({ args, f }) => describeGit(args, f)],
  [['gh'], ({ args }) => describeGh(args)],
  [['npm', 'pnpm', 'yarn', 'bun'], ({ cmd, args, paths }) => describePackageManager(cmd, args, paths)],
  [['npx', 'bunx', 'pnpx'], ({ args, paths }) => describeTool(stripFlags(args), paths, true)],
  [['node', 'deno', 'tsx', 'ts-node'], describeNode],
  [['python', 'python3', 'py'], ({ args, f, input }) => describePython(args, f, input)],
  [['uv', 'poetry', 'pipenv'], ({ args, paths }) => describeUv(args, paths)],
  [['pip', 'pip3'], ({ args }) => describePip(args)],
  [['cargo'], ({ args }) => result(pick(CARGO, args[0]) ?? `Running cargo ${args[0] ?? ''}`.trim())],
  [['go'], ({ args }) => result(pick(GO(args), args[0]) ?? `Running go ${args[0] ?? ''}`.trim())],
  [
    ['make', 'just', 'task'],
    ({ cmd, args }) => {
      const t = operands(args)[0];
      return t ? describeTarget(t) : result(`Building with ${cmd}`);
    },
  ],
  [['docker', 'podman'], ({ args }) => describeDocker(args)],
  [['brew'], ({ args }) => describeBrew(args)],
];
