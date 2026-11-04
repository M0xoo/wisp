// Review by another harness (server/services/review.js): who reviews, what a reply becomes, and
// that the setting's values are the ones spells may use. The flow itself (ship → review on the PR
// head → summary) runs through a real server in test/ship.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { diffOf, diffSections } from '../server/judge.js';
import { HARNESSES, REVIEW_VALUES, authorsOf, constraintsFor, fitDiff, partialSummary, pickReviewer, readReview, reviewPrompt, reviewView } from '../server/services/review.js';
import { SETTINGS } from '../web/js/spell-schema.js';
import { makeRepo } from './helpers.js';

const agents = (...ids) => ids.map((id) => ({ id, name: id === 'codex' ? 'Codex' : id, available: true }));

test('another harness than the author: never the one that wrote it, in a fixed order', () => {
  assert.deepEqual(pickReviewer('other', ['claude'], agents('claude', 'codex')), { agent: 'codex', model: '' });
  assert.deepEqual(pickReviewer('other', ['codex'], agents('claude', 'codex')), { agent: 'claude', model: '' });
  // Every harness that wrote a turn is an author.
  assert.deepEqual(pickReviewer('other', ['claude', 'codex'], agents('claude', 'codex', 'copilot')), { agent: 'copilot', model: '' });
  assert.match(pickReviewer('other', ['claude'], agents('claude')).why, /No other harness/);
  // Installed but not available (signed out, missing) doesn't count.
  assert.match(pickReviewer('other', ['claude'], [{ id: 'claude', available: true }, { id: 'codex', available: false }]).why, /No other harness/);
});

