// Turns a shell command into a short English sentence for the live ticker, e.g.
// `sed -n 15,50p src/a.js` → "Reading lines 15–50 of src/a.js". Best effort: a command we don't
// know falls back to "Running <command>", and the raw command stays in the activity detail.

import path from 'node:path';
import { clip, rel } from './common.js';

export function describeCommand(command, cwd) {
  const raw = String(command ?? '').trim();
  const fallback = `Running ${clip(raw, 60)}`;
  if (!raw) return fallback;
  let parts;
  try {
    parts = segments(stripHeredocs(raw)).map((pipe) => describePipeline(pipe, cwd)).filter(Boolean);
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

const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

// Drop heredoc bodies so their lines aren't read as commands: `cat <<EOF > f\n…\nEOF` → `cat <<EOF > f`.
function stripHeredocs(s) {
  return s.replace(/(<<-?\s*(['"]?)([\w-]+)\2)([^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, '$1$4');
}

// Split into a list of pipelines (by && || ; & newline), each a list of stages (by |), each a list
// of words. Quotes are honoured; $(…) and `…` stay inside the word they appear in.
function segments(s) {
  const out = [];
  let pipe = [];
  let words = [];
  let word = null;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endStage = () => {
    endWord();
    if (words.length) pipe.push(words);
    words = [];
  };
  const endPipe = () => {
    endStage();
    if (pipe.length) out.push(pipe);
    pipe = [];
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      const end = j < 0 ? s.length : j;
      word = (word ?? '') + s.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      let buf = '';
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) j++;
        buf += s[j++];
      }
      word = (word ?? '') + buf;
      i = j;
    } else if (c === '\\' && i + 1 < s.length) {
      if (s[i + 1] !== '\n') word = (word ?? '') + s[i + 1];
      i++;
    } else if (c === '$' && s[i + 1] === '(') {
      let depth = 0;
      let j = i + 1;
      for (; j < s.length; j++) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')' && --depth === 0) break;
      }
      word = (word ?? '') + s.slice(i, j + 1);
      i = j;
    } else if (c === '`') {
      const j = s.indexOf('`', i + 1);
      const end = j < 0 ? s.length : j;
      word = (word ?? '') + s.slice(i, end + 1);
      i = end;
    } else if (c === '|' && s[i + 1] !== '|') {
      endStage();
    } else if ((c === '&' && s[i + 1] === '&') || (c === '|' && s[i + 1] === '|')) {
      endPipe();
      i++;
    } else if (c === ';' || c === '\n' || (c === '&' && s[i + 1] !== '>' && s[i - 1] !== '>')) {
      endPipe();
    } else if (c === '&' && s[i + 1] === '>') {
      endWord();
      words.push(s[i + 2] === '>' ? '&>>' : '&>');
      i += s[i + 2] === '>' ? 2 : 1;
    } else if (c === '>' || c === '<') {
      // Redirects become their own word ('>', '>>', '<', '2>&1' …) so stages can read targets.
      endWord();
      let op = c;
      if (/^\d$/.test(words.at(-1) ?? '') && /\s/.test(s[i - 1] ?? '') === false) op = words.pop() + op;
      while (s[i + 1] === '>' || s[i + 1] === '&' || s[i + 1] === '<') op += s[++i];
      if (/&$/.test(op) && /\d/.test(s[i + 1] ?? '')) op += s[++i];
      words.push(op);
    } else if (/\s/.test(c)) {
      endWord();
    } else if ((c === '(' || c === ')' || c === '{' || c === '}') && word === null) {
      endWord(); // subshells and groups: describe what's inside
    } else {
      word = (word ?? '') + c;
    }
  }
  endPipe();
  return out;
}

const WRAPPERS = new Set(['sudo', 'time', 'nohup', 'command', 'exec', 'nice', 'caffeinate', 'stdbuf', 'unbuffer']);
const CONTROL = new Set(['then', 'else', 'elif', 'do', 'done', 'fi', 'esac', '!']);

// Peel off env assignments, wrappers and redirects. Returns { argv, out } with `out` the file a
// `>`/`>>` redirect writes to (ignoring /dev/null and fd duplications).
function parseStage(words) {
  const argv = [];
  let out = null;
  let input = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^\d*(>>?|&>>?)$/.test(w)) {
      const target = words[++i];
      if (target && target !== '/dev/null') out = target;
    } else if (/^\d*<$/.test(w)) {
      input = words[++i];
    } else if (/^\d*[<>]+&?\d*$/.test(w) || /^<<-?/.test(w)) {
      if (/^<<-?$/.test(w)) i++; // heredoc delimiter
    } else {
      argv.push(w);
    }
  }
  for (;;) {
    const w = argv[0];
    if (w === undefined) break;
    if (/^[A-Za-z_]\w*=/.test(w) || CONTROL.has(w)) argv.shift();
    else if (w === 'env') {
      argv.shift();
      while (argv[0] && (/^-/.test(argv[0]) || /^[A-Za-z_]\w*=/.test(argv[0]))) argv.shift();
    } else if (WRAPPERS.has(w)) {
      argv.shift();
      while (argv[0] && /^-/.test(argv[0])) argv.shift();
    } else if (w === 'timeout' || w === 'gtimeout') {
      argv.shift();
      while (argv[0] && /^-/.test(argv[0])) argv.shift();
      argv.shift(); // the duration
    } else if (w === 'xargs') {
      argv.shift();
      while (argv[0] && /^-/.test(argv[0])) argv.splice(0, /^-[IdLnPsE]$/.test(argv[0]) ? 2 : 1);
    } else break;
  }
  return { argv, out, input };
}

