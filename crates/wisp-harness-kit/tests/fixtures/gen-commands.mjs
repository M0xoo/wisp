// Rebuilds the corpus of the TypeScript port's parity test (packages/harness-kit/test/commands-parity.test.ts
// at tag v2-ts-server-reference: the same literal scan over the same v1 files, the same seeded generator)
// and records v1's describeCommand answer for each command under the same three cwd forms, so the Rust
// port can be checked against v1 without Node (gate G6 for ticker labels).
//
//   node crates/wisp-harness-kit/tests/fixtures/gen-commands.mjs
//
// Writes commands.v1.json beside this file: `runs` says how each run spells @CWD@ / @REAL@ in a command
// and which RunPaths the Rust side passes; each line of `cases` is [command, v1 for run 0, run 1, run 2],
// or [command, v1] when the three agree.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../../../../', import.meta.url);
const { describeCommand } = await import(new URL('server/adapters/commands.js', root).href);

// --- the corpus ---

// Every string literal in v1's tests for commands and the fake CLIs. A naive scan pairs some quotes
// wrongly (apostrophes in comments); those odd strings are kept: any input must match.
function literals(file) {
  const p = fileURLToPath(new URL(file, root));
  if (!fs.existsSync(p)) return [];
  const src = fs.readFileSync(p, 'utf8');
  const out = [];
  for (const m of src.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.|\$(?!\{))*)`/g)) {
    const body = m[1] ?? m[2] ?? m[3] ?? '';
    out.push(body.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, e) => (e === 'n' ? '\n' : e === 't' ? '\t' : e.length === 5 ? String.fromCharCode(parseInt(e.slice(1), 16)) : e)));
  }
  return out;
}

// mulberry32: a fixed seed, so every run checks the same commands.
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FILES = ['a.js', 'src/a.ts', '/repo/web/js/app.js', '@CWD@/server/x.js', '@REAL@/lib/y.ts', '../out.txt', 'very/long/path/that/goes/on/and/on/forever/and/ever/and/ever/file.js', "'with space.txt'", '"C:\\Users\\me\\a.js"', 'dir/', '.', '@CWD@', '*.md'];
const fileSets = ['', 'a.js', 'src/a.ts web/b.css', 'a.js b.js c.js d.js', ...FILES];
const cross = (xs, ys) => xs.flatMap((x) => ys.map((y) => `${x} ${y}`.trim()));

function generated() {
  const out = [];
  const add = (...cs) => void out.push(...cs);
  // sed: -n ranges, in-place forms, scripts given with -e, and files.
  add(...cross(cross(['sed', 'gsed', 'sed -n', 'sed -ne', 'sed -E -n', "sed -i ''", 'sed -i', 'sed -i.bak', 'sed --in-place', 'sed -f x.sed'], ['15,50p', "'120,$p'", "'1p'", "'$p'", "'10, 20 p'", "'s/a/b/g'", "'s#a#b#'", "'/x/d'", "-e 's/a/b/'", '-e', "-e '3p'"]), fileSets.slice(0, 8)));
  // grep, rg and friends, alone and as filters.
  const greps = ['grep', 'grep -rn', 'grep -l', 'egrep -i', 'fgrep', 'rg', 'rg -n', 'rg --files', 'rg -g "*.ts"', 'rg -t js', 'ag', 'ack', 'git grep', 'grep -A 3', 'grep -C2', 'grep --include "*.js" -r', 'grep -e', 'grep -e foo -e bar', 'rg --type=ts', 'grep -m 1', 'rg -l --files-with-matches'];
  add(...cross(cross(greps, ['foo', '"Running"', "'a b'", 'a.b', '"a very long pattern that is longer than forty characters for sure"', '']), ['', 'server', 'server web/js', 'a b c d', '@CWD@/src']));
  add(...cross(['cat x | grep', 'ls | rg', 'git log | grep -i', 'ps aux | grep -v grep | grep'], ['node', '"a b"', '-e x', '']));
  // head, tail, cat and the other readers.
  add(...cross(cross(['head', 'tail'], ['', '-n 40', '-20', '-n20', '--lines=5', '-c 10', '-f', '-F', '-n +3', '-qf', '-n']), fileSets.slice(0, 6)));
  add(...cross(['cat', 'bat', 'less', 'more', 'nl', 'awk', "awk '{print $1}'", 'gawk -F,', 'wc', 'wc -l', 'sort', 'uniq -c', 'cut -d: -f1', 'tr a b', 'column -t', 'jq .', "jq '.a'", 'yq', 'diff', 'cmp', 'colordiff', 'stat', 'file', 'du -sh', 'df -h', 'mkdir -p', 'touch', 'rm -rf', 'rmdir', 'trash', 'mv', 'cp -r', 'rsync -a', 'ln -s', 'chmod +x', 'chown me', 'tee', 'tee -a', 'tar -czf x.tgz', 'tar xzf', 'tar -xf', 'unzip', 'gunzip', '7z x', 'zip -r x.zip', 'open', 'xdg-open', 'ls', 'ls -la', 'eza', 'exa', 'tree', 'tree -L 2'], fileSets));
  add(...cross(['find', 'fd'], ['', '.', 'src', '. -name "*.js"', 'src -iname x', '. -path "*/node_modules/*" -prune', '. -name "*.log" -delete', '-name a.js', 'pattern', 'pattern src', '. -type f', '@CWD@/web -name "*.css"']));
  for (const w of ['echo', 'printf', 'cat', 'tee']) add(...cross([`${w} hi >`, `${w} hi >>`, `${w} '---' 1>`, `${w} x 2>`, `${w} x &>`, `${w} x >`], ['out.txt', '/dev/null', '@CWD@/a.txt', '@REAL@/b.txt']));
  // git, every subcommand with typical flags, behind global options.
  const gitSubs = ['', 'status', 'status --short', 'diff', 'diff --stat', 'diff --name-only', 'diff --cached', 'diff --staged a.js', 'diff a.js', 'diff main..HEAD', 'diff HEAD~1', 'diff -- src/a.ts web/b.js c.js', 'log', 'log --oneline -5', 'log -- src/a.js', 'log main..HEAD', 'log -p a.js', 'shortlog -sn', 'reflog', 'show', 'show HEAD~1:server/a.js', 'show :a.js', 'show abcdef1234567890abcdef1234', 'show HEAD --stat', 'blame a.js', 'blame -L 1,20 src/a.ts', 'blame', 'add .', 'add -A', 'add --all', 'add a.js b.js c.js', 'add', 'add -p', "commit -m 'feat: x\n\nbody'", 'commit -m', 'commit --amend', 'commit --message=hello', 'commit -am "fix: y"', 'commit', 'push', 'push --tags', 'push origin main', 'push -u origin feature/a-very-long-branch-name-that-goes-on', 'pull', 'pull --rebase', 'fetch', 'fetch origin', 'clone https://github.com/a/b.git', 'clone git@github.com:a/b.git', 'clone', 'clone https://www.example.com/x', 'checkout main', 'checkout -b feat/x', 'checkout -- a.js', 'checkout --', 'checkout', 'switch -c y', 'switch dev', 'switch -C', 'restore a.js', 'restore --staged .', 'restore', 'branch', 'branch -d x', 'branch -D', 'branch -m a b', 'branch new', 'branch -a', 'branch --show-current', 'branch -vv', 'merge main', 'merge --abort', 'merge --continue', 'merge', 'rebase main', 'rebase -i HEAD~3', 'rebase --abort', 'rebase --continue', 'rebase', 'cherry-pick abc', 'cherry-pick --abort', 'cherry-pick --continue', 'cherry-pick', 'revert HEAD', 'revert', 'reset --hard', 'reset a.js', 'reset', 'reset HEAD~1', 'stash', 'stash pop', 'stash apply', 'stash list', 'stash drop', 'stash show -p', 'stash push -m x', 'tag', 'tag v1.0', 'tag -l', 'tag --list', 'remote -v', 'remote add origin x', 'remote add', 'worktree add ../x', 'worktree remove x', 'worktree list', 'worktree prune', 'worktree', 'rm a.js', 'rm --cached -r dir', 'rm', 'mv a.js b.js', 'mv a', 'grep foo', 'grep -n foo -- src', 'ls-files', 'ls-tree HEAD', 'rev-parse HEAD', 'rev-list --count HEAD', 'merge-base a b', 'describe --tags', 'name-rev HEAD', 'symbolic-ref HEAD', 'for-each-ref', 'cat-file -p HEAD', 'config user.name', 'init', 'clean -fd', 'bisect start', 'submodule update --init', 'apply x.patch', 'am x.patch', 'format-patch -1', 'notes', 'lfs pull'];
  add(...cross(['git', 'git -C @CWD@/sub', 'git -c core.pager=cat', 'git --no-pager', 'git --git-dir .git --work-tree .', '/usr/bin/git', 'git -C'], gitSubs));
  // gh: every area and action, with and without a number.
  const ghAreas = {
    pr: ['create', 'view', 'list', 'checks', 'merge', 'diff', 'checkout', 'co', 'comment', 'review', 'edit', 'close', 'reopen', 'ready', 'status', 'other', ''],
    issue: ['create', 'view', 'list', 'comment', 'close', 'edit', 'other', ''],
    run: ['list', 'view', 'watch', 'rerun', 'other', ''],
    workflow: ['run', 'list', ''],
    release: ['create', 'view', 'list', 'edit', 'upload', 'other', ''],
    repo: ['view', 'clone', 'create', 'fork', 'other', ''],
    api: ['repos/a/b/pulls', '/repos/a/b', 'repos/a/b/', 'user', '-X', 'graphql', 'repos/owner/repo/actions/runs/123456789/jobs/987654321', ''],
    auth: ['status', ''],
    search: ['issues', ''],
    gist: ['list'],
    '': [''],
  };
  for (const [area, actions] of Object.entries(ghAreas)) add(...cross(actions.map((a) => `gh ${area} ${a}`), ['', '89', '#12', '89 --json state', '--repo a/b 7', '-R x']));
  // Package managers, runners and the tools they run.
  const pmSubs = ['', 'i', 'install', 'ci', 'add', 'install -D playwright-core', 'i react react-dom', 'add -D a b c d e f g h i j k l m n o p', 'un x', 'uninstall a b', 'remove', 'rm x', 'up', 'update', 'upgrade', 't', 'test', 'tst', 'run', 'run build', 'run test:unit', 'run lint:fix', 'run dev', 'run-script start', 'run e2e', 'run docs', 'run bench', 'run deploy:prod', 'run release', 'run clean', 'run setup', 'run typecheck', 'run fmt', 'run custom', 'run npm:test', 'run test-watch', 'exec tsc', 'exec -- vitest', 'dlx create-vite', 'x eslint --fix', 'exec', 'start', 'publish', 'version', 'version patch', 'pack', 'outdated', 'audit', 'ls', 'list', 'why x', 'explain y', 'view react', 'info', 'show x', 'init', 'create vite', 'link', 'config get x', '-v', '--version', '-v foo', '--silent test', '-w run build', 'build', 'lint', 'dev', 'something', 'constructorx'];
  add(...cross(['npm', 'pnpm', 'yarn', 'bun', 'pnpm -r', 'npm --prefix web'], pmSubs));
  const tools = ['', 'tsc', 'tsc --noEmit', 'tsc -w', 'tsc@5 --watch', 'vue-tsc', 'jest', 'vitest --watch', 'vitest run', 'mocha', 'ava', 'tap', 'pytest -x', 'playwright test', 'playwright install', 'cypress run', 'karma', 'jasmine', 'uvu', 'eslint .', 'eslint --fix .', 'biome check', 'biome format', 'oxlint', 'stylelint', 'ruff check', 'ruff format', 'flake8', 'pylint x', 'golangci-lint run', 'rubocop', 'shellcheck x.sh', 'standard', 'xo', 'prettier --write .', 'prettier --check .', 'black .', 'isort -c', 'gofmt -l', 'rustfmt', 'dprint fmt', 'clang-format -i x.c', 'vite', 'vite build', 'vite preview', 'next dev', 'next build', 'next lint', 'nuxt test', 'astro typecheck', 'webpack', 'webpack --mode production', 'rollup -c', 'esbuild x.ts', 'parcel', 'tsup', 'turbo run build', 'turbo lint', 'nx test', 'svelte-kit sync', 'remix dev', 'mypy .', 'pyright', 'electron .', 'electron-builder', 'electron-forge make', 'serve -s dist', 'http-server', 'prisma migrate dev', 'prisma generate', 'drizzle-kit push', 'drizzle-kit generate', 'create-react-app x', 'create-next-app@latest', '@scope/tool@1.2', './scripts/x.sh', '../bin/run', 'scripts/build.mjs', 'tool.py', 'cowsay hi', '-y cowsay', '--yes tsc'];
  add(...cross(['npx', 'bunx', 'pnpx', 'pnpm exec', 'yarn dlx', 'uv run', 'poetry run', 'pipenv run', ''], tools));
  add(...cross(['node', 'deno', 'tsx', 'ts-node', '/usr/local/bin/node'], ['', 'test', '--test test/a.test.js', '-e "1+1"', '--eval x', '-p 1', '--print x', '--version', '-v', 'server/index.js', '@CWD@/scripts/run.mjs', '--inspect app.js', '-r dotenv/config x.js']));
  add(...cross(['python', 'python3', 'py', '/usr/bin/python3'], ['', '-c "print(1)"', '-m pytest', '-m unittest', '-m pip install x', '-m pip', '-m venv .venv', '-m virtualenv v', '-m http.server 8000', '-m json.tool', '-m black .', '-m mypy x', '-m foo', '-m', '--version', '-V', 'x.py', '-u x.py', '-I -B script.py', '-', '- < in.py', '< @CWD@/data.py', 'manage.py runserver', "- <<'PY'\nimport json\nprint(1)\nPY"]));
  add(...cross(['uv', 'poetry', 'pipenv', 'pip', 'pip3', 'uv pip', 'python -m pip'], ['', 'add x', 'sync', 'install', 'install x y', 'install -r requirements.txt', 'install -e .', 'lock', 'uninstall x', 'list', 'freeze', 'show x', 'run', 'run pytest', 'run x.py', 'pip install x', 'cache', '--quiet install z']));
  add(...cross(['cargo', 'go'], ['', 'build', 'b', 'test', 't', 'run', 'r', 'check', 'c', 'clippy', 'fmt', 'add serde', 'install x', 'bench', 'doc', 'vet ./...', 'get x', 'mod tidy', 'mod download', 'generate ./...', 'tool pprof', 'update']));
  add(...cross(['make', 'just', 'task', 'make -j4', 'make -C sub'], ['', 'test', 'tests', 'spec', 'test:unit', 'test-e2e', 'test_x', 'build', 'compile', 'bundle', 'dist', 'package', 'lint', 'eslint', 'lint:fix', 'format', 'fmt', 'prettier', 'typecheck', 'type-check', 'types', 'tsc', 'check-types', 'dev', 'start', 'serve', 'watch', 'preview', 'clean', 'install', 'deps', 'setup', 'bootstrap', 'release', 'publish', 'deploy', 'deploy:prod', 'bench', 'benchmark', 'e2e', 'integration', 'doc', 'docs', 'all', 'npm:test', 'yarn:build']));
  add(...cross(['docker', 'podman', 'docker --context x'], ['', 'build -t x .', 'run --rm img', 'ps', 'ps -a', 'exec -it c sh', 'logs -f c', 'pull x', 'push x', 'stop c', 'images', 'rm c', 'compose up -d', 'compose down', 'compose build', 'compose logs', 'compose ps', 'compose exec web sh', 'compose restart', 'compose', 'docker-compose up']));
  add(...cross(['brew'], ['', 'install x', 'install x y', 'upgrade', 'reinstall z', 'list', 'update', 'doctor']));
  // Shell built-ins, system tools, nested shells and agent CLIs.
  add(...['cd', 'cd /repo', 'cd @CWD@/web', 'cd ..', 'pushd x', 'popd', 'export A=1', 'set -e', 'unset X', 'source .env', '. ./x.sh', 'true', 'false', 'shift', 'local a', 'read x', 'trap x EXIT', ':', 'for f in *', 'case $x in', 'echo hi', 'printf "%s" x', 'pwd', 'curl -fsSL localhost:3000/health', 'curl https://www.example.com/a', 'curl -s http://127.0.0.1:8080/x', 'wget example.com', 'http GET api.github.com/x', 'xh :3000', 'curl', 'curl -X POST -d @f', 'curl http://[bad', 'sleep 5', 'sleep 0.5', 'sleep', 'sleep 1m', 'wait', 'until curl -s localhost:3000', 'while true', 'while', 'until', 'while foo bar', 'while [ -f x ]', 'if [ -f x ]', 'test -f x', '[ -d y ]', '[[ -n x ]]', 'ps aux', 'pgrep node', 'top -l 1', 'htop', 'kill 123', 'pkill -f vite', 'killall node', 'lsof -i :3000', 'lsof -i tcp:8080', 'lsof :5173', 'lsof -p 1', 'which node', 'whereis git', 'type -a ls', 'which', '/usr/bin/env', 'printenv PATH', 'uname -a', 'sw_vers', 'hostname', 'whoami', 'id -u', 'date', 'ssh user@host', 'ssh -i key host', 'ssh', 'scp a host:b', 'claude -p hi', 'codex exec x', 'gemini', 'cursor-agent', 'opencode run', 'bash x.sh', 'sh', 'zsh -c "npm test"', "bash -lc 'git status --short'", 'bash -c', 'sh -c "foo bar"', '/bin/bash -lc "sed -n 1,20p a.js"', 'foo --bar baz', 'some-unknown-tool with args', "''", '""', '$(git rev-parse --show-toplevel)/x.sh', '`which node` x.js', '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "npm test"', 'powershell -Command "Get-ChildItem"', 'pwsh -c ls', 'cmd /c dir', 'C:\\tools\\x.exe /q']);
  return out;
}

// Chains, pipes, wrappers, redirects and shell shapes over the generated commands, seeded.
function composed(base, n) {
  const rnd = random(0x5eed);
  const pickOne = (xs) => xs[Math.floor(rnd() * xs.length)];
  const wrappers = ['', '', 'sudo ', 'sudo -E ', 'time ', 'nohup ', 'FOO=1 ', 'A=1 B=2 ', 'env -i A=b ', 'env ', 'timeout 60 ', 'timeout -k 5 60 ', 'gtimeout 10 ', 'xargs ', 'xargs -n 1 ', 'xargs -I {} ', 'nice -n 10 ', 'command ', 'exec ', 'caffeinate -i ', 'stdbuf -oL ', 'unbuffer ', '! ', 'then ', 'do '];
  const suffixes = ['', '', ' 2>&1', ' > out.txt', ' >> @CWD@/log.txt', ' 2>/dev/null', ' >/dev/null 2>&1', ' | head -30', ' | grep foo', ' | tail -5', ' | sort | uniq -c', ' &> all.log', ' &>> all.log', ' < in.txt', ' &', ' | jq .', ' | wc -l', ' | sed -n 1,5p', ' 2> err.txt', ' 1>&2', ' | tee out.log'];
  const joins = [' && ', ' || ', '; ', '\n', ' | ', ' & ', ' && \\\n  '];
  const shapes = [
    (c) => c,
    (c) => `bash -lc '${c.replace(/'/g, `'\\''`)}'`,
    (c) => `/bin/zsh -lc ${JSON.stringify(c)}`,
    (c) => `sh -c "${c}"`,
    (c) => `cd @CWD@/sub && ${c}`,
    (c) => `cd x; ${c}`,
    (c) => `(cd web && ${c})`,
    (c) => `{ ${c}; }`,
    (c) => `echo ---; ${c}; echo ---`,
    (c) => `if [ -f x ]; then ${c}; fi`,
    (c) => `while true; do ${c}; sleep 1; done`,
    (c) => `until ${c}; do sleep 1; done`,
    (c) => `for f in *.js; do ${c} $f; done`,
    (c) => `x=$(${c})`,
    (c) => `${c} <<'EOF'\nline one\nrm -rf /\nEOF`,
    (c) => `cat <<EOF > @CWD@/f.txt\n${c}\nEOF\n${c}`,
    (c) => `${c} <<-END\n\tbody\n\tEND`,
    (c) => `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "${c}"`,
  ];
  const one = () => pickOne(wrappers) + pickOne(base) + pickOne(suffixes);
  const out = [];
  for (let i = 0; i < n; i++) {
    const parts = [one()];
    const more = Math.floor(rnd() * 4);
    for (let k = 0; k < more; k++) parts.push(pickOne(joins), one());
    out.push(pickOne(shapes)(parts.join('')));
  }
  return out;
}