test('a picked harness reviews even its own work; off and missing say why', () => {
  assert.deepEqual(pickReviewer('claude', ['claude'], agents('claude', 'codex')), { agent: 'claude', model: '' });
  assert.match(pickReviewer('codex', ['claude'], [{ id: 'codex', name: 'Codex', available: false }]).why, /Codex isn't installed/);
  assert.match(pickReviewer('off', [], agents('claude')).why, /off/);
});

test('authors: the turns’ harnesses, not Auto or wisp', () => {
  assert.deepEqual(authorsOf({ agent: 'auto', turns: [{ agent: 'claude' }, { agent: 'codex' }, { agent: 'claude' }] }), ['claude', 'codex']);
  assert.deepEqual(authorsOf({ agent: 'codex', turns: [{}] }), ['codex']);
});

test('a reply becomes findings, high first; junk is null', () => {
  const r = readReview({ summary: 's', findings: [{ severity: 'low', text: 'nit' }, { severity: 'high', file: 'a.js', line: '12', text: 'bug' }, { text: '' }, { severity: 'odd', text: 'x', line: -1 }] });
  assert.equal(r.summary, 's');
  assert.deepEqual(r.findings, [{ severity: 'high', file: 'a.js', line: 12, text: 'bug' }, { severity: 'medium', text: 'x' }, { severity: 'low', text: 'nit' }]);
  assert.equal(readReview({ findings: [] }).summary, 'Nothing to fix.');
  assert.equal(readReview(null), null);
  assert.equal(readReview({ summary: 'no list' }), null);
  assert.equal(readReview({ findings: Array.from({ length: 40 }, () => ({ text: 'x' })) }).findings.length, 20);
});

test('the prompt carries the diff and the tests on the head; the view says if it is of the head', () => {
  const p = reviewPrompt({ title: 'fix "add"', task: 'Fix add', diff: '+a', tests: { verdict: 'fail', command: 'npm test', output: 'boom' } });
  assert.match(p, /You review a pull request another coding agent wrote/);
  assert.match(p, /<tests command="npm test" verdict="fail">\nboom/);
  assert.match(p, /<diff>\n\+a\n<\/diff>/);
  assert.doesNotMatch(reviewPrompt({ diff: '', tests: { verdict: 'skip' } }), /<tests/);
  const s = { pr: { head: 'abc' }, review: { status: 'done', head: 'abc', findings: [], at: 1 } };
  assert.equal(reviewView(s).current, true);
  assert.equal(reviewView({ ...s, pr: { head: 'def' } }).current, false);
  assert.equal(reviewView({}), null);
});

test('the prompt carries what the user ruled out and Done when; none, no block', () => {
  const s = {
    turns: [
      { prompt: 'Fix the login redirect. Don\u2019t touch migrations/, they are shared with prod.\n- only change web/ and server/auth' },
      { prompt: 'Never touch migrations', by: 'wisp' }, // wisp's carry-on, not the user
      { prompt: 'Also leave the tests alone', goal: true }, // a goal round
    ],
    goal: { text: 'logging in   lands on /home', status: 'out' },
  };
  const c = constraintsFor(s);
  assert.deepEqual(c, ["Don't touch migrations/, they are shared with prod.", 'only change web/ and server/auth', 'Done when: logging in lands on /home']);
  const p = reviewPrompt({ diff: '+a', constraints: c });
  assert.match(p, /<constraints>\n[^]*Touched migrations\/ — you said: don't touch migrations[^]*\n1\. Don't touch migrations\/, they are shared with prod\.\n2\. only change web\/ and server\/auth\n3\. Done when: logging in lands on \/home\n<\/constraints>/);
  assert.match(p, /"constraint": 1/);
  assert.ok(p.indexOf('<constraints>') < p.indexOf('<diff>'));
  assert.deepEqual(constraintsFor({ turns: [{ prompt: 'Fix the login redirect.' }] }), []);
  assert.doesNotMatch(reviewPrompt({ diff: '+a' }), /<constraints>|"constraint"/);
  assert.deepEqual(constraintsFor(undefined), []);
});

test('a finding that breaks a constraint is high and carries the user’s words; a bad number is a plain finding', () => {
  const c = ["Don't touch migrations/", 'Done when: login works'];
  const r = readReview(
    {
      summary: 's',
      findings: [
        { severity: 'low', file: 'src/a.js', text: 'nit' },
        { severity: 'medium', file: 'migrations/004_users.sql', line: 3, text: 'Touched migrations/ — you said: don’t touch migrations', constraint: 1 },
        { severity: 'low', text: 'made up', constraint: 9 },
        { severity: 'low', text: 'not a number', constraint: 'one' },
      ],
    },
    c,
  );
  assert.deepEqual(r.findings[0], { severity: 'high', file: 'migrations/004_users.sql', line: 3, text: 'Touched migrations/ — you said: don’t touch migrations', constraint: 1, rule: "Don't touch migrations/" });
  assert.deepEqual(r.findings.slice(1).map((f) => [f.severity, f.constraint, f.rule]), [['low', undefined, undefined], ['low', undefined, undefined], ['low', undefined, undefined]]);
  // Without constraints sent, a reviewer's constraint number means nothing.
  assert.equal(readReview({ findings: [{ severity: 'low', text: 'x', constraint: 1 }] }).findings[0].severity, 'low');
  // The page sees what was checked.
  const v = reviewView({ pr: { head: 'h' }, review: { status: 'done', head: 'h', findings: r.findings, constraints: c, at: 1 } });
  assert.deepEqual(v.constraints, c);
  assert.equal(reviewView({ pr: { head: 'h' }, review: { status: 'done', head: 'h', findings: [], at: 1 } }).constraints, undefined);
});

test('the setting’s values are the spell schema’s', () => {
  assert.deepEqual(SETTINGS.review, REVIEW_VALUES);
  assert.deepEqual(REVIEW_VALUES, ['off', 'other', ...HARNESSES]);
});

// A file's section as `git diff` prints it, with hunks of the given sizes.
const section = (p, ...hunks) => ({
  path: p,
  text: `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n${hunks.map((n, i) => `@@ -${i},1 +${i},1 @@\n+${'x'.repeat(n)}\n`).join('')}`,
});
const committed = (dir) => {
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'more'], { cwd: dir, stdio: 'ignore' });
};

test('fitDiff: everything fits, nothing is left out and the sections stay whole', () => {
  const a = section('a.js', 10);
  const b = section('b.js', 10);
  const { diff, coverage } = fitDiff({ sections: [a, b], files: ['a.js', 'b.js'] });
  assert.equal(diff, a.text + b.text);
  assert.deepEqual(coverage, { files: 2, seen: 2, chars: diff.length, seenChars: diff.length, cut: [], missing: [] });
});

test('fitDiff: a file that does not fit is skipped, not the end of the diff', () => {
  const small = (i) => section(`s${i}.js`, 50);
  const huge = { path: 'lock.json', text: `diff --git a/lock.json b/lock.json\nBinary-ish, no hunks ${'x'.repeat(5000)}\n` };
  const sections = [small(1), huge, small(2), small(3)];
  const { diff, coverage } = fitDiff({ sections, files: sections.map((s) => s.path) }, 1000);
  for (const s of [small(1), small(2), small(3)]) assert.ok(diff.includes(s.text));
  assert.doesNotMatch(diff, /lock\.json/);
  assert.equal(coverage.seen, 3);
  assert.deepEqual(coverage.missing, ['lock.json']);
  assert.equal(coverage.seenChars, diff.length);
  assert.ok(coverage.chars > coverage.seenChars);
});

