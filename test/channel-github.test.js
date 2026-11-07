// GitHub comments, end to end: a real wisp, fake agents, a fake gh. Start, ack, question, answer,
// follow-up, stop, report, on a crew member too; and each rule a public surface needs. No network:
// gh is the fake, and git may only use file:// here.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createServer as netServer } from 'node:net';
import { installFakeBins, isolateAgentConfigs, makeRepo, records, sleep, tmp, until } from './helpers.js';

const STATE = path.join(tmp('gh-state'), 'gh.json');
process.env.FAKE_RECORD = tmp('gh-record');
process.env.FAKE_GH_STATE = STATE;
process.env.WISP_HOME = tmp('gh-home');
process.env.WISP_UPDATE_CHECK = '0';
process.env.GIT_ALLOW_PROTOCOL = 'file';
installFakeBins();
isolateAgentConfigs();

const { startServer } = await import('../server/index.js');
const { RateLimit, STALE_S, hideNames, noMedia } = await import('../server/channels/policy.js');
const { MARKER, backoffMs, parseRepo, wispCommand } = await import('../server/channels/github.js');

const ME = { id: 7, login: 'mokh' };
const PRIVATE = 'acme/repo';
const PUBLIC = 'acme/open';
const state = { user: ME, repos: { [PRIVATE]: { private: true }, [PUBLIC]: { private: false } }, comments: [], prs: {} };
const write = () => {
  fs.writeFileSync(`${STATE}.tmp`, JSON.stringify(state));
  fs.renameSync(`${STATE}.tmp`, STATE);
};

let srv;
let base;
let repo;
let open;
let name;
let openName;

async function api(p, { method, body } = {}) {
  const r = await fetch(`${base}/api${p}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body || (method && method !== 'GET') ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : method && method !== 'GET' ? '{}' : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p}: ${j.error}`);
  return j;
}
const session = (id) => api(`/sessions/${id}`);
const settled = (id) => until(async () => {
  const s = await session(id);
  return s.state !== 'running' && s.state !== 'waiting' && !s.queue?.length ? s : null;
});
const port = () => new Promise((resolve) => {
  const s = netServer().listen(0, '127.0.0.1', () => {
    const { port: p } = s.address();
    s.close(() => resolve(p));
  });
});
async function boot() {
  const p = await port();
  base = `http://127.0.0.1:${p}`;
  srv = await startServer({ port: p, handleSignals: false });
  srv.remote.ghPollMs = 40;
  srv.remote.channels.github.limit = new RateLimit({ max: 1000 }); // this file is one busy sender
  srv.store.config.defaults.agent = 'claude'; // tests can't depend on which harness Auto picks
  srv.remote.start(); // the loop that began at boot sleeps on the long interval
}
const halt = () => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
};
const repoState = (r) => srv.store.config.remote.github.repos[r];
const watching = async () => {
  await until(() => repoState(PRIVATE) && repoState(PUBLIC), { what: 'both cursors' });
  await sleep(1100); // a comment from here on is newer than the cursor, to the second
};

before(async () => {
  write();
  await boot();
  repo = makeRepo();
  open = makeRepo();
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/repo.git'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/open.git'], { cwd: open });
  await api('/projects', { body: { path: repo } });
  await api('/projects', { body: { path: open } });
  const ps = (await api('/config')).projects;
  name = ps.find((p) => p.path === repo).name;
  openName = ps.find((p) => p.path === open).name;
});

after(() => {
  halt();
  setTimeout(() => process.exit(), 500).unref(); // agents held on FAKE_DELAY
});

