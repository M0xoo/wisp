import test from 'node:test';
import assert from 'node:assert/strict';
import { describeCommand } from '../src/commands/index.ts';

// v1 test/commands.test.js, case for case.
const cases: [string, string][] = [
  ['sed -n 15,50p server/a.js', 'Reading lines 15–50 of server/a.js'],
  ["sed -n '120,$p' /repo/web/js/app.js", 'Reading web/js/app.js from line 120 on'],
  ["sed -i '' 's#a#b#' x.js", 'Editing x.js'],
  ['cat package.json', 'Reading package.json'],
  ['head -n 40 README.md', 'Reading the first 40 lines of README.md'],
  ['tail -20 log.txt', 'Reading the last 20 lines of log.txt'],
  ['grep -rn "Running" server web/js | head -30', 'Searching for “Running” in server, web/js'],
  ["find . -name '*.test.js'", 'Finding *.test.js'],
  ['ls web/js', 'Listing web/js'],
  ['cd /repo && npm test', 'Running tests'],
  ['npm i -D playwright-core', 'Installing playwright-core'],
  ['npm run build', 'Building the project'],
  ['npx tsc --noEmit', 'Type-checking'],
  ['node --test test/a.test.js', 'Running tests'],
  ["python3 - <<'PY'\nimport json\nprint(1)\nPY", 'Running a Python script'],
  ['git status && git diff --stat', 'Checking git status, then summarising changes'],
  ['git show HEAD~1:server/a.js', 'Reading server/a.js at HEAD~1'],
  ["git commit -m 'feat: x\n\nbody'", 'Committing “feat: x”'],
  ['gh pr view 89 --json state', 'Viewing pull request #89'],
  ["cat > /repo/a.txt <<'EOF'\nhello\nrm -rf /\nEOF", 'Writing a.txt'],
  ["echo '---'; cat a.js", 'Reading a.js'],
  ['curl -fsSL localhost:3000/health', 'Fetching localhost:3000'],
  ['lsof -i :3000', 'Checking what is using port 3000'],
  ['make build', 'Building the project'],
  ["/bin/zsh -lc 'sed -n 1,20p a.js'", 'Reading lines 1–20 of a.js'],
  ['bash -lc "npm test 2>&1 | tail -30"', 'Running tests'],
  ['TZ=UTC timeout 60 npm test', 'Running tests'],
];

test('describeCommand turns common shell commands into English', () => {
  for (const [cmd, want] of cases) assert.equal(describeCommand(cmd, '/repo'), want, cmd);
});

test('describeCommand falls back to the raw command when it has nothing better', () => {
  assert.equal(describeCommand('foo --bar baz', '/repo'), 'Running foo --bar baz');
  assert.equal(describeCommand('for f in *.js; do echo $f; done', '/repo'), 'Running for f in *.js; do echo $f; done');
  assert.equal(describeCommand('', '/repo'), 'Running ');
  assert.equal(describeCommand(undefined, ''), 'Running ');
  assert.equal(describeCommand('echo "unterminated', '/repo'), 'Printing a message');
});

test('describeCommand keeps chains short', () => {
  assert.equal(describeCommand('npm install && npm run lint && npm test && npm run build', '/repo'), 'Installing dependencies, then linting (+2 more)');
});

// Not in v1: v1 looked subcommands up in plain objects, so `cargo constructor` said "function
// Object() { [native code] }" and `git status && cargo constructor` threw. The one deliberate
// difference from v1; the parity test's corpus has no such words.
test('describeCommand ignores Object.prototype names as subcommands', () => {
  assert.equal(describeCommand('cargo constructor', '/repo'), 'Running cargo constructor');
  assert.equal(describeCommand('go toString', '/repo'), 'Running go toString');
  assert.equal(describeCommand('git stash constructor', '/repo'), 'Stashing changes');
  assert.equal(describeCommand('git worktree valueOf', '/repo'), 'Managing worktrees');
  assert.equal(describeCommand('gh pr __proto__', '/repo'), 'Working with pull requests');
  assert.equal(describeCommand('docker hasOwnProperty', '/repo'), 'Running docker hasOwnProperty');
  assert.equal(describeCommand('docker compose toString', '/repo'), 'Managing containers');
  assert.equal(describeCommand('git status && cargo constructor', '/repo'), 'Checking git status, then running cargo constructor');
});

test('describeCommand reads paths through the resolved cwd too', () => {
  const paths = { cwd: '/tmp/x', real: '/private/tmp/x' };
  assert.equal(describeCommand('cat /private/tmp/x/src/a.js', paths), 'Reading src/a.js');
  assert.equal(describeCommand('cat /tmp/x/src/a.js', paths), 'Reading src/a.js');
  assert.equal(describeCommand('cat /private/tmp/x/src/a.js', '/tmp/x'), 'Reading /private/tmp/x/src/a.js');
});