test('fitDiff: one oversized file is cut on a hunk boundary and listed as cut', () => {
  const big = section('big.js', 400, 400, 5000, 100);
  const { diff, coverage } = fitDiff({ sections: [big], files: ['big.js'] }, 1100);
  assert.ok(diff.length <= 1100);
  assert.match(diff, /^diff --git a\/big\.js b\/big\.js\n--- a\/big\.js\n\+\+\+ b\/big\.js\n@@ -0,1/);
  // Never half a hunk: each header is followed by all of its line, and the 5000 is skipped whole.
  assert.deepEqual(diff.match(/^@@ -\d/gm), ['@@ -0', '@@ -1', '@@ -3']);
  assert.ok(diff.endsWith(`+${'x'.repeat(100)}\n`));
  assert.deepEqual([coverage.seen, coverage.cut, coverage.missing], [0, ['big.js'], []]);
});

test('fitDiff: no hunk fits, or it has none: nothing of the file, not its header alone', () => {
  const { diff, coverage } = fitDiff({ sections: [section('big.js', 5000)], files: ['big.js'] }, 1000);
  assert.equal(diff, '');
  assert.deepEqual([coverage.seen, coverage.cut, coverage.missing], [0, [], ['big.js']]);
});

test('fitDiff: a new file over its 4000 chars counts as cut even when it fits', () => {
  const { diff, coverage } = fitDiff({ sections: [{ path: 'new.js', text: '\n--- /dev/null\n+++ b/new.js\n+a', cut: true }], files: ['new.js'] });
  assert.match(diff, /new\.js/);
  assert.deepEqual([coverage.seen, coverage.cut], [0, ['new.js']]);
});

test('fitDiff: at most 50 names in all, and `more` counts the rest; it is left out at 0', () => {
  const names = (n, at) => Array.from({ length: n }, (_, i) => `${at}${i}.js`);
  const cut = names(10, 'c').map((p) => ({ path: p, text: 'x', cut: true }));
  const { coverage } = fitDiff({ sections: cut, files: [...names(10, 'c'), ...names(60, 'm')] });
  assert.equal(coverage.cut.length, 10);
  assert.equal(coverage.missing.length, 40);
  assert.equal(coverage.more, 20);
  assert.equal(coverage.files, 70);
  assert.equal('more' in fitDiff({ sections: [], files: names(50, 'm') }).coverage, false);
});

test('fitDiff: a path with two sections is seen only if both are', () => {
  const twice = [section('a.js', 10), { ...section('a.js', 5000), path: 'a.js' }];
  const { coverage } = fitDiff({ sections: twice, files: ['a.js'] }, 1000);
  assert.deepEqual([coverage.files, coverage.seen, coverage.cut], [1, 0, ['a.js']]);
});

test('diffSections: one section per file, renames and spaces and non-ASCII names read right', () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, 'old name.js'), 'one\ntwo\nthree\nfour\nfive\nsix\n');
  fs.writeFileSync(path.join(dir, 'a b.js'), '1\n');
  fs.writeFileSync(path.join(dir, 'é.js'), '1\n');
  committed(dir);
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  fs.renameSync(path.join(dir, 'old name.js'), path.join(dir, 'new name.js'));
  fs.appendFileSync(path.join(dir, 'a b.js'), 'diff --git a/fake b/fake\n'); // shows with a + in front
  fs.appendFileSync(path.join(dir, 'é.js'), '2\r\ndiff --git a/fake b/fake\n'); // a bare line end inside the hunk
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  const { sections, files, failed } = diffSections(dir, base);
  assert.equal(failed, undefined);
  assert.deepEqual(sections.map((s) => s.path).sort(), ['a b.js', 'new name.js', 'é.js'].sort());
  assert.deepEqual([...files].sort(), ['a b.js', 'new name.js', 'é.js'].sort());
  assert.equal(fitDiff({ sections, files }).coverage.seen, 3);
  assert.equal(sections.map((s) => s.text).join(''), diffOf(dir, base));
});

