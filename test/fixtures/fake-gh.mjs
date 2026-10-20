// A stand-in for the GitHub CLI: just the commands wisp runs (pr create/view/ready/merge, run list,
// issue list). Pull requests live in a JSON file; merging really pushes the PR head to the base
// branch of the repo's origin, so the "sync your local main" step has something to fetch.
//
//   FAKE_GH_STATE  JSON file: { prs: {}, runs: [], issues: [], checks: [], review, mergeable } (created if missing)
//   FAKE_RECORD    directory; each call appends { argv, cwd } to gh.jsonl

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const file = process.env.FAKE_GH_STATE;
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
state.prs ||= {};
const save = () => fs.writeFileSync(file, JSON.stringify(state, null, 2));
const flag = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const git = (...a) => execFileSync('git', a, { cwd: process.cwd(), encoding: 'utf8' }).trim();
const fail = (msg) => (process.stderr.write(`${msg}\n`), process.exit(1));

if (process.env.FAKE_RECORD) {
  fs.mkdirSync(process.env.FAKE_RECORD, { recursive: true });
  fs.appendFileSync(path.join(process.env.FAKE_RECORD, 'gh.jsonl'), JSON.stringify({ argv, cwd: process.cwd() }) + '\n');
}

const find = (ref) => Object.values(state.prs).find((p) => String(p.number) === String(ref) || p.url === ref || p.headRefName === ref);
const [a, b] = argv;

if (a === 'pr' && b === 'create') {
  const number = Object.keys(state.prs).length + 1;
  const head = flag('--head');
  state.prs[number] = {
    number,
    url: `https://github.com/acme/repo/pull/${number}`,
    title: flag('--title'),
    body: flag('--body'),
    state: 'OPEN',
    isDraft: argv.includes('--draft'),
    reviewDecision: '',
    mergeStateStatus: 'CLEAN',
    headRefName: head,
    baseRefName: flag('--base'),
    headRefOid: git('rev-parse', 'HEAD'),
    statusCheckRollup: state.checks || [],
    mergedAt: null,
  };
  save();
  console.log(`Creating pull request for ${head} into ${flag('--base')}\n\n${state.prs[number].url}`);
} else if (a === 'pr' && b === 'view') {
  const pr = find(argv[2]) || fail('no pull requests found');
  if (state.checks) pr.statusCheckRollup = state.checks; // tests flip CI results between polls
  if (state.review !== undefined) pr.reviewDecision = state.review;
  if (state.mergeable !== undefined) pr.mergeable = state.mergeable; // CONFLICTING | MERGEABLE | UNKNOWN
  try {
    pr.headRefOid = git('rev-parse', '--verify', '--quiet', `refs/remotes/origin/${pr.headRefName}`) || pr.headRefOid; // pushes move the head
  } catch {}
  save();
  console.log(JSON.stringify(pr));
} else if (a === 'pr' && b === 'ready') {
  (find(argv[2]) || fail('not found')).isDraft = false;
  save();
} else if (a === 'pr' && b === 'merge') {
  const pr = find(argv[2]) || fail('not found');
  if (flag('--match-head-commit') !== pr.headRefOid) fail('Head branch was modified. Review and try the merge again.');
  if (pr.isDraft) fail('Pull request is still a draft');
  git('push', '--quiet', 'origin', `${pr.headRefOid}:refs/heads/${pr.baseRefName}`);
  Object.assign(pr, { state: 'MERGED', mergedAt: new Date().toISOString() });
  save();
} else if (a === 'run' && b === 'list') {
  const branch = flag('--branch');
  console.log(JSON.stringify((state.runs || []).filter((r) => !branch || r.headBranch === branch)));
} else if (a === 'search' && b === 'prs') {
  // Spells' data sources: the open PRs in the state file.
  const open = Object.values(state.prs).filter((p) => argv.includes('--state') ? p.state === flag('--state').toUpperCase() : true);
  console.log(JSON.stringify(open.map((p) => ({ number: p.number, title: p.title, url: p.url, state: p.state, repository: { nameWithOwner: 'acme/repo' } }))));
} else if (a === 'issue' && b === 'list') {
  if (typeof state.issues === 'string') console.log(state.issues); // a broken reply
  else console.log(JSON.stringify((state.issues || []).filter((i) => (i.labels || []).includes(flag('--label')))));
} else {
  fail(`fake gh: unsupported: ${argv.join(' ')}`);
}
