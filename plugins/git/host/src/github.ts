// GitHub through gh: a PR as the card keeps it, the PR panel's full view, opening, readying and
// squash-merging one, issues, a failing job's log, and whether git and gh are set up here.

import type { GitIssue, PrCheck, PrDetail, PrNote, PrSummary, PrThread, ToolSetup, ToolsStatus } from '@wisp-plugin/git-api';
import type { Tools } from './exec.ts';

type J = Record<string, unknown>;
const obj = (v: unknown): J => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as J) : {});
const arr = (v: unknown): J[] => (Array.isArray(v) ? v.map(obj) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const time = (v: unknown): number | null => (typeof v === 'string' ? Date.parse(v) || null : null);

const PR_FIELDS = 'number,url,title,state,isDraft,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,headRefOid,headRefName,baseRefName,mergedAt';
const DETAIL_FIELDS = `${PR_FIELDS},body,author,additions,deletions,changedFiles,files,reviews,comments,updatedAt`;
const PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAIL = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']);
// Bots that comment on every PR (deploy previews, coverage, CI summaries): folded away, not dropped.
const BOTS = /\[bot\]$|^(github-actions|vercel|netlify|codecov|coveralls|sonarcloud|dependabot|renovate|changeset-bot|linear|railway-app|cloudflare-pages|socket-security)$/i;
export const isBot = (login: string, type?: unknown): boolean => type === 'Bot' || BOTS.test(login);
const loginOf = (a: unknown): string => str(obj(a)['login'] || obj(a)['name']);

export function prSummary(j: J, now: number = Date.now()): PrSummary {
  const checks = { pass: 0, fail: 0, pending: 0 };
  for (const c of arr(j['statusCheckRollup'])) {
    const v = str(c['conclusion'] || c['state']).toUpperCase();
    if (PASS.has(v)) checks.pass++;
    else if (FAIL.has(v)) checks.fail++;
    else checks.pending++;
  }
  return {
    number: Number(j['number']),
    url: str(j['url']),
    title: str(j['title']),
    state: str(j['state']), // OPEN | CLOSED | MERGED
    draft: !!j['isDraft'],
    review: str(j['reviewDecision']), // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ''
    mergeState: str(j['mergeStateStatus']),
    // GitHub can't merge it into its base: both sides changed the same lines (UNKNOWN while it computes).
    conflict: j['mergeable'] === 'CONFLICTING' || j['mergeStateStatus'] === 'DIRTY',
    head: str(j['headRefOid']),
    branch: str(j['headRefName']),
    base: str(j['baseRefName']),
    mergedAt: typeof j['mergedAt'] === 'string' && j['mergedAt'] ? j['mergedAt'] : null,
    checks,
    checkedAt: now,
  };
}

const checkState = (v: string): PrCheck['state'] => (PASS.has(v) ? (v === 'SUCCESS' ? 'pass' : 'skip') : FAIL.has(v) ? 'fail' : 'pending');
const CHECK_ORDER: Record<PrCheck['state'], number> = { fail: 0, pending: 1, pass: 2, skip: 3 };

/** A check run or status, as the panel lists it. */
function checkOf(c: J): PrCheck {
  const run = c['__typename'] !== 'StatusContext' && 'name' in c;
  const start = time(c['startedAt']);
  const end = time(c['completedAt']);
  return {
    name: run ? str(c['name']) : str(c['context'] || c['name']) || 'check',
    workflow: run ? str(c['workflowName']) : '',
    state: checkState(str(c['conclusion'] || c['state'] || c['status']).toUpperCase()),
    url: str(c['detailsUrl'] || c['targetUrl']),
    ms: start && end && end >= start ? end - start : null,
    startedAt: start,
  };
}

/** Inline review comments grouped into threads (REST), newest thread last. */
export function threadsOf(list: readonly unknown[]): PrThread[] {
  const byId = new Map<unknown, PrThread>();
  const threads: PrThread[] = [];
  for (const c of list.map(obj)) {
    const user = obj(c['user']);
    const note: PrNote = { author: loginOf(user), bot: isBot(loginOf(user), user['type']), body: str(c['body']), at: time(c['created_at']), url: str(c['html_url']) };
    const root = c['in_reply_to_id'] ? byId.get(c['in_reply_to_id']) : undefined;
    if (root) {
      root.notes.push(note);
      byId.set(c['id'], root);
      continue;
    }
    const line = typeof c['line'] === 'number' ? c['line'] : typeof c['original_line'] === 'number' ? c['original_line'] : null;
    const t: PrThread = { path: str(c['path']), line, outdated: c['position'] === null && (c['line'] === null || c['line'] === undefined), notes: [note] };
    byId.set(c['id'], t);
    threads.push(t);
  }
  return threads;
}

export function prDetailOf(j: J, threads: PrThread[] = [], now: number = Date.now()): PrDetail {
  const reviews = arr(j['reviews']).filter((r) => r['state'] !== 'PENDING');
  // Everything people said, in order: comments, and reviews with words (an approval alone is a chip).
  const notes: PrNote[] = [
    ...arr(j['comments']).map((c): PrNote => ({ kind: 'comment', author: loginOf(c['author']), bot: isBot(loginOf(c['author'])), body: str(c['body']), at: time(c['createdAt']), url: str(c['url']) })),
    ...reviews.filter((r) => str(r['body']).trim()).map((r): PrNote => ({ kind: 'review', state: str(r['state']), author: loginOf(r['author']), bot: isBot(loginOf(r['author'])), body: str(r['body']), at: time(r['submittedAt']), url: '' })),
  ].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  // Where each reviewer stands now: their latest approval or change request.
  const verdicts = new Map<string, string>();
  for (const r of reviews) if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(str(r['state']))) verdicts.set(loginOf(r['author']), str(r['state']));
  const summary = prSummary(j, now);
  const files = arr(j['files']);
  return {
    ...summary,
    summary, // what the card keeps
    author: loginOf(j['author']),
    body: str(j['body']),
    additions: Number(j['additions']) || 0,
    deletions: Number(j['deletions']) || 0,
    changedFiles: typeof j['changedFiles'] === 'number' ? j['changedFiles'] : files.length,
    files: files.slice(0, 300).map((f) => ({ path: str(f['path']), additions: Number(f['additions']) || 0, deletions: Number(f['deletions']) || 0 })),
    checkList: arr(j['statusCheckRollup']).map(checkOf).sort((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state] || a.name.localeCompare(b.name)),
    reviewers: [...verdicts].filter(([, v]) => v !== 'DISMISSED').map(([author, state]) => ({ author, state })),
    notes,
    threads,
    updatedAt: time(j['updatedAt']),
  };
}

