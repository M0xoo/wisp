import test from 'node:test';
import assert from 'node:assert/strict';
import { describeCommand } from '../server/adapters/commands.js';

const cases = [
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
  assert.equal(describeCommand(undefined), 'Running ');
  assert.equal(describeCommand('echo "unterminated', '/repo'), 'Printing a message');
});

test('describeCommand keeps chains short', () => {
  assert.equal(describeCommand('npm install && npm run lint && npm test && npm run build', '/repo'), 'Installing dependencies, then linting (+2 more)');
});