// A pipeline is described by its first stage that says something (`git log | head` → git log).
function describePipeline(stages, cwd) {
  let best = null;
  for (const words of stages) {
    const stage = parseStage(words);
    if (!stage.argv.length) continue;
    const d = describeStage(stage, cwd, stages.length > 1);
    if (d && !d.weak && !d.unknown) return d;
    best ??= d;
  }
  return best;
}

const result = (text, extra) => ({ text, ...extra });
const weak = (text) => ({ text, weak: true });

function describeStage({ argv, out, input }, cwd, piped) {
  const [cmd0, ...args] = argv;
  const cmd = path.basename(cmd0);
  const f = (p) => short(p, cwd);
  const files = operands(args);
  const target = files.length ? files.map(f).slice(0, 2).join(', ') + (files.length > 2 ? ` +${files.length - 2}` : '') : '';

  if (out && /^(echo|printf|cat|tee)$/.test(cmd)) return result(`Writing ${f(out)}`);

  switch (cmd) {
    case 'cd':
    case 'pushd':
    case 'popd':
      return weak(args[0] ? `Going to ${f(args[0])}` : 'Changing folder');
    case 'export':
    case 'set':
    case 'unset':
    case 'source':
    case '.':
    case 'true':
    case 'false':
    case 'shift':
    case 'local':
    case 'read':
    case 'trap':
    case ':':
    case 'for':
    case 'case':
      return weak('Setting up the shell');
    case 'echo':
    case 'printf':
      return weak('Printing a message');
    case 'cat':
    case 'bat':
    case 'less':
    case 'more':
      return files.length ? result(`Reading ${target}`) : piped ? weak('Reading input') : null;
    case 'nl':
      return files.length ? result(`Reading ${target}`) : null;
    case 'head':
    case 'tail': {
      if (cmd === 'tail' && args.some((a) => /^-[a-zA-Z]*[fF]/.test(a))) return result(files.length ? `Watching ${target}` : 'Watching output');
      const n = countArg(args);
      if (!files.length) return weak(n ? `Taking the ${cmd === 'head' ? 'first' : 'last'} ${n} lines` : 'Trimming output');
      return result(n ? `Reading the ${cmd === 'head' ? 'first' : 'last'} ${n} lines of ${target}` : `Reading the ${cmd === 'head' ? 'start' : 'end'} of ${target}`);
    }
    case 'sed':
    case 'gsed':
      return describeSed(args, f, piped);
    case 'awk':
    case 'gawk': {
      const file = operands(args).slice(1);
      return file.length ? result(`Reading ${f(file[0])}`) : weak('Processing text');
    }
    case 'grep':
    case 'egrep':
    case 'fgrep':
    case 'rg':
    case 'ag':
    case 'ack':
      return describeGrep(cmd, args, f, piped);
    case 'find':
    case 'fd': {
      const name = valueOf(args, ['-name', '-iname', '-path', '-ipath']) ?? (cmd === 'fd' ? operands(args)[0] : null);
      const where = cmd === 'find' ? (args[0] && !args[0].startsWith('-') ? args[0] : '') : operands(args)[1];
      const inWhere = where && where !== '.' ? ` in ${f(where)}` : '';
      if (args.includes('-delete')) return result(`Deleting ${name ? `${name} files` : 'files'}${inWhere}`);
      return result(name ? `Finding ${clip(name, 40)}${inWhere}` : `Finding files${inWhere}`);
    }
    case 'ls':
    case 'eza':
    case 'exa':
    case 'tree':
      return result(files.length ? `Listing ${target}` : cmd === 'tree' ? 'Looking at the folder tree' : 'Listing files');
    case 'pwd':
      return weak('Checking the current folder');
    case 'wc':
      return files.length ? result(`Counting ${args.includes('-l') ? 'lines' : 'words'} in ${target}`) : weak('Counting lines');
    case 'sort':
    case 'uniq':
    case 'cut':
    case 'tr':
    case 'column':
    case 'fold':
    case 'rev':
      return files.length ? result(`Reading ${target}`) : weak('Processing text');
    case 'jq':
    case 'yq':
      return result(operands(args)[1] ? `Reading ${f(operands(args)[1])}` : 'Parsing JSON', operands(args)[1] ? {} : { weak: piped });
    case 'diff':
    case 'cmp':
    case 'colordiff':
      return result(files.length >= 2 ? `Comparing ${f(files[0])} and ${f(files[1])}` : 'Comparing files');
    case 'stat':
    case 'file':
      return result(`Inspecting ${target || 'a file'}`);
    case 'du':
    case 'df':
      return result(`Checking disk usage${target ? ` of ${target}` : ''}`);
    case 'mkdir':
      return result(`Creating folder ${target}`);
    case 'touch':
      return result(`Creating ${target}`);
    case 'rm':
    case 'rmdir':
    case 'trash':
      return result(`Deleting ${target || 'files'}`);
    case 'mv':
      return result(files.length === 2 ? `Moving ${f(files[0])} to ${f(files[1])}` : `Moving ${target}`);
    case 'cp':
    case 'rsync':
      return result(files.length === 2 ? `Copying ${f(files[0])} to ${f(files[1])}` : `Copying ${target}`);
    case 'ln':
      return result(`Linking ${target}`);
    case 'chmod':
    case 'chown':
      return result(`Changing permissions of ${operands(args).slice(1).map(f).join(', ') || 'files'}`);
    case 'tee':
      return result(files.length ? `Writing ${target}` : 'Saving output');
    case 'tar':
    case 'unzip':
    case 'gunzip':
    case '7z':
      return result(/^(-?[a-z]*c|zip)/.test(args[0] ?? '') && cmd === 'tar' ? 'Creating an archive' : `Extracting ${target || 'an archive'}`);
    case 'zip':
      return result('Creating an archive');
    case 'curl':
    case 'wget':
    case 'http':
    case 'xh': {
      const url = args.find((a) => /^https?:\/\//.test(a) || /^(localhost|127\.0\.0\.1|[\w.-]+\.[a-z]{2,})(?:[/:]|$)/.test(a));
      return result(url ? `Fetching ${host(url)}` : 'Fetching a URL');
    }
    case 'open':
    case 'xdg-open':
      return result(`Opening ${target || 'a file'}`);
    case 'sleep':
      return result(`Waiting ${args[0] ?? ''}${/^\d+$/.test(args[0] ?? '') ? 's' : ''}`.trim());
    case 'wait':
      return result('Waiting for background jobs');
    case 'until':
    case 'while': {
      const inner = describeStage(parseStage(args), cwd, piped);
      return result(inner && !inner.unknown ? `Waiting on: ${lower(inner.text)}` : 'Waiting for something to change');
    }
    case 'if':
    case 'test':
    case '[':
    case '[[':
      return weak('Checking a condition');
    case 'ps':
    case 'pgrep':
    case 'top':
    case 'htop':
      return result('Checking running processes');
    case 'kill':
    case 'pkill':
    case 'killall':
      return result('Stopping a process');
    case 'lsof': {
      const port = args.find((a) => /^-?i?:\d+$/.test(a) || /^tcp:\d+$/.test(a));
      return result(port ? `Checking what is using port ${port.replace(/\D/g, '')}` : 'Checking open files');
    }
    case 'which':
    case 'whereis':
    case 'type':
      return result(`Checking if ${operands(args)[0] ?? 'a tool'} is installed`);
    case 'env':
    case 'printenv':
      return result('Checking environment variables');
    case 'uname':
    case 'sw_vers':
    case 'hostname':
    case 'whoami':
    case 'id':
      return result('Checking the system');
    case 'date':
      return weak('Checking the time');
    case 'git':
      return describeGit(args, f);
    case 'gh':
      return describeGh(args);
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
      return describePackageManager(cmd, args, cwd);
    case 'npx':
    case 'bunx':
    case 'pnpx':
      return describeTool(stripFlags(args), cwd, true);
    case 'node':
    case 'deno':
    case 'tsx':
    case 'ts-node':
      if (cmd === 'deno' && args[0] === 'test') return result('Running tests');
      if (args.includes('--test')) return result('Running tests');
      if (args.some((a) => a === '-e' || a === '--eval' || a === '-p' || a === '--print')) return result('Running a Node snippet');
      if (args.includes('--version') || args.includes('-v')) return result('Checking the Node version');
      return result(operands(args)[0] ? `Running ${f(operands(args)[0])}` : 'Running a Node script');
    case 'python':
    case 'python3':
    case 'py':
      return describePython(args, f, input);
    case 'uv':
    case 'poetry':
    case 'pipenv':
      if (/^(add|sync|install|lock)$/.test(args[0] ?? '')) return result('Installing Python packages');
      if (args[0] === 'pip') return describePip(args.slice(1));
      if (args[0] === 'run') return describeTool(stripFlags(args.slice(1)), cwd, false) ?? result('Running a Python script');
      return null;
    case 'pip':
    case 'pip3':
      return describePip(args);
    case 'cargo':
      return result(
        { build: 'Building the project', b: 'Building the project', test: 'Running tests', t: 'Running tests', run: 'Running the program', r: 'Running the program', check: 'Checking the code compiles', c: 'Checking the code compiles', clippy: 'Linting', fmt: 'Formatting code', add: 'Adding a dependency', install: 'Installing a crate', bench: 'Running benchmarks', doc: 'Building docs' }[args[0]] ?? `Running cargo ${args[0] ?? ''}`.trim()
      );
    case 'go':
      return result(
        { build: 'Building the project', test: 'Running tests', run: 'Running the program', vet: 'Checking the code', fmt: 'Formatting code', get: 'Adding a dependency', install: 'Installing a Go tool', mod: args[1] === 'tidy' ? 'Tidying Go modules' : 'Managing Go modules', generate: 'Generating code' }[args[0]] ?? `Running go ${args[0] ?? ''}`.trim()
      );
    case 'make':
    case 'just':
    case 'task': {
      const t = operands(args)[0];
      return t ? describeTarget(t) : result(`Building with ${cmd}`);
    }
    case 'docker':
    case 'podman':
      return describeDocker(args);
    case 'brew':
      return result(/^(install|upgrade|reinstall)$/.test(args[0] ?? '') ? `Installing ${operands(args.slice(1)).join(', ') || 'packages'}` : args[0] === 'list' ? 'Listing installed packages' : `Running brew ${args[0] ?? ''}`.trim());
    case 'ssh':
      return result(`Connecting to ${operands(args)[0] ?? 'a server'}`);
    case 'scp':
      return result('Copying files over SSH');
    case 'claude':
    case 'codex':
    case 'gemini':
    case 'cursor-agent':
    case 'opencode':
      return result(`Asking ${cmd === 'cursor-agent' ? 'Cursor' : cmd.charAt(0).toUpperCase() + cmd.slice(1)}`);
    case 'bash':
    case 'sh':
    case 'zsh':
      if (args[0] === '-c' || args[0] === '-lc') return describeInner(args[1], cwd);
      return result(operands(args)[0] ? `Running ${f(operands(args)[0])}` : 'Running a shell script');
    default:
      return describeTool(argv, cwd, false);
  }
}

function describeInner(script, cwd) {
  const label = describeCommand(script, cwd);
  return label === `Running ${clip(String(script ?? '').trim(), 60)}` ? { text: label, unknown: true } : result(label);
}

// Dev tools that run on their own or through npx / pnpm exec / uv run.
function describeTool(argv, cwd, viaRunner) {
  const [cmd0, ...args] = argv;
  if (!cmd0) return null;
  const name = cmd0.replace(/@[^/]*$/, ''); // npx tsc@5 → tsc
  const cmd = path.basename(name);
  if (/^(jest|vitest|mocha|ava|tap|pytest|playwright|cypress|karma|jasmine|uvu)$/.test(cmd)) {
    if (cmd === 'playwright' && args[0] === 'install') return result('Installing browsers for Playwright');
    return result(args.includes('--watch') ? 'Running tests in watch mode' : 'Running tests');
  }
  if (cmd === 'tsc' || cmd === 'vue-tsc') return result(args.includes('--watch') || args.includes('-w') ? 'Type-checking in watch mode' : 'Type-checking');
  if (/^(eslint|biome|oxlint|stylelint|ruff|flake8|pylint|golangci-lint|rubocop|shellcheck|standard|xo)$/.test(cmd)) {
    if (cmd === 'biome' && args[0] === 'format') return result('Formatting code');
    if (cmd === 'ruff' && args[0] === 'format') return result('Formatting code');
    return result(args.includes('--fix') ? 'Fixing lint issues' : 'Linting');
  }
  if (/^(prettier|black|isort|gofmt|rustfmt|dprint|clang-format)$/.test(cmd)) return result(args.includes('--check') || args.includes('-c') ? 'Checking formatting' : 'Formatting code');
  if (/^(vite|next|nuxt|astro|webpack|rollup|esbuild|parcel|tsup|turbo|nx|svelte-kit|remix)$/.test(cmd)) {
    const sub = args.find((a) => !a.startsWith('-'));
    if (!sub || /^(dev|serve|start|preview)$/.test(sub)) return result(cmd === 'esbuild' || cmd === 'rollup' || cmd === 'tsup' ? 'Building the project' : 'Starting the dev server');
    if (sub === 'build') return result('Building the project');
    if (/^(lint|test|typecheck)$/.test(sub)) return describeTarget(sub);
    return result(`Building the project`);
  }
  if (/^(mypy|pyright)$/.test(cmd)) return result('Type-checking');
  if (cmd === 'electron' || cmd === 'electron-builder' || cmd === 'electron-forge') return result(cmd === 'electron' ? 'Starting the Electron app' : 'Packaging the app');
  if (cmd === 'serve' || cmd === 'http-server') return result('Starting a local web server');
  if (cmd === 'prisma' || cmd === 'drizzle-kit') return result(/migrate|push/.test(args.join(' ')) ? 'Migrating the database' : 'Generating the database client');
  if (cmd === 'create-react-app' || /^create-/.test(cmd)) return result('Scaffolding a new project');
  if (/^\.{0,2}\//.test(cmd0) || /\.(sh|js|mjs|cjs|ts|py|rb)$/.test(cmd0)) return result(`Running ${short(cmd0, cwd)}`);
  return { text: `Running ${viaRunner ? cmd : clip(argv.join(' '), 50)}`, unknown: !viaRunner };
}

// `make test`, `npm run lint`, `just build` …
function describeTarget(t) {
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

function describePackageManager(pm, args, cwd) {
  const rest = stripFlags(args);
  const [sub, ...more] = rest;
  if (!sub) return result(pm === 'yarn' ? 'Installing dependencies' : `Running ${pm}`);
  if (/^(i|install|ci|add)$/.test(sub)) {
    const pkgs = operands(more);
    return result(pkgs.length ? `Installing ${clip(pkgs.join(', '), 50)}` : 'Installing dependencies');
  }
  if (/^(un|uninstall|remove|rm)$/.test(sub)) return result(`Removing ${operands(more).join(', ') || 'a dependency'}`);
  if (/^(up|update|upgrade)$/.test(sub)) return result('Updating dependencies');
  if (/^(t|test|tst)$/.test(sub)) return result('Running tests');
  if (sub === 'run' || sub === 'run-script') return more[0] ? describeTarget(more[0]) : result('Listing scripts');
  if (sub === 'exec' || sub === 'dlx' || sub === 'x') return describeTool(stripFlags(more), cwd, true);
  if (sub === 'start') return result('Starting the app');
  if (sub === 'publish') return result('Publishing the package');
  if (sub === 'version') return result(more[0] ? `Bumping the version (${more[0]})` : 'Bumping the version');
  if (sub === 'pack') return result('Packing the package');
  if (sub === 'outdated') return result('Checking for outdated dependencies');
  if (sub === 'audit') return result('Auditing dependencies');
  if (/^(ls|list|why|explain)$/.test(sub)) return result('Inspecting dependencies');
  if (/^(view|info|show)$/.test(sub)) return result(`Looking up ${more[0] ?? 'a package'} on the registry`);
  if (sub === 'init' || sub === 'create') return result('Scaffolding a new project');
  if (sub === 'link') return result('Linking a local package');
  if (sub === 'config') return result('Checking npm settings');
  if (/^(-v|--version)$/.test(args[0])) return result(`Checking the ${pm} version`);
  // `yarn build`, `pnpm lint`, `bun dev`: a script name directly.
  if (pm !== 'npm') return describeTarget(sub);
  return result(`Running npm ${sub}`);
}

function describePip(args) {
  const [sub, ...more] = stripFlags(args);
  if (sub === 'install') return result(operands(more).length && !more.includes('-r') ? `Installing ${clip(operands(more).join(', '), 50)}` : 'Installing Python packages');
  if (sub === 'uninstall') return result('Removing Python packages');
  if (sub === 'list' || sub === 'freeze' || sub === 'show') return result('Checking installed Python packages');
  return result(`Running pip ${sub ?? ''}`.trim());
}

function describePython(args, f, input) {
  if (args[0] === '-c') return result('Running a Python snippet');
  if (args[0] === '-m') {
    const mod = args[1];
    if (mod === 'pytest' || mod === 'unittest') return result('Running tests');
    if (mod === 'pip') return describePip(args.slice(2));
    if (mod === 'venv' || mod === 'virtualenv') return result('Creating a virtual environment');
    if (mod === 'http.server') return result('Starting a local web server');
    if (mod === 'json.tool') return result('Formatting JSON');
    return describeTool([mod, ...args.slice(2)], '', false);
  }
  if (args.includes('--version') || args.includes('-V')) return result('Checking the Python version');
  const script = operands(args.filter((a) => !/^-[IuOBESsq]+$/.test(a)))[0];
  if (script && script !== '-') return result(`Running ${f(script)}`);
  return result(input ? `Running a Python script on ${f(input)}` : 'Running a Python script');
}

function describeSed(args, f, piped) {
  const inPlace = args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'));
  const scripts = [];
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-e' || a === '--expression') scripts.push(args[++i]);
    else if (a === '-f') i++;
    else if (/^-/.test(a)) continue;
    else if (inPlace && a === '' && args[i - 1] === '-i') continue; // BSD `sed -i ''`
    else rest.push(a);
  }
  if (!scripts.length && rest.length) scripts.push(rest.shift());
  const files = rest;
  const target = files.map(f).slice(0, 2).join(', ');
  if (inPlace) return result(target ? `Editing ${target}` : 'Editing files');
  const script = (scripts[0] ?? '').trim();
  const lines = script.match(/^(\d+|\$)(?:\s*,\s*(\d+|\$))?\s*p$/);
  if (lines && args.some((a) => /^-[a-zA-Z]*n/.test(a))) {
    const [, a, b] = lines;
    const span = !b ? `line ${a}` : b === '$' ? `from line ${a} on` : `lines ${a}–${b}`;
    if (!target) return weak(`Taking ${span}`);
    return result(b === '$' ? `Reading ${target} from line ${a} on` : `Reading ${span} of ${target}`);
  }
  if (target) return result(/^s(.)/.test(script) ? `Rewriting text from ${target}` : `Reading ${target}`);
  return piped ? weak('Processing text') : result('Processing text');
}

function describeGrep(cmd, args, f, piped) {
  let pattern = null;
  const paths = [];
  const takesValue = /^(-e|-f|-m|-A|-B|-C|-g|--glob|-t|--type|-T|--max-count|--context|--after-context|--before-context|--regexp|--include|--exclude|--exclude-dir|-d|-D)$/;
  let files = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-e' || a === '--regexp') pattern ??= args[++i];
    else if (a === '-l' || a === '--files' || a === '--files-with-matches') {
      files = files || a === '--files';
    } else if (takesValue.test(a)) i++;
    else if (/^-/.test(a)) continue;
    else if (pattern === null && !(cmd === 'rg' && args.includes('--files'))) pattern = a;
    else paths.push(a);
  }
  if (cmd === 'rg' && args.includes('--files')) return result(paths.length ? `Listing files in ${f(paths[0])}` : 'Listing files');
  if (pattern === null) return piped ? weak('Filtering output') : result('Searching files');
  const where = paths.length ? ` in ${paths.map(f).slice(0, 2).join(', ')}${paths.length > 2 ? ` +${paths.length - 2}` : ''}` : '';
  if (piped && !paths.length) return weak(`Filtering for “${clip(pattern, 40)}”`);
  return result(`Searching for “${clip(pattern, 40)}”${where}`);
}

function describeGit(args, f) {
  // Skip global options: git -C dir -c k=v --no-pager status
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += /^(-C|-c|--git-dir|--work-tree)$/.test(args[i]) ? 2 : 1;
  const [sub, ...rest] = args.slice(i);
  const ops = operands(rest);
  const has = (...flags) => flags.some((x) => rest.includes(x));
  switch (sub) {
    case undefined:
      return result('Running git');
    case 'status':
      return result('Checking git status');
    case 'diff':
      return result(has('--stat', '--name-only', '--name-status', '--shortstat') ? 'Summarising changes' : has('--cached', '--staged') ? 'Reviewing staged changes' : ops.length ? `Viewing changes${ops.some((o) => o.includes('/') || o.includes('.')) && !ops.some((o) => o.includes('..')) ? ` in ${ops.map(f).slice(0, 2).join(', ')}` : ` (${clip(ops.join(' '), 30)})`}` : 'Viewing changes');
    case 'log':
    case 'shortlog':
    case 'reflog':
      return result(ops.length && !ops[0].includes('..') && /[/.]/.test(ops.at(-1)) ? `Reading the history of ${f(ops.at(-1))}` : 'Reading git history');
    case 'show':
      return result(ops[0] ? (ops[0].includes(':') ? `Reading ${ops[0].split(':').slice(1).join(':')} at ${ops[0].split(':')[0] || 'the index'}` : `Viewing commit ${clip(ops[0], 20)}`) : 'Viewing the last commit');
    case 'blame':
      return result(`Checking who changed ${ops.length ? f(ops.at(-1)) : 'the file'}`);
    case 'add':
      return result(has('-A', '--all', '.') || ops.includes('.') ? 'Staging all changes' : `Staging ${ops.map(f).slice(0, 2).join(', ') || 'changes'}`);
    case 'commit': {
      const m = valueOf(rest, ['-m', '--message']);
      return result(has('--amend') ? 'Amending the last commit' : m ? `Committing “${clip(m.split('\n')[0], 50)}”` : 'Committing changes');
    }
    case 'push':
      return result(has('--tags') ? 'Pushing tags' : ops[1] ? `Pushing ${clip(ops[1], 40)}` : 'Pushing to the remote');
    case 'pull':
      return result('Pulling the latest changes');
    case 'fetch':
      return result(ops[0] ? `Fetching from ${ops[0]}` : 'Fetching from the remote');
    case 'clone':
      return result(`Cloning ${ops[0] ? clip(ops[0].replace(/^https?:\/\/(www\.)?/, '').replace(/\.git$/, ''), 50) : 'a repository'}`);
    case 'checkout':
    case 'switch':
      if (has('-b', '-B', '-c', '-C')) return result(`Creating branch ${valueOf(rest, ['-b', '-B', '-c', '-C']) ?? ''}`.trim());
      if (rest.includes('--')) return result(`Discarding changes to ${operands(rest.slice(rest.indexOf('--') + 1)).map(f).join(', ') || 'files'}`);
      return result(ops[0] ? `Switching to ${clip(ops[0], 40)}` : 'Switching branch');
    case 'restore':
      return result(`Restoring ${ops.map(f).slice(0, 2).join(', ') || 'files'}`);
    case 'branch':
      if (has('-d', '-D', '--delete')) return result(`Deleting branch ${ops[0] ?? ''}`.trim());
      if (has('-m', '-M')) return result('Renaming a branch');
      return result(ops[0] && !has('--list', '-a', '-r', '-v', '-vv') ? `Creating branch ${ops[0]}` : has('--show-current') ? 'Checking the current branch' : 'Listing branches');
    case 'merge':
      return result(has('--abort') ? 'Aborting the merge' : has('--continue') ? 'Finishing the merge' : `Merging ${ops[0] ?? 'changes'}`);
    case 'rebase':
      return result(has('--abort') ? 'Aborting the rebase' : has('--continue') ? 'Continuing the rebase' : `Rebasing onto ${ops[0] ?? 'upstream'}`);
    case 'cherry-pick':
      return result(has('--abort') ? 'Aborting the cherry-pick' : has('--continue') ? 'Continuing the cherry-pick' : `Cherry-picking ${clip(ops.join(' '), 30) || 'a commit'}`);
    case 'revert':
      return result(`Reverting ${ops[0] ?? 'a commit'}`);
    case 'reset':
      return result(has('--hard') ? 'Discarding local changes' : ops.length ? `Unstaging ${ops.map(f).slice(0, 2).join(', ')}` : 'Resetting changes');
    case 'stash': {
      const s = rest[0];
      return result({ pop: 'Restoring stashed changes', apply: 'Restoring stashed changes', list: 'Listing stashes', drop: 'Dropping a stash', show: 'Viewing a stash' }[s] ?? 'Stashing changes');
    }
    case 'tag':
      return result(ops.length && !has('-l', '--list') ? `Tagging ${ops[0]}` : 'Listing tags');
    case 'remote':
      return result(rest[0] === 'add' ? `Adding remote ${rest[1] ?? ''}`.trim() : 'Checking remotes');
    case 'worktree':
      return result({ add: 'Creating a worktree', remove: 'Removing a worktree', list: 'Listing worktrees', prune: 'Cleaning up worktrees' }[rest[0]] ?? 'Managing worktrees');
    case 'rm':
      return result(`Removing ${ops.map(f).slice(0, 2).join(', ') || 'files'} from git`);
    case 'mv':
      return result(ops.length === 2 ? `Renaming ${f(ops[0])} to ${f(ops[1])}` : 'Renaming files');
    case 'grep':
      return describeGrep('git grep', rest, f, false);
    case 'ls-files':
    case 'ls-tree':
      return result('Listing tracked files');
    case 'rev-parse':
    case 'rev-list':
    case 'merge-base':
    case 'describe':
    case 'name-rev':
    case 'symbolic-ref':
    case 'for-each-ref':
    case 'cat-file':
      return result('Inspecting the repository');
    case 'config':
      return result('Checking git settings');
    case 'init':
      return result('Creating a git repository');
    case 'clean':
      return result('Removing untracked files');
    case 'bisect':
      return result('Bisecting history');
    case 'submodule':
      return result('Updating submodules');
    case 'apply':
    case 'am':
      return result('Applying a patch');
    case 'format-patch':
      return result('Exporting a patch');
    default:
      return result(`Running git ${sub}`);
  }
}

function describeGh(args) {
  const [area, action, ...rest] = args;
  const ops = operands(rest);
  const num = ops.find((o) => /^#?\d+$/.test(o));
  const ref = num ? ` #${num.replace('#', '')}` : '';
  if (area === 'pr') {
    return result(
      {
        create: 'Opening a pull request',
        view: `Viewing pull request${ref}`,
        list: 'Listing pull requests',
        checks: `Checking CI on pull request${ref}`,
        merge: `Merging pull request${ref}`,
        diff: `Viewing the diff of pull request${ref}`,
        checkout: `Checking out pull request${ref}`,
        co: `Checking out pull request${ref}`,
        comment: `Commenting on pull request${ref}`,
        review: `Reviewing pull request${ref}`,
        edit: `Editing pull request${ref}`,
        close: `Closing pull request${ref}`,
        reopen: `Reopening pull request${ref}`,
        ready: `Marking pull request${ref} ready`,
        status: 'Checking pull request status',
      }[action] ?? 'Working with pull requests'
    );
  }
  if (area === 'issue') {
    return result({ create: 'Opening an issue', view: `Reading issue${ref}`, list: 'Listing issues', comment: `Commenting on issue${ref}`, close: `Closing issue${ref}`, edit: `Editing issue${ref}` }[action] ?? 'Working with issues');
  }
  if (area === 'run') return result({ list: 'Listing CI runs', view: 'Checking a CI run', watch: 'Watching a CI run', rerun: 'Re-running CI' }[action] ?? 'Checking CI runs');
  if (area === 'workflow') return result(action === 'run' ? 'Starting a workflow' : 'Checking workflows');
  if (area === 'release') return result({ create: 'Publishing a GitHub release', view: 'Viewing a release', list: 'Listing releases', edit: 'Editing a release', upload: 'Uploading release files' }[action] ?? 'Working with releases');
  if (area === 'repo') return result({ view: 'Viewing the repository', clone: 'Cloning a repository', create: 'Creating a repository', fork: 'Forking a repository' }[action] ?? 'Working with the repository');
  if (area === 'api') return result(`Calling the GitHub API${action && !action.startsWith('-') ? ` (${clip(action.replace(/^\/?repos\/[^/]+\/[^/]+\/?/, ''), 30) || 'repo'})` : ''}`);
  if (area === 'auth') return result('Checking GitHub sign-in');
  if (area === 'search') return result('Searching GitHub');
  return result(`Running gh ${area ?? ''}`.trim());
}

function describeDocker(args) {
  const [sub, action] = stripFlags(args);
  if (sub === 'compose' || sub === 'docker-compose') return result({ up: 'Starting containers', down: 'Stopping containers', build: 'Building containers', logs: 'Reading container logs', ps: 'Listing containers', exec: 'Running a command in a container' }[action] ?? 'Managing containers');
  return result({ build: 'Building a Docker image', run: 'Starting a container', ps: 'Listing containers', exec: 'Running a command in a container', logs: 'Reading container logs', pull: 'Pulling a Docker image', push: 'Pushing a Docker image', stop: 'Stopping a container', images: 'Listing Docker images' }[sub] ?? `Running docker ${sub ?? ''}`.trim());
}

// --- argv helpers ---

// Arguments that aren't flags, skipping the value of `-n 20`-style options.
function operands(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      out.push(...args.slice(i + 1));
      break;
    }
    if (/^-/.test(a)) {
      if (/^-[nABCmdeoItLX]$/.test(a) && args[i + 1] !== undefined && !/^-/.test(args[i + 1])) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

// Drop leading flags (and --flag=value) so the subcommand comes first.
function stripFlags(args) {
  const out = [...args];
  while (out[0]?.startsWith('-')) out.shift();
  return out;
}

function valueOf(args, names) {
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i])) return args[i + 1];
    for (const n of names) if (n.startsWith('--') && args[i].startsWith(`${n}=`)) return args[i].slice(n.length + 1);
  }
  return undefined;
}

// `head -n 20`, `head -20`, `head -n20`, `--lines=20`
function countArg(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '-n' || a === '-c') && /^\+?\d+$/.test(args[i + 1] ?? '')) return args[i + 1].replace('+', '');
    const m = a.match(/^-n?(\d+)$/) || a.match(/^--lines=(\d+)$/);
    if (m) return m[1];
  }
  return null;
}

function host(url) {
  try {
    const u = new URL(/^https?:/.test(url) ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '') + (u.hostname === 'localhost' || /^127\./.test(u.hostname) ? (u.port ? `:${u.port}` : '') : '');
  } catch {
    return clip(url, 40);
  }
}

// Paths relative to the project, and long ones shortened to their tail.
function short(p, cwd) {
  if (!p) return '';
  let s = cwd ? rel(p, cwd) : p;
  if (s.length > 48) {
    const parts = s.split(/[\\/]/).filter(Boolean);
    s = parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : clip(s, 48);
  }
  return s;
}