const parse = (out: string, what: string): unknown => {
  try {
    return JSON.parse(out) as unknown;
  } catch {
    throw new Error(`gh answered with something that isn’t ${what}`);
  }
};

export class GitHub {
  readonly #t: Tools;
  readonly #now: () => number;
  constructor(t: Tools, now: () => number) {
    this.#t = t;
    this.#now = now;
  }

  async prView(cwd: string, ref: string | number): Promise<PrSummary> {
    return prSummary(obj(parse(await this.#t.gh(cwd, ['pr', 'view', String(ref), '--json', PR_FIELDS]), 'a pull request')), this.#now());
  }

  /** The PR in full. Its inline threads are a second call that may fail (an old gh, no access). */
  async prDetail(cwd: string, ref: string | number): Promise<PrDetail> {
    const j = obj(parse(await this.#t.gh(cwd, ['pr', 'view', String(ref), '--json', DETAIL_FIELDS]), 'a pull request'));
    const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(str(j['url']));
    const raw = m ? await this.#t.gh(cwd, ['api', `repos/${m[1]}/${m[2]}/pulls/${m[3]}/comments?per_page=100`]).then((o) => JSON.parse(o) as unknown, () => []) : [];
    return prDetailOf(j, threadsOf(Array.isArray(raw) ? raw : []), this.#now());
  }

  /** Opens it; resolves to its URL (gh's last line). */
  async prCreate(cwd: string, o: { base: string; head: string; title: string; body: string; draft?: boolean }): Promise<string> {
    const out = await this.#t.gh(cwd, ['pr', 'create', '--base', o.base, '--head', o.head, '--title', o.title.trim(), '--body', o.body.trim() || ' ', ...(o.draft ? ['--draft'] : [])]);
    return out.split('\n').pop() ?? '';
  }

  async prReady(cwd: string, ref: string | number): Promise<void> {
    await this.#t.gh(cwd, ['pr', 'ready', String(ref)]);
  }

  /** Squash-merge the exact head that was reviewed. */
  async prMerge(cwd: string, ref: string | number, head: string): Promise<void> {
    await this.#t.gh(cwd, ['pr', 'merge', String(ref), '--squash', '--match-head-commit', head]);
  }

  async issues(repo: string, q = '', limit = 50): Promise<GitIssue[]> {
    const args = ['issue', 'list', '--repo', repo, '--state', 'open', '--limit', String(limit), '--json', 'number,title,labels,assignees,url,updatedAt,body'];
    if (q) args.push('--search', q);
    const list = parse((await this.#t.gh(undefined, args, { timeoutMs: 30_000 })) || '[]', 'a list of issues');
    return (Array.isArray(list) ? list : []).map(obj).map((i) => ({
      number: Number(i['number']),
      title: str(i['title']),
      url: str(i['url']),
      labels: Array.isArray(i['labels']) ? (i['labels'] as GitIssue['labels']) : [],
      assignees: arr(i['assignees']).map((a) => ({ login: str(a['login']), name: str(a['name']) })),
      updatedAt: typeof i['updatedAt'] === 'string' ? i['updatedAt'] : null,
      body: str(i['body']),
    }));
  }

  /** `gh run view --log-failed` of one Actions job: '' when gh can't say. */
  runLog(cwd: string, repo: string, job: string): Promise<string> {
    return this.#t.gh(cwd, ['run', 'view', '--job', job, '--log-failed', '-R', repo], { timeoutMs: 60_000 }).catch(() => '');
  }

  /** What Ship it needs here: git, and gh signed in. signedIn null: an answer we don't know (offline). */
  async tools(platform: string = process.platform): Promise<ToolsStatus> {
    const probe = async (bin: string, args: string[]): Promise<{ missing: boolean; ok: boolean; out: string }> => {
      const r = await this.#t.proc.exec(bin, args, { timeoutMs: 8000 });
      return { missing: r.code === null && /ENOENT/.test(r.stderr), ok: r.code === 0, out: `${r.stdout}${r.stderr}` };
    };
    const [g, h] = await Promise.all([probe(await this.#t.gitBin(), ['--version']), probe(this.#t.ghBin(), ['auth', 'status', '--hostname', 'github.com'])]);
    // macOS ships a git that only offers to install the command line tools: it fails, not ENOENT.
    const gitOk = g.ok && /git version/.test(g.out);
    const signedIn = h.missing ? null : h.ok ? true : /not logged in|no longer valid|invalid|gh auth login/i.test(h.out) ? false : null;
    return {
      git: { installed: gitOk, ...(!gitOk && { setup: toolSetup('git', platform) }) },
      gh: { installed: !h.missing, signedIn, ...(h.missing && { setup: toolSetup('gh', platform) }) },
    };
  }
}

const TOOL_SETUP: Record<'git' | 'gh', Record<string, ToolSetup>> = {
  git: {
    darwin: { tip: 'Install Apple’s command line tools: they include git', command: 'xcode-select --install', url: 'https://git-scm.com/downloads/mac' },
    win32: { tip: 'Install Git for Windows, then restart wisp', command: 'winget install --id Git.Git -e --source winget', url: 'https://git-scm.com/downloads/win' },
    linux: { tip: 'Install git with your package manager (apt, dnf, pacman…)', command: 'sudo apt install -y git', url: 'https://git-scm.com/downloads/linux' },
  },
  gh: {
    darwin: { tip: 'Install the GitHub CLI, then sign in here', command: 'brew install gh', url: 'https://cli.github.com' },
    win32: { tip: 'Install the GitHub CLI, then restart wisp and sign in here', command: 'winget install --id GitHub.cli -e --source winget', url: 'https://cli.github.com' },
    linux: { tip: 'Install the GitHub CLI with your package manager, then sign in here', command: 'sudo apt install -y gh', url: 'https://github.com/cli/cli/blob/trunk/docs/install_linux.md' },
  },
};
export const toolSetup = (id: 'git' | 'gh', platform: string = process.platform): ToolSetup => TOOL_SETUP[id][platform] ?? TOOL_SETUP[id]['linux'] ?? { tip: '', command: '', url: '' };
