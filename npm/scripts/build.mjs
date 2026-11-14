#!/usr/bin/env node
// Assembles the npm packages for one target from a built wisp binary:
//
//   node npm/scripts/build.mjs --target linux-x64 --binary target/x86_64-unknown-linux-musl/release/wisp \
//     [--web apps/web/dist] [--out npm/dist] [--version 2.0.0]
//   node npm/scripts/build.mjs --list-targets
//
// Writes <out>/core-<target>/ (the platform package) and <out>/wisp-agents/ (the launcher, with the
// web bundle in web/). Every version is stamped the same, because the launcher pins its platform
// packages exactly. Node built-ins only, so a bare CI runner can run it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { TARGETS, binaryName, packageName } from '../wisp-agents/lib/resolve.js';

const NPM_DIR = fileURLToPath(new URL('..', import.meta.url));
const LAUNCHER_DIR = path.join(NPM_DIR, 'wisp-agents');
const TEMPLATE = path.join(NPM_DIR, 'platform', 'package.template.json');
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

class UsageError extends Error {}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function options(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: 'string' },
      binary: { type: 'string' },
      web: { type: 'string' },
      out: { type: 'string' },
      version: { type: 'string' },
      'list-targets': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  return values;
}

function validate(opts) {
  if (!opts.target) throw new UsageError('--target is required (see --list-targets).');
  if (!Object.hasOwn(TARGETS, opts.target)) {
    throw new UsageError(`Unknown target "${opts.target}". Supported: ${Object.keys(TARGETS).join(', ')}.`);
  }
  if (!opts.binary) throw new UsageError('--binary is required: the path of the built wisp executable.');
  const bin = path.resolve(opts.binary);
  if (!fs.existsSync(bin) || !fs.statSync(bin).isFile()) {
    throw new UsageError(`The binary ${bin} does not exist. Build it first: cargo build --release -p wisp --target ${TARGETS[opts.target]}`);
  }
  const web = opts.web ? path.resolve(opts.web) : null;
  if (web && !(fs.existsSync(web) && fs.statSync(web).isDirectory())) {
    throw new UsageError(`The web dir ${web} does not exist. Build it first (apps/web/dist).`);
  }
  const version = opts.version ?? readJson(path.join(LAUNCHER_DIR, 'package.json')).version;
  if (!SEMVER.test(version)) throw new UsageError(`"${version}" is not a semver version.`);
  const out = path.resolve(opts.out ?? path.join(NPM_DIR, 'dist'));
  return { target: opts.target, bin, web, version, out };
}

// The template uses ${os}/${arch}/${triple}/${version} in its strings; JSON stays JSON.
function fillTemplate(value, vars) {
  if (typeof value === 'string') return value.replace(/\$\{(\w+)\}/g, (_, k) => vars[k] ?? `\${${k}}`);
  if (Array.isArray(value)) return value.map((v) => fillTemplate(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillTemplate(v, vars)]));
  return value;
}

function buildPlatform({ target, bin, version, out }) {
  const [os, arch] = target.split('-');
  const dir = path.join(out, `core-${target}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  const pkg = fillTemplate(readJson(TEMPLATE), { os, arch, version, triple: TARGETS[target] });
  if (pkg.name !== packageName(os, arch)) throw new Error(`Template produced ${pkg.name}, the launcher looks for ${packageName(os, arch)}.`);
  writeJson(path.join(dir, 'package.json'), pkg);
  const dest = path.join(dir, 'bin', binaryName(os));
  fs.copyFileSync(bin, dest);
  fs.chmodSync(dest, 0o755); // npm keeps the mode from the tarball; the launcher spawns it directly
  return dir;
}

function buildLauncher({ web, version, out }) {
  const dir = path.join(out, 'wisp-agents');
  fs.rmSync(dir, { recursive: true, force: true });
  // A web/ left in the source tree from a dev run must not leak into a release.
  fs.cpSync(LAUNCHER_DIR, dir, { recursive: true, filter: (src) => src !== path.join(LAUNCHER_DIR, 'web') });
  if (web) fs.cpSync(web, path.join(dir, 'web'), { recursive: true });
  const pkgFile = path.join(dir, 'package.json');
  const pkg = readJson(pkgFile);
  pkg.version = version;
  // Exactly the supported targets, so adding one to TARGETS can't be forgotten here.
  pkg.optionalDependencies = Object.fromEntries(Object.keys(TARGETS).map((t) => [packageName(...t.split('-')), version]));
  writeJson(pkgFile, pkg);
  fs.chmodSync(path.join(dir, 'bin', 'wisp.js'), 0o755);
  return dir;
}

function listTargets() {
  const width = Math.max(...Object.keys(TARGETS).map((t) => t.length));
  for (const [t, triple] of Object.entries(TARGETS)) process.stdout.write(`${t.padEnd(width)}  ${triple}\n`);
}

const USAGE = 'Usage: node npm/scripts/build.mjs --target <os>-<arch> --binary <path> [--web <dir>] [--out <dir>] [--version x.y.z]\n       node npm/scripts/build.mjs --list-targets\n';

function main(argv) {
  const opts = options(argv);
  if (opts.help) return process.stdout.write(USAGE);
  if (opts['list-targets']) return listTargets();
  const conf = validate(opts);
  const platformDir = buildPlatform(conf);
  const launcherDir = buildLauncher(conf);
  process.stdout.write(`wrote ${platformDir}\nwrote ${launcherDir}${conf.web ? '' : ' (no --web: the launcher ships without the web UI)'}\n`);
}

try {
  main(process.argv.slice(2));
} catch (err) {
  const usage = err instanceof UsageError || err?.code?.startsWith?.('ERR_PARSE_ARGS');
  process.stderr.write(`build: ${err.message}\n${usage ? USAGE : ''}`);
  process.exit(usage ? 2 : 1);
}
