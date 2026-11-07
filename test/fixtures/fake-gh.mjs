// A stand-in for the GitHub CLI: just the commands wisp runs (pr create/view/ready/merge, run list,
// issue list, gist create, and for the GitHub channel api: user, repos/o/r, comments). Pull requests live in a JSON file; merging really pushes the PR head to the base
// branch of the repo's origin, so the "sync your local main" step has something to fetch.
//
//   FAKE_GH_STATE  JSON file: { prs: {}, runs: [], issues: [], checks: [], review, mergeable, reviewComments, signedOut } (created if missing)
//     and for `gh api`: user, repos: { 'o/r': { private } }, comments: [{ repo, id, body, user, … }],
//     commentsError: { status, retryAfter }, retryAfter. Posted comments go to FAKE_GH_POSTED, or else
//     <FAKE_GH_STATE>.posted (one JSON object a line), so a test can keep writing the state file
//     without losing them. Each gh reads FAKE_GH_STATE as it stood when it was spawned.
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

const postedFile = process.env.FAKE_GH_POSTED || `${file}.posted`;
const posted = () => (fs.existsSync(postedFile) ? fs.readFileSync(postedFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// The GitHub channel: gh api prints the response, with --include its status line and headers first,
// to stdout, also when it fails; the failure itself goes to stderr.
function gitHubApi() {
  const route = argv.slice(1).find((x) => !x.startsWith('-'));
  const include = argv.includes('--include');
  const reply = (status, text, headers = {}) => {
    const head = Object.entries(headers).map(([k, v]) => `${k}: ${v}\n`).join('');
    process.stdout.write(`${include ? `HTTP/2.0 ${status} ${status === 200 ? 'OK' : 'Refused'}\nContent-Type: application/json\n${head}\n` : ''}${text}\n`);
  };
  const refuse = (status, why, headers) => {
    reply(status, JSON.stringify({ message: why }), headers);
    fail(`gh: ${why} (HTTP ${status})`);
  };
  if (route === 'user') {
    if (state.signedOut) fail('To get started with GitHub CLI, please run:  gh auth login');
    return reply(200, JSON.stringify(state.user));
  }
  const stamp = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, 'Z'); // GitHub's are to the second
  let m;
  if ((m = /^repos\/([^/]+\/[^/]+)$/.exec(route))) return state.repos?.[m[1]] ? reply(200, JSON.stringify(state.repos[m[1]])) : refuse(404, 'Not Found');
  if ((m = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(route))) {
    const body = (argv.find((x) => x.startsWith('body=')) || '').slice('body='.length);
    const c = { id: 900000 + posted().length, repo: m[1], number: Number(m[2]), body, at: Date.now() };
    fs.appendFileSync(postedFile, `${JSON.stringify(c)}\n`);
    return reply(200, JSON.stringify(c));
  }
  if ((m = /^repos\/([^/]+\/[^/]+)\/issues\/comments\?(.*)$/.exec(route))) {
    const e = state.commentsError;
    if (e) return refuse(e.status, 'API rate limit exceeded', e.retryAfter ? { 'Retry-After': e.retryAfter } : {});
    const repo = m[1];
    const q = new URLSearchParams(m[2]);
    const since = Date.parse(q.get('since'));
    const mine = posted().filter((c) => c.repo === repo).map((c) => ({ ...c, user: state.user, created_at: stamp(c.at), updated_at: stamp(c.at), html_url: `https://github.com/${repo}/issues/${c.number}#issuecomment-${c.id}`, issue_url: `https://api.github.com/repos/${repo}/issues/${c.number}` }));
    const list = [...(state.comments || []).filter((c) => c.repo === repo), ...mine].filter((c) => Date.parse(c.updated_at) >= since).sort((x, y) => Date.parse(x.updated_at) - Date.parse(y.updated_at)).slice(0, Number(q.get('per_page')) || 30);
    return reply(200, JSON.stringify(list), state.retryAfter ? { 'Retry-After': state.retryAfter } : {});
  }
  fail(`fake gh: unsupported: ${argv.join(' ')}`);
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
  if (!flag('--repo')) save(); // the GitHub channel's read: the test owns the state file then
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
  if (state.signedOut) fail('To get started with GitHub CLI, please run:  gh auth login');
  if (typeof state.issues === 'string') console.log(state.issues); // a broken reply
  else if (flag('--label')) console.log(JSON.stringify((state.issues || []).filter((i) => (i.labels || []).includes(flag('--label')))));
  else {
    // New task's Issue picker: every open one (--search matches the title), labels as gh gives them.
    const q = (flag('--search') || '').toLowerCase();
    const list = (state.issues || []).filter((i) => !q || i.title.toLowerCase().includes(q)).slice(0, Number(flag('--limit')) || 30);
    console.log(JSON.stringify(list.map((i) => ({ ...i, labels: (i.labels || []).map((l) => (typeof l === 'string' ? { name: l } : l)) }))));
  }
} else if (a === 'gist' && b === 'create') {
  // Kept in the state file (its files, and whether it was public) so tests can read it back.
  const f = argv[2];
  state.gists ||= {};
  const id = `abc${String(Object.keys(state.gists).length + 1).padStart(5, '0')}`;
  state.gists[id] = { public: argv.includes('--public') || argv.includes('-p'), description: flag('--desc') || flag('-d') || '', files: { [path.basename(f)]: fs.readFileSync(f, 'utf8') } };
  save();
  process.stderr.write('- Creating gist\n');
  console.log(`https://gist.github.com/acme/${id}`);
} else if (a === 'run' && b === 'view') {
  // A failing job's log (the panel's Ask to fix).
  if (!state.runLog) fail('no log');
  console.log(state.runLog);
} else if (a === 'api' && /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments/.test(b || '')) {
  // A PR's inline review comments (the panel's threads).
  console.log(JSON.stringify(state.reviewComments || []));
} else if (a === 'api') {
  gitHubApi();
} else {
  fail(`fake gh: unsupported: ${argv.join(' ')}`);
}