test('diffOf keeps its shape: tracked diff, then each new file after a /dev/null header, cut at 4000', () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, 'n.txt'), 'a\nb');
  fs.writeFileSync(path.join(dir, 'z.txt'), 'y'.repeat(5000));
  const tracked = execFileSync('git', ['diff', 'HEAD', '--', '.', ':(exclude)node_modules'], { cwd: dir }).toString();
  assert.equal(diffOf(dir), `${tracked}\n--- /dev/null\n+++ b/n.txt\n+a\n+b\n--- /dev/null\n+++ b/z.txt\n+${'y'.repeat(4000)}`);
  const z = diffSections(dir).sections.at(-1);
  assert.deepEqual([z.path, z.cut], ['z.txt', true]);
});

test('diffSections: new files past the first 30 are listed, so they show as missing', () => {
  const dir = makeRepo();
  for (let i = 0; i < 35; i++) fs.writeFileSync(path.join(dir, `n${String(i).padStart(2, '0')}.txt`), 'x');
  const { coverage } = fitDiff(diffSections(dir));
  assert.equal(coverage.files, 36); // math.js too
  assert.equal(coverage.seen, 31);
  assert.deepEqual(coverage.missing, ['n30.txt', 'n31.txt', 'n32.txt', 'n33.txt', 'n34.txt']);
});

test('diffSections: a node_modules link is no change, or every wisp worktree would read as partial', () => {
  const dir = makeRepo();
  fs.symlinkSync(path.dirname(dir), path.join(dir, 'node_modules'));
  const { coverage } = fitDiff(diffSections(dir));
  assert.deepEqual([coverage.files, coverage.seen, coverage.missing], [1, 1, []]);
});

test('a diff git would not give: changed files read 0 seen, and never "(no changes)"', () => {
  const { diff, coverage } = fitDiff({ sections: [], files: ['a.js', 'b.js'] });
  assert.equal(diff, '');
  assert.deepEqual([coverage.files, coverage.seen, coverage.missing], [2, 0, ['a.js', 'b.js']]);
  const p = reviewPrompt({ diff, coverage });
  assert.doesNotMatch(p, /\(no changes\)/);
  assert.match(p, /holds 0 of 2 files whole/);
  // git answered nothing at all: run() fails the review rather than review an empty list.
  assert.equal(diffSections(makeRepo(), 'no-such-ref').failed, true);
  assert.match(reviewPrompt({ diff: '', coverage: fitDiff({ sections: [], files: [] }).coverage }), /\(no changes\)/);
});

test('the prompt says when the diff is partial, before the diff; a whole one has no block', () => {
  const coverage = { files: 63, seen: 41, chars: 90000, seenChars: 60000, cut: ['a.js'], missing: ['b.js', 'c.js'], more: 19 };
  const p = reviewPrompt({ diff: '+a', coverage });
  assert.ok(p.indexOf('<partial>') < p.indexOf('<diff>'));
  assert.match(p, /holds 41 of 63 files whole/);
  assert.match(p, /Only part of: a\.js\nNot in it: b\.js, c\.js\nAnd 19 files not named here\./);
  assert.match(p, /working directory/);
  assert.match(p, /covers only what you read/);
  assert.doesNotMatch(reviewPrompt({ diff: '+a', coverage: { files: 2, seen: 2, chars: 2, seenChars: 2, cut: [], missing: [] } }), /<partial>/);
  assert.doesNotMatch(reviewPrompt({ diff: '+a' }), /<partial>/);
});

test('the summary of a partial review with no findings is wisp’s own', () => {
  assert.equal(partialSummary({ files: 63, seen: 41, cut: ['a.js'] }), 'No issues in what it read.');
  assert.equal(partialSummary({ files: 1, seen: 0, cut: ['big.js'] }), 'No issues in the part it read.');
  assert.equal(partialSummary({ files: 3, seen: 0, cut: ['a.js', 'b.js', 'c.js'] }), 'No issues in the parts it read.');
  assert.equal(partialSummary({ files: 63, seen: 0, cut: [] }), 'No issues found, but it read nothing.');
});

test('reviewView passes coverage through; a review from before it was recorded reads as it did', () => {
  const coverage = { files: 2, seen: 1, chars: 9, seenChars: 4, cut: [], missing: ['b.js'] };
  const s = { pr: { head: 'abc' }, review: { status: 'done', head: 'abc', summary: 'Fine', findings: [], at: 1 } };
  assert.deepEqual(reviewView(s), { status: 'done', head: 'abc', current: true, summary: 'Fine', findings: [], at: 1 });
  assert.deepEqual(reviewView({ ...s, review: { ...s.review, coverage } }).coverage, coverage);
});