let cid = 5000;
let issue = 1; // 1 is the first test's
const iso = (t = Date.now()) => new Date(t).toISOString().replace(/\.\d+Z$/, 'Z');
function comment(number, body, { in: r = PRIVATE, pr = false, ...o } = {}) {
  const now = iso();
  const c = { id: ++cid, repo: r, body, user: ME, created_at: now, updated_at: now, html_url: `https://github.com/${r}/${pr ? 'pull' : 'issues'}/${number}#issuecomment-${cid}`, issue_url: `https://api.github.com/repos/${r}/issues/${number}`, ...o };
  state.comments.push(c);
  write();
  return c;
}
const posted = () => (fs.existsSync(`${STATE}.posted`) ? fs.readFileSync(`${STATE}.posted`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const on = (number, r = PRIVATE) => posted().filter((c) => c.number === number && c.repo === r).map((c) => c.body);
// What wisp posts next on this issue, past what's there now.
const seenCount = new Map();
const nextOn = (number, r = PRIVATE) =>
  until(() => {
    const key = `${r}#${number}`;
    const all = on(number, r);
    const at = seenCount.get(key) || 0;
    if (all.length <= at) return null;
    seenCount.set(key, at + 1);
    return all[at];
  }, { what: `a comment on ${number}` });
const line = (text) => `${text}\n\n${MARKER}`;
const startedOn = (number, r = PRIVATE) => until(() => srv.store.all().find((s) => s.remote?.gh === `${r}#${number}`), { what: `a task on ${number}` });
const tasksOn = (number, r = PRIVATE) => srv.store.all().filter((s) => s.remote?.gh === `${r}#${number}`);
// Long enough for wisp to have acted on a comment, had it meant to: one that comes after it is answered.
async function quiet(number, r = PRIVATE) {
  const n = ++issue + 100000;
  comment(n, '/wisp help', { in: r });
  await nextOn(n, r);
  assert.equal(on(number, r).length, seenCount.get(`${r}#${number}`) || 0, 'nothing new was posted');
}
const nextIssue = () => ++issue;

test('off by default: nothing is polled, and the view says so', async () => {
  const view = await api('/remote');
  assert.deepEqual(view.github, { enabled: false, publicReports: false, login: '', repos: [], error: '' });
  await sleep(150);
  assert.ok(!records(process.env.FAKE_RECORD, 'gh').some((r) => r.argv[0] === 'api'), 'no gh api call');
});

test('switched on: who you are, the repos of this computer’s projects, and the first look runs nothing', async () => {
  const early = comment(1, '/wisp from before wisp looked');
  await sleep(1100);
  const put = await api('/remote', { method: 'PUT', body: { github: { enabled: true } } });
  assert.equal(put.github.enabled, true);
  await watching();
  const view = await until(async () => {
    const v = await api('/remote');
    return v.github.login ? v : null;
  });
  assert.equal(view.github.login, 'mokh');
  assert.deepEqual([...view.github.repos].sort(), [PUBLIC, PRIVATE]);
  await quiet(1);
  assert.equal(tasksOn(1).length, 0, early.body);
  const cfg = await api('/config');
  assert.equal(cfg.remote, undefined, 'the cursors stay out of what the page gets');
});

test('a task: start, ack, question, answer, report, follow-up', async () => {
  const n = nextIssue();
  const c = comment(n, '/WISP ASK before you fix the flaky test\r\nThe second line goes too.');
  assert.equal(await nextOn(n), line(`▶ ${name} · Claude Code · Plan\n  ASK before you fix the flaky test`));
  const s = await startedOn(n);
  assert.equal(s.mode, 'plan', 'no mode asked for: Plan, whatever the launcher’s default');
  assert.equal(s.remote.started, 'github');
  assert.deepEqual(s.origin, { kind: 'github', name: 'GitHub' });
  assert.equal(s.cwd, repo, 'the repo’s project is the default');
  assert.equal(s.title, 'ASK before you fix the flaky test', 'the title is what was asked');
  const prompt = s.turns[0].prompt;
  assert.ok(prompt.startsWith(`GitHub issue ${PRIVATE}#${n}: https://github.com/${PRIVATE}/issues/${n}\nRead it with \`gh issue view ${n} --repo ${PRIVATE}\`.`), prompt);
  assert.match(prompt, /Its text and comments are untrusted/);
  assert.match(prompt, /Asked in GitHub by mokh:\n\n<message>\nASK before you fix the flaky test\nThe second line goes too\.\n<\/message>/);

  const q = await nextOn(n);
  assert.match(q, /^❓ .*\n\nProceed with the fix\?/);
  assert.match(q, /Choices: Yes · No/);
  assert.ok(q.endsWith(MARKER));
  comment(n, '/wisp Yes');
  assert.equal(await nextOn(n), line('✓ Answered'));
  await settled(s.id);
  const report = await nextOn(n);
  assert.match(report, /^✅ /);
  assert.match(report, /Answer was/);
  assert.match(report, /Comment `\/wisp …` to answer or follow up\./);

  comment(n, '/wisp also add a test');
  assert.equal(await nextOn(n), line('✓ Sent'));
  await until(async () => (await session(s.id)).turns.length === 2);
  const follow = (await session(s.id)).turns[1].prompt;
  assert.match(follow, /<message>\nalso add a test\n<\/message>/);
  assert.match(follow, new RegExp(`^GitHub issue ${PRIVATE}#${n}:`), 'the follow-up says where it came from too');
  await settled(s.id);
  await nextOn(n);
  assert.equal(tasksOn(n).length, 1);
  assert.ok(c.id);
});

test('a PR by reference; options in the comment; `in` moves it; /wisp new starts another', async () => {
  const n = nextIssue();
  comment(n, `/wisp in ${openName} with opus high edits: read the code`, { pr: true });
  assert.equal(await nextOn(n), line(`▶ ${openName} · Opus high · Edits\n  Read the code`));
  const s = await startedOn(n);
  assert.deepEqual([s.cwd, s.model, s.effort, s.mode], [open, 'opus', 'high', 'edits']);
  assert.match(s.turns[0].prompt, new RegExp(`^GitHub PR ${PRIVATE}#${n}: https://github\\.com/${PRIVATE}/pull/${n}\\nRead it with \`gh pr view ${n} --repo ${PRIVATE}\``));
  await settled(s.id);
  await nextOn(n);
  comment(n, '/wisp new another one', { pr: true });
  assert.equal(await nextOn(n), line(`▶ ${name} · Claude Code · Plan\n  Another one`));
  await until(() => tasksOn(n).length === 2);
  assert.equal((await session(s.id)).turns.length, 1, 'not a follow-up');
  await settled(tasksOn(n).find((x) => x.id !== s.id).id);
  await nextOn(n);
});

test('stop, status, done; stop keeps queued follow-ups; with nothing there, it says so', async () => {
  const n = nextIssue();
  comment(n, '/wisp stop');
  assert.equal(await nextOn(n), line('There’s no task on this one yet.'));
  srv.store.config.defaults.followUp = 'queue';
  process.env.FAKE_DELAY = '30000';
  try {
    comment(n, '/wisp a long one');
    await nextOn(n);
    const s = await startedOn(n);
    await until(async () => (await session(s.id)).state === 'running');
    comment(n, '/wisp and then this');
    assert.equal(await nextOn(n), line('✓ Queued for when it finishes'));
    comment(n, '/wisp status');
    assert.equal(await nextOn(n), line('Working: a long one (1 queued)'));
    comment(n, '/wisp stop');
    // The stop's report and its line race, so neither is waited on in order.
    await until(() => on(n).includes(line('■ Stopped. 1 queued follow-up kept: your next message carries them on.')) && on(n).some((b) => b.startsWith('🟡') || b.startsWith('⛔')));
    await until(async () => (await session(s.id)).state !== 'running');
    assert.equal((await session(s.id)).queue.length, 1);
    delete process.env.FAKE_DELAY;
    comment(n, '/wisp pick it up');
    await until(async () => (await session(s.id)).turns.length >= 2);
    await settled(s.id);
    comment(n, '/wisp done');
    await until(() => on(n).some((b) => b === line('✓ Marked done')));
    assert.equal((await session(s.id)).state, 'done');
    seenCount.set(`${PRIVATE}#${n}`, on(n).length);
  } finally {
    delete process.env.FAKE_DELAY;
    srv.store.config.defaults.followUp = 'interrupt';
  }
});

test('lists: each ends with an example, and this repo’s project is the default', async () => {
  for (const [text, re] of [
    ['help', /Say what you’d type in wisp/],
    ['', /Say what you’d type in wisp/],
    ['projects', new RegExp(`• ${name}  ← default`)],
    ['models', /• claude: opus, sonnet, haiku/],
    ['machines', /• this computer · online/],
    ['status', /./],
    ['crew', /./],
  ]) {
    const n = nextIssue();
    comment(n, `/wisp ${text}`.trim());
    const m = await nextOn(n);
    assert.match(m, re, text);
    assert.match(m.replace(`\n\n${MARKER}`, '').split('\n').at(-1), /^Try: /, text);
    assert.equal(tasksOn(n).length, 0);
  }
});

test('a crew member: Plan by default, report under their name, follow-up, a mention in a thread', async () => {
  const m = await api('/crew', { body: { name: 'Ada', role: 'CI watcher', brief: 'Watch CI.', cwd: repo, agent: 'claude', model: 'sonnet', mode: 'auto', parallel: 2 } });
  const n = nextIssue();
  comment(n, '/wisp @ada check the deploy');
  assert.match(await nextOn(n), new RegExp(`^▶ Ada has it · ${name} · Sonnet · Plan\\n  Check the deploy\\nThat mode is for this job only\\.`));
  const job = await startedOn(n);
  assert.equal(job.crew.id, m.id);
  assert.equal(job.mode, 'plan', 'their own Full auto doesn’t reach a job from here');
  assert.equal(job.remote.by, 'Ada');
  await settled(job.id);
  assert.match(await nextOn(n), /^Ada: ✅ /);
  comment(n, '/wisp and the staging one');
  assert.equal(await nextOn(n), line('✓ Sent'));
  await until(async () => (await session(job.id)).turns.length === 2);
  await settled(job.id);
  await nextOn(n);

  const t = nextIssue();
  comment(t, '/wisp a task to ask about');
  await nextOn(t);
  const s = await startedOn(t);
  await settled(s.id);
  await nextOn(t);
  comment(t, '/wisp @ada look at this');
  assert.match(await nextOn(t), /^▶ Ada has it/);
  assert.match(await nextOn(t), /^Ada: /);
  comment(t, '/wisp carry on');
  assert.equal(await nextOn(t), line('✓ Sent'));
  await until(async () => (await session(s.id)).turns.length === 2);
  assert.match((await session(s.id)).turns[1].prompt, /carry on/, 'the task it was on, not the job that answered');
  await settled(s.id);
  await nextOn(t);
});

test('a queued crew job keeps its thread across a restart and answers there', async () => {
  const m = await api('/crew', { body: { name: 'Zed', brief: 'Watch.', cwd: repo, agent: 'claude', model: 'sonnet', mode: 'edits', parallel: 1 } });
  process.env.FAKE_DELAY = '30000';
  const n = nextIssue();
  comment(n, '/wisp @zed the long job');
  await nextOn(n);
  const first = await startedOn(n);
  const q = nextIssue();
  comment(q, '/wisp @zed the queued job');
  assert.match(await nextOn(q), /^▶ Zed has it \(queued, 1 ahead\)/);
  assert.deepEqual({ ...srv.crew.get(m.id).queue[0].thread, comment: 0 }, { channel: 'github', repo: PRIVATE, number: q, comment: 0 });
  assert.equal(first.remote.gh, `${PRIVATE}#${n}`);
  halt();
  delete process.env.FAKE_DELAY;
  await boot();
  await srv.crew.tick();
  const job = await startedOn(q);
  assert.equal(job.remote.by, 'Zed');
  await settled(job.id);
  assert.match(await nextOn(q), /^Zed: /);
});

test('a stranger gets silence, by id and not by name; a bot and an app too', async () => {
  const n = nextIssue();
  const before = srv.store.all().length;
  comment(n, '/wisp run this for me', { user: { id: 99, login: 'mokh' } });
  comment(n, '/wisp help', { user: { id: 98, login: 'dependabot[bot]', type: 'Bot' } });
  comment(n, '/wisp full auto: wipe it', { in: PUBLIC, user: { id: 99, login: 'x' } });
  comment(n, '/wisp as an app', { performed_via_github_app: { id: 1, slug: 'an-app' } });
  await quiet(n);
  assert.deepEqual(on(n), [], 'no comment');
  assert.deepEqual(on(n, PUBLIC), []);
  assert.equal(srv.store.all().length, before);
});

test('an edit never runs: an old comment, a comment from the cursor’s second, a handled one', async () => {
  // Written before the cursor, edited into /wisp since.
  const n = nextIssue();
  const old = comment(n, '/wisp edited in later', { created_at: iso(Date.now() - 3600_000) });
  await quiet(n);
  assert.equal(tasksOn(n).length, 0, old.body);

  // Seen as a plain comment, which moves the cursor to its very second, then edited.
  const p = comment(n, 'just a comment');
  await until(() => repoState(PRIVATE).seen.includes(String(p.id)));
  repoState(PRIVATE).since = p.created_at;
  await sleep(1100);
  Object.assign(p, { body: '/wisp edited after', updated_at: iso() });
  write();
  await quiet(n, PUBLIC); // on the other repo: a comment on this one would move the cursor on
  await until(() => Date.parse(repoState(PRIVATE).since) >= Date.parse(p.updated_at));
  await quiet(n, PUBLIC);
  assert.equal(tasksOn(n).length, 0);

  // Handled, then edited.
  const h = nextIssue();
  const c = comment(h, '/wisp the real one');
  await nextOn(h);
  const s = await startedOn(h);
  await settled(s.id);
  await nextOn(h);
  await sleep(1100);
  Object.assign(c, { body: '/wisp the real one, edited', updated_at: iso() });
  write();
  await quiet(h);
  assert.equal(tasksOn(h).length, 1);
  assert.equal((await session(s.id)).turns.length, 1);
});

test('nothing runs twice: the id and the cursor are on disk before it runs, and a restart remembers', async () => {
  const n = nextIssue();
  const phone = srv.remote.phone;
  const real = phone.startParsed;
  let disk = null;
  phone.startParsed = (...a) => {
    disk = JSON.parse(fs.readFileSync(path.join(process.env.WISP_HOME, 'config.json'), 'utf8')).remote.github.repos[PRIVATE];
    return real(...a);
  };
  const c = comment(n, '/wisp only once');
  try {
    await nextOn(n);
  } finally {
    phone.startParsed = real;
  }
  assert.ok(disk.seen.includes(String(c.id)), 'seen before launching');
  assert.ok(Date.parse(disk.since) >= Date.parse(c.updated_at), 'the cursor too');
  const s = await startedOn(n);
  await settled(s.id);
  await nextOn(n);

  halt();
  await boot();
  // The worst case: GitHub hands it back, and the cursor hasn't moved past it.
  const st = srv.store.config.remote.github.repos[PRIVATE];
  assert.ok(st.seen.includes(String(c.id)));
  st.since = c.updated_at;
  srv.store.saveConfig();
  await quiet(n);
  assert.equal(tasksOn(n).length, 1);
  assert.equal(srv.store.all().filter((x) => x.turns[0]?.prompt.includes('only once')).length, 1);
});

test('the seen ring keeps 200', async () => {
  const st = repoState(PRIVATE);
  const kept = st.seen;
  st.seen = Array.from({ length: 200 }, (_, i) => `x${i}`);
  const n = nextIssue();
  const c = comment(n, 'a plain one');
  await until(() => repoState(PRIVATE).seen.includes(String(c.id)));
  const st2 = repoState(PRIVATE);
  assert.equal(st2.seen.length, 200);
  assert.ok(!st2.seen.includes('x0'));
  st2.seen = [...kept, String(c.id)];
});

test('stale: said while wisp was off, told and not run', async () => {
  const n = nextIssue();
  const st = repoState(PRIVATE);
  const back = st.since;
  const old = iso(Date.now() - (STALE_S + 120) * 1000);
  st.since = iso(Date.now() - 3 * 3600_000);
  comment(n, '/wisp from while it was off', { created_at: old, updated_at: old });
  assert.match(await nextOn(n), /^That arrived while wisp was offline, so it didn’t run\./);
  assert.equal(tasksOn(n).length, 0);
  assert.ok(back);
});

test('Full auto is refused and nothing starts; Edits is the most; a follow-up is held to it', async () => {
  const n = nextIssue();
  const wiped = () => srv.store.all().filter((s) => s.turns[0]?.prompt.includes('wipe it'));
  comment(n, '/wisp full auto: wipe it');
  assert.equal(await nextOn(n), line('Full auto isn’t allowed from here. The most this chat can ask for is Edits.\n\nNothing started.'));
  assert.deepEqual(wiped(), []);
  comment(n, `/wisp in ${name} full auto: wipe it`);
  assert.match(await nextOn(n), /Nothing started/);
  assert.deepEqual(wiped(), []);

  comment(n, '/wisp edits: small fix');
  assert.equal(await nextOn(n), line(`▶ ${name} · Claude Code · Edits\n  Small fix`));
  const s = await startedOn(n);
  assert.equal(s.mode, 'edits');
  await settled(s.id);
  await nextOn(n);
  comment(n, '/wisp full auto: and now wipe it');
  assert.match(await nextOn(n), /Full auto isn’t allowed from here/);
  assert.equal((await session(s.id)).turns.length, 1);
  srv.store.get(s.id).mode = 'auto'; // switched in wisp meanwhile
  comment(n, '/wisp carry on');
  await nextOn(n);
  await until(async () => (await session(s.id)).turns.length === 2);
  assert.equal((await session(s.id)).mode, 'edits', 'a comment can’t carry a task on in Full auto');
  await settled(s.id);
  await nextOn(n);
});

test('a tool approval is never answered from a comment, and says so', async () => {
  const n = nextIssue();
  comment(n, '/wisp edits: APPROVE then publish');
  await nextOn(n);
  const s = await startedOn(n);
  const q = await nextOn(n);
  assert.match(q, /^❓ /);
  assert.match(q, /This one is a tool approval: answer it in wisp\./);
  assert.doesNotMatch(q, /Choices:/);
  assert.ok((await session(s.id)).ask?.permission);
  comment(n, '/wisp allow');
  assert.equal(await nextOn(n), line('That’s waiting for an approval, which only wisp can give: answer it there.'));
  assert.ok((await session(s.id)).ask?.permission, 'still waiting');
  assert.equal(srv.remote.channels.github.approvalsHere, false);
  await api(`/sessions/${s.id}/stop`, { method: 'POST' });
  await settled(s.id);
  await nextOn(n);
});

async function reported(r, n, summary, title = 'A title', extra = []) {
  comment(n, '/wisp report something', { in: r });
  await nextOn(n, r);
  const s = await startedOn(n, r);
  await settled(s.id);
  await nextOn(n, r);
  const live = srv.store.get(s.id);
  live.title = title;
  live.turns.at(-1).presentation = { blocks: [{ type: 'hero', status: 'done', title: 'Agent’s title', summary }, ...extra] };
  await srv.remote.notify(live, { project: 'p' });
  return nextOn(n, r);
}

test('what leaves: a secret is taken out, and no mention works', async () => {
  const token = `ghp_${'a1B2'.repeat(10)}`;
  const n = nextIssue();
  const body = await reported(PRIVATE, n, `Found ${token} and pinging @everyone, @octo/team and -@bob and .@sue. Mail me@example.com. <!-- hide -->`, `Title ${token}`);
  assert.ok(!body.includes(token), body);
  assert.match(body, /\[REDACTED|wisp took a secret/);
  assert.match(body, /wisp took a secret out of this message/);
  assert.ok(!/(^|\W)@[a-z0-9]/im.test(body.replace('me@example.com', '')), body);
  assert.match(body, /me@example\.com/, 'an address stays');
  assert.ok(!body.replace(MARKER, '').includes('<!--'), 'no hidden text of the agent’s');
  assert.ok(body.endsWith(`\n\n${MARKER}`));

  const long = nextIssue();
  const big = await reported(PRIVATE, long, 'x'.repeat(20000));
  assert.ok(big.length <= 8000, String(big.length));
  assert.ok(big.endsWith(MARKER));
});

test('nothing an agent wrote renders as an image or a tag: text, title and choices, private or not', async () => {
  const n = nextIssue();
  const body = await reported(
    PRIVATE,
    n,
    'Look ![a](https://evil.example/?d=one) and ![b][ref] and <img src=https://evil.example/two> <IFRAME src=x></iframe> <style>a{}</style>\n[ref]: https://evil.example/three\n\n[a link](https://ok.example)',
    'Title ![t](https://evil.example/?d=title)',
    [{ type: 'question', question: 'Which?', options: ['![o](https://evil.example/?d=choice)', 'plain'] }],
  );
  const text = body.replace(MARKER, '');
  assert.doesNotMatch(text, /!\[/, 'no image, in the text, the title or a choice');
  assert.doesNotMatch(text, /<\/?(img|iframe|style)/i, 'no tag');
  assert.match(text, /\[a link\]\(https:\/\/ok\.example\)/, 'a plain link stays');
  assert.ok(body.endsWith(`\n\n${MARKER}`), 'and the marker is whole');

  // What else can quote an agent: a title in status.
  const s = await startedOn(n);
  srv.store.get(s.id).title = '<img src=https://evil.example/status>';
  comment(n, '/wisp status');
  assert.doesNotMatch(await nextOn(n), /<img/);
});

test('a public repo: a fixed line with nothing an agent wrote, in every path', async () => {
  const n = nextIssue();
  const leak = 'aGVsbG8gd29ybGQ=';
  assert.equal(await reported(PUBLIC, n, leak, `Title ${leak}`), line('✅ wisp finished this.'));

  // What can quote an agent's title or a side answer.
  const s = await startedOn(n, PUBLIC);
  srv.store.get(s.id).title = `Title ${leak}`;
  comment(n, '/wisp status', { in: PUBLIC });
  assert.equal(await nextOn(n, PUBLIC), line('Ready for review.'));
  const other = srv.store.all().find((x) => x.id !== s.id);
  assert.ok(other);
  process.env.FAKE_DELAY = '30000';
  const q = nextIssue();
  comment(q, '/wisp status', { in: PUBLIC });
  assert.match(await nextOn(q, PUBLIC), /^\d+ running, \d+ waiting: see them in wisp\./);
  delete process.env.FAKE_DELAY;

  comment(n, '/wisp /btw what changed?', { in: PUBLIC });
  assert.match(await nextOn(n, PUBLIC), /Asking on the side/);
  assert.equal(await nextOn(n, PUBLIC), line('The answer is on the task in wisp.'));

  const a = nextIssue();
  comment(a, '/wisp ASK about this', { in: PUBLIC });
  assert.equal(await nextOn(a, PUBLIC), line(`▶ ${openName} · Claude Code · Plan\n  ASK about this`), 'the ack is what you typed and your own names');
  const asked = await startedOn(a, PUBLIC);
  assert.equal(await nextOn(a, PUBLIC), line('❓ wisp has a question: see it in wisp.'));
  await api(`/sessions/${asked.id}/stop`, { method: 'POST' });
  await settled(asked.id);
  await nextOn(a, PUBLIC);
});

test('a public repo sees none of your names: lists, help, refusals, a crew member’s ack', async () => {
  srv.store.config.machines = [...(srv.store.config.machines || []), { id: 'm1', name: 'secretbox', target: 'x' }];
  const leaks = (body) => [name, repo, 'secretbox', 'Zed'].filter((x) => body.includes(x));
  try {
    for (const word of ['projects', 'crew', 'machines', 'models']) {
      const n = nextIssue();
      comment(n, `/wisp ${word}`, { in: PUBLIC });
      assert.equal(await nextOn(n, PUBLIC), line('That list isn’t shown on a public repo: see it in wisp, or ask on a private repo.'), word);
    }
    const h = nextIssue();
    comment(h, '/wisp help', { in: PUBLIC });
    const help = await nextOn(h, PUBLIC);
    assert.match(help, /Say what you’d type in wisp/);
    assert.match(help, /Try: plan: fix the flaky test/);
    assert.ok(!help.includes(openName), 'not even this repo’s project');
    assert.deepEqual(leaks(help), []);

    for (const [text, re] of [
      ['in nope: fix it', /^No project “nope”\.\n\nNothing started\./],
      ['#nope fix it', /^No project matches “nope”\.\n\nNothing started\./],
      ['@nobody fix it', /^No crew member or project matches “nobody”\.\n\nNothing started\./],
      ['on secr: fix it', /^… is offline\.\n\nNothing started\./],
      [`@ada in ${openName}: fix it`, /^Ada works in …: a job can’t move them to /],
    ]) {
      const n = nextIssue();
      comment(n, `/wisp ${text}`, { in: PUBLIC });
      const body = await nextOn(n, PUBLIC);
      assert.match(body, re, text);
      assert.doesNotMatch(body, /Choices:/, text);
      assert.deepEqual(leaks(body), [], text);
    }

    const c = nextIssue();
    comment(c, '/wisp @ada have a look', { in: PUBLIC });
    const ack = await nextOn(c, PUBLIC);
    assert.match(ack, /^▶ Ada has it · Sonnet · Plan/, 'their folder isn’t yours to show here');
    assert.deepEqual(leaks(ack), []);
    await settled((await startedOn(c, PUBLIC)).id);
    await nextOn(c, PUBLIC);

    // A private repo keeps them all.
    const p = nextIssue();
    comment(p, '/wisp in nope: fix it');
    assert.match(await nextOn(p), new RegExp(`Choices: .*${name}`));
    const l = nextIssue();
    comment(l, '/wisp projects');
    assert.match(await nextOn(l), new RegExp(name));
  } finally {
    srv.store.config.machines = srv.store.config.machines.filter((m) => m.id !== 'm1');
  }
});

test('github.publicReports turns full reports on; not knowing a repo’s visibility counts as public', async () => {
  const on1 = await api('/remote', { method: 'PUT', body: { github: { publicReports: true } } });
  assert.equal(on1.github.publicReports, true);
  await until(() => repoState(PUBLIC));
  const n = nextIssue();
  try {
    assert.match(await reported(PUBLIC, n, 'The whole story'), /The whole story/);
  } finally {
    await api('/remote', { method: 'PUT', body: { github: { publicReports: false } } });
  }
  const off = srv.remote.channels.github;
  off.visibility.clear();
  const keep = state.repos[PRIVATE];
  delete state.repos[PRIVATE];
  write();
  try {
    const u = nextIssue();
    assert.equal(await reported(PRIVATE, u, 'A private story'), line('✅ wisp finished this.'));
  } finally {
    state.repos[PRIVATE] = keep;
    write();
    off.visibility.clear();
  }
});

test('reports: only tasks started here, whatever the Phone events say; a task from wisp posts nothing', async () => {
  const events = srv.store.config.remote.events;
  srv.store.config.remote.events = [];
  const n = nextIssue();
  try {
    comment(n, '/wisp with the events off');
    await nextOn(n);
    const s = await startedOn(n);
    await settled(s.id);
    assert.match(await nextOn(n), /^✅ /);
  } finally {
    srv.store.config.remote.events = events;
  }
  const before = posted().length;
  const s = await api('/sessions', { body: { prompt: 'plain task', cwd: repo, agent: 'claude', worktree: false } });
  await settled(s.id);
  await sleep(200);
  assert.equal(posted().length, before, 'nothing about it');
  assert.equal(srv.store.get(s.id).remote?.gh, undefined);
});

test('a scheduled check-in never posts', async () => {
  const m = srv.crew.find('ada');
  const before = posted().length;
  const out = await srv.crew.checkin(m, { unattended: true });
  await settled(out.session.id);
  await sleep(200);
  assert.equal(posted().length, before);
  assert.equal(srv.store.get(out.session.id).remote?.gh, undefined);
});

test('a PR with no task of its own: the task on its branch takes it, and that one turn reports back', async () => {
  const s = await api('/sessions', { body: { prompt: 'on a branch', cwd: repo, agent: 'claude', worktree: true } });
  await settled(s.id);
  const branch = srv.store.get(s.id).worktree.branch;
  assert.ok(branch);
  const n = nextIssue();
  state.prs[n] = { number: n, headRefName: branch, state: 'OPEN', url: `https://github.com/${PRIVATE}/pull/${n}` };
  write();
  comment(n, '/wisp please also do this', { pr: true });
  assert.equal(await nextOn(n), line('✓ Sent'));
  await until(async () => (await session(s.id)).turns.length === 2);
  assert.match((await session(s.id)).turns[1].prompt, new RegExp(`GitHub PR ${PRIVATE}#${n}[\\s\\S]*please also do this`));
  await settled(s.id);
  assert.match(await nextOn(n), /^✅ /, 'that turn’s report');
  assert.equal(srv.store.get(s.id).remote?.ghOnce, undefined, 'one shot');
  assert.equal(srv.store.get(s.id).remote?.started, undefined, 'still a task of wisp’s');

  // The next turn, from wisp, stays there.
  await api(`/sessions/${s.id}/reply`, { body: { text: 'from wisp this time' } });
  await until(async () => (await session(s.id)).turns.length === 3);
  await settled(s.id);
  await quiet(n);

  // Nothing sent, so no shot: the next turn isn't this comment's.
  const live = srv.store.get(s.id);
  live.ask = { id: 'a1', question: 'OK?', options: ['Allow', 'Deny'], permission: { tool: 'Bash', action: 'x', detail: 'x' } };
  comment(n, '/wisp go ahead', { pr: true });
  assert.match(await nextOn(n), /only wisp can give/);
  assert.equal(srv.store.get(s.id).remote?.ghOnce, undefined);
  delete live.ask;
  comment(n, '/wisp /btw what changed?', { pr: true });
  assert.match(await nextOn(n), /Asking on the side/);
  await nextOn(n);
  assert.equal(srv.store.get(s.id).remote?.ghOnce, undefined, 'a side question is no turn');

  // /wisp new leaves it alone, and an issue with that number never looks for a branch.
  comment(n, '/wisp new a separate one', { pr: true });
  assert.match(await nextOn(n), /^▶ /);
  await settled((await startedOn(n)).id);
  await nextOn(n);
  assert.equal((await session(s.id)).turns.length, 3);
  const i = nextIssue();
  state.prs[i] = { number: i, headRefName: branch, state: 'OPEN' };
  write();
  comment(i, '/wisp an issue, not a PR');
  assert.match(await nextOn(i), /^▶ /);
  assert.equal((await session(s.id)).turns.length, 3);
  await settled((await startedOn(i)).id);
  await nextOn(i);
});

test('that one turn on a public repo is the fixed line; the shot survives a restart', async () => {
  const s = await api('/sessions', { body: { prompt: 'public branch', cwd: open, agent: 'claude', worktree: true } });
  await settled(s.id);
  const branch = srv.store.get(s.id).worktree.branch;
  const n = nextIssue();
  state.prs[n] = { number: n, headRefName: branch, state: 'OPEN' };
  write();
  comment(n, '/wisp one more', { in: PUBLIC, pr: true });
  assert.equal(await nextOn(n, PUBLIC), line('✓ Sent.'));
  await until(async () => (await session(s.id)).turns.length === 2);
  await settled(s.id);
  assert.equal(await nextOn(n, PUBLIC), line('✅ wisp finished this.'));

  const key = `${PRIVATE}#${n}`;
  const t = await api('/sessions', { body: { prompt: 'a task from wisp', cwd: repo, agent: 'claude', worktree: false } });
  await settled(t.id);
  // A shot on the session, as a comment leaves it, with its turn still to end when wisp stops.
  const live = srv.store.get(t.id);
  live.remote = { ...live.remote, ghOnce: key };
  srv.store.save(live, { now: true });
  const file = path.join(process.env.WISP_HOME, 'sessions', `${t.id}.json`);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).remote.ghOnce, key, 'on disk');
  halt();
  await boot();
  const back = srv.store.get(t.id);
  assert.equal(back.remote.ghOnce, key);
  await srv.remote.notify(back, { project: 'p' });
  assert.match(await nextOn(n), /^✅ /);
  await srv.remote.notify(srv.store.get(t.id), { project: 'p' });
  await quiet(n);
  assert.equal(srv.store.get(t.id).remote?.ghOnce, undefined);
});

test('a task on another machine keeps its issue across a restart: it reports, and /wisp follows up', async () => {
  const n = nextIssue();
  const id = 'abc@m1';
  const ch = () => srv.remote.channels.github;
  ch().threadStarted({ id }, { channel: 'github', repo: PRIVATE, number: n, comment: 1 }, { name: 'Ada' });
  assert.equal(srv.remote.away.get(id).gh, `${PRIVATE}#${n}`);
  srv.remote.markStarted('tg1@m1', 'telegram', 'Ada'); // Telegram's stay memory, as they were
  const disk = JSON.parse(fs.readFileSync(path.join(process.env.WISP_HOME, 'config.json'), 'utf8'));
  assert.equal(disk.remote.github.away[id].gh, `${PRIVATE}#${n}`, 'on disk at once');
  assert.equal(disk.remote.github.away['tg1@m1'], undefined);

  // A settings change doesn't lose it.
  await api('/remote', { method: 'PUT', body: { github: { publicReports: false } } });
  assert.ok(srv.store.config.remote.github.away[id]);

  halt();
  await boot();
  await until(() => repoState(PRIVATE));
  assert.deepEqual(srv.remote.startedFrom({ id }), { channel: 'github', last: null, by: 'Ada', gh: `${PRIVATE}#${n}`, at: srv.remote.away.get(id).at });
  assert.equal(srv.remote.away.has('tg1@m1'), false);

  const turns = [{ id: 't1', status: 'done', presentation: { blocks: [{ type: 'hero', status: 'done', title: 'From away', summary: 'Done over there' }] } }];
  await srv.remote.notify({ id, state: 'review', title: 'Away task', turns }, { project: 'p' });
  const report = await nextOn(n);
  assert.match(report, /^Ada: ✅ p: Away task/);
  assert.match(report, /Done over there/);

  const sent = [];
  srv.machines.json = async (mid, method, p, body) => {
    if (method === 'GET') return { id: 'abc', agent: 'claude', state: 'review', mode: 'plan', title: 'Away task', turns };
    sent.push({ mid, method, p, body });
    return { queued: false };
  };
  srv.machines.session = (mid, s) => ({ ...s, id: `${s.id}@${mid}` });
  const before = srv.store.all().length;
  comment(n, '/wisp and the next thing');
  assert.equal(await nextOn(n), line('✓ Sent'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].p, '/sessions/abc/reply');
  assert.match(sent[0].body.text, /<message>\nand the next thing\n<\/message>/);
  assert.equal(srv.store.all().length, before, 'not another task');
});

test('the kept threads stop at 200, oldest out', () => {
  const ch = srv.remote.channels.github;
  const n = 777777;
  for (let i = 0; i < 205; i++) {
    srv.remote.markStarted(`x${i}@m1`, 'github');
    ch.threadStarted({ id: `x${i}@m1` }, { channel: 'github', repo: PRIVATE, number: n, comment: 1 }, null);
  }
  const kept = Object.keys(srv.store.config.remote.github.away);
  assert.equal(kept.length, 200);
  assert.ok(!kept.includes('x4@m1'));
  assert.ok(kept.includes('x204@m1'));
});

test('wisp’s own comments and what isn’t a command do nothing', async () => {
  const n = nextIssue();
  for (const body of [
    '> /wisp in a quote',
    '```\n/wisp in a fence\n```',
    '    /wisp as a code block',
    'Some words first\n/wisp further down',
    '/wispy not the word',
    '`/wisp` in backticks',
    `/wisp run wisp's own reply\n\n${MARKER}`,
  ])
    comment(n, body);
  await quiet(n);
  assert.equal(tasksOn(n).length, 0);
});

test('a burst is told once, then silence', async () => {
  const ch = srv.remote.channels.github;
  const keep = ch.limit;
  ch.limit = new RateLimit({ max: 1 });
  const n = nextIssue();
  try {
    comment(n, '/wisp help');
    comment(n, '/wisp help');
    comment(n, '/wisp help');
    await until(() => on(n).length >= 2);
    await sleep(300);
    const said = on(n);
    assert.equal(said.length, 2);
    assert.match(said[1], /^That’s a lot of messages/);
  } finally {
    ch.limit = keep;
  }
});

test('a 403 backs off, shows in the view, and comes back; Retry-After on a good answer too', async () => {
  state.commentsError = { status: 403, retryAfter: 2 };
  write();
  const view = await until(async () => {
    const v = await api('/remote');
    return v.github.error ? v : null;
  });
  assert.match(view.github.error, /HTTP 403.*Looking again in \d+s\./);
  assert.equal(view.status.github.ok, false);
  await sleep(200);
  const calls = () => records(process.env.FAKE_RECORD, 'gh').filter((r) => r.argv.some((x) => x.includes(`repos/${PRIVATE}/issues/comments?`))).length;
  const a = calls();
  await sleep(700);
  // A call already on its way when the view changed may land here; a poll every 40 ms would be many.
  assert.ok(calls() <= a + 1, 'left alone while it said so');
  delete state.commentsError;
  write();
  const n = nextIssue();
  await until(async () => !(await api('/remote')).github.error, { what: 'the error to clear' });
  comment(n, '/wisp help');
  assert.match(await nextOn(n), /Say what you’d type/);

  state.retryAfter = 2;
  write();
  await until(async () => /slow down/.test((await api('/remote')).github.error));
  delete state.retryAfter;
  write();
  await until(async () => !(await api('/remote')).github.error);
});

test('signed out: nobody may speak, and the view says why', async () => {
  const ch = srv.remote.channels.github;
  state.signedOut = true;
  write();
  await sleep(200); // a call already out comes back first
  ch.me = null;
  const v = await until(async () => {
    const x = await api('/remote');
    return /gh auth login/.test(x.github.error) ? x : null;
  });
  assert.equal(v.github.login, '');
  const n = nextIssue();
  comment(n, '/wisp while signed out');
  await sleep(200);
  assert.equal(tasksOn(n).length, 0);
  delete state.signedOut;
  write();
  await until(async () => !(await api('/remote')).github.error);
  await nextOn(n); // gh knows you again, and it's still fresh
  await settled((await startedOn(n)).id);
  await nextOn(n);
});

test('telemetry: counts only, never what was said', async () => {
  const seen = [];
  const real = srv.telemetry.track;
  srv.telemetry.track = (event, props) => (event === 'channel_event' ? seen.push(props) : 0, real.call(srv.telemetry, event, props));
  const n = nextIssue();
  try {
    comment(n, '/wisp a secret plan about telemetry');
    await nextOn(n);
    await settled((await startedOn(n)).id);
    await nextOn(n);
    await until(() => seen.some((p) => p.kind === 'report')); // counted after the post comes back
  } finally {
    srv.telemetry.track = real;
  }
  // A report from an earlier test can land in the window: what counts is what was sent.
  assert.deepEqual(seen.filter((p) => p.kind !== 'report').map((p) => [p.kind, p.detail]), [['start', 'plain']]);
  assert.ok(seen.some((p) => p.kind === 'report' && p.detail === 'full'));
  assert.ok(!JSON.stringify(seen).includes('secret plan'));
});

test('switched off, it stops looking; on again it starts from now', async () => {
  await api('/remote', { method: 'PUT', body: { github: { enabled: false } } });
  assert.deepEqual((await api('/remote')).github.repos, []);
  const count = () => records(process.env.FAKE_RECORD, 'gh').length;
  // What was already out comes back: on a busy machine that takes a while.
  for (let was = -1; was !== count(); await sleep(1500)) was = count();
  const a = count();
  const n = nextIssue();
  comment(n, '/wisp said while it was off');
  await sleep(1100);
  assert.equal(count(), a, 'no calls while off');
  await api('/remote', { method: 'PUT', body: { github: { enabled: true } } });
  await watching();
  await quiet(n);
  assert.equal(tasksOn(n).length, 0);
});

test('hideNames: what you typed stays, and a name inside a longer word isn’t one', () => {
  const ctx = { projects: [{ name: 'api', path: '/home/me/api' }], machines: [{ name: 'laptop' }], crew: [{ name: 'Ada', cwd: '/home/me/ada' }] };
  assert.equal(hideNames('api · on laptop', ctx, ''), '…');
  assert.equal(hideNames('in /home/me/api, or rapid', ctx, ''), 'in …, or rapid');
  assert.equal(hideNames('Ada on laptop', ctx, 'on laptop @ada'), 'Ada on laptop');
});

test('noMedia: images and tags go, what reads as text stays', () => {
  assert.equal(noMedia('![a](u)'), '!\u200b[a](u)');
  assert.equal(noMedia('[![a](u)](v)'), '[!\u200b[a](u)](v)');
  assert.equal(noMedia('<img src=x>'), '<\u200bimg src=x>');
  assert.equal(noMedia('</style>'), '<\u200b/style>');
  assert.equal(noMedia('wow! [a](u) and 1 < 2'), 'wow! [a](u) and 1 < 2');
});

test('parseRepo: github.com origins and nothing else', () => {
  for (const [url, want] of [
    ['https://github.com/o/r.git', 'o/r'],
    ['https://github.com/o/r', 'o/r'],
    ['https://token@github.com/o/my.repo.git', 'o/my.repo'],
    ['git@github.com:o/r.git', 'o/r'],
    ['ssh://git@github.com/o/r.git', 'o/r'],
    ['https://gitlab.com/o/r.git', null],
    ['https://github.com.evil.dev/o/r.git', null],
    ['/local/path', null],
    ['', null],
  ])
    assert.equal(parseRepo(url), want, url);
});

test('wispCommand: only the first line, and everything after it', () => {
  assert.equal(wispCommand('/wisp'), '');
  assert.equal(wispCommand('/wisp fix it'), 'fix it');
  assert.equal(wispCommand('/WISP fix it\r\nand this'), 'fix it\nand this');
  assert.equal(wispCommand('/wisp\nall on the next line'), 'all on the next line');
  assert.equal(wispCommand('\n\n/wisp after blank lines'), 'after blank lines');
  for (const no of ['', 'fix it', '> /wisp x', '/wispy', '/wisp: x', '    /wisp x', '\t/wisp x', 'a\n/wisp x', '```\n/wisp x\n```', null]) assert.equal(wispCommand(no), null, String(no));
});

test('backoffMs: doubles to 15 minutes; Retry-After wins when it’s longer', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => backoffMs(n, 60_000) / 60_000), [2, 4, 8, 15, 15, 15]);
  assert.equal(backoffMs(1, 60_000, 3600), 3600_000);
  assert.equal(backoffMs(3, 60_000, 30), 480_000);
});