function corpus() {
  const fromV1 = ['test/commands.test.js', 'test/adapters.test.js', 'test/fixtures/fake-agent.mjs'].flatMap(literals);
  const base = generated();
  return [...new Set([...fromV1, ...base, ...composed(base, 4000)])];
}


// --- the runs ---

// v1 resolves the cwd on disk (realpath), so the folder of run 1 must exist; a fixed name keeps the
// fixture stable (/tmp is /private/tmp on macOS, so its two spellings differ there).
const tmp = '/tmp/wisp-commands-g6';
fs.mkdirSync(tmp, { recursive: true });
const realOf = (dir) => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
};
// sub: how @CWD@ / @REAL@ are spelled in the commands; v1: the cwd v1 gets; paths: the Rust RunPaths
// (cwd '' = don't relativise, as v1 does with no cwd).
const runs = [
  { name: "cwd '/repo'", sub: { cwd: '/repo', real: '/private/repo' }, v1: '/repo', paths: { cwd: '/repo', real: realOf('/repo') } },
  { name: `cwd '${tmp}'`, sub: { cwd: tmp, real: realOf(tmp) }, v1: tmp, paths: { cwd: tmp, real: realOf(tmp) } },
  { name: 'no cwd', sub: { cwd: '/repo', real: '/private/repo' }, v1: undefined, paths: { cwd: '', real: '' } },
];

const commands = corpus();
const lines = commands.map((c) => {
  const outs = runs.map((run) => {
    const cmd = c.replaceAll('@CWD@', run.sub.cwd).replaceAll('@REAL@', run.sub.real);
    const out = describeCommand(cmd, run.v1);
    if (typeof out !== 'string') throw new Error(`v1 answered ${typeof out} for ${JSON.stringify(cmd)}`);
    return out;
  });
  // One answer when the three runs agree (most do), keeping the file small.
  return JSON.stringify(outs.every((o) => o === outs[0]) ? [c, outs[0]] : [c, ...outs]);
});
const runsJson = runs.map(({ name, sub, paths }) => JSON.stringify({ name, sub, paths }));
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'commands.v1.json');
fs.writeFileSync(file, `{"runs": [\n${runsJson.join(',\n')}\n],\n"cases": [\n${lines.join(',\n')}\n]}\n`);
console.log(`${commands.length} commands x ${runs.length} cwd forms -> ${path.relative(fileURLToPath(root), file)}`);
