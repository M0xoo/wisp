// git and gh: the subcommand says what happens, its operands say to what.

import { clip } from '../text.ts';
import { operands, pick, result, valueOf, type Desc, type ShowPath } from './argv.ts';
import { describeGrep } from './files.ts';

interface Git {
  rest: string[];
  ops: string[];
  has: (...flags: string[]) => boolean;
  f: ShowPath;
}

type GitDescriber = (g: Git) => Desc;

const shown = (ops: readonly string[], f: ShowPath): string => ops.map(f).slice(0, 2).join(', ');

function diff({ ops, has, f }: Git): Desc {
  if (has('--stat', '--name-only', '--name-status', '--shortstat')) return result('Summarising changes');
  if (has('--cached', '--staged')) return result('Reviewing staged changes');
  if (!ops.length) return result('Viewing changes');
  // Paths read as "in a.js"; revisions and ranges (main..HEAD) as "(main..HEAD)".
  const paths = ops.some((o) => o.includes('/') || o.includes('.')) && !ops.some((o) => o.includes('..'));
  return result(`Viewing changes${paths ? ` in ${shown(ops, f)}` : ` (${clip(ops.join(' '), 30)})`}`);
}

function log({ ops, f }: Git): Desc {
  const last = ops.at(-1);
  const ofFile = ops[0] !== undefined && !ops[0].includes('..') && last !== undefined && /[/.]/.test(last);
  return result(ofFile ? `Reading the history of ${f(last)}` : 'Reading git history');
}

function show({ ops }: Git): Desc {
  const o = ops[0];
  if (!o) return result('Viewing the last commit');
  if (!o.includes(':')) return result(`Viewing commit ${clip(o, 20)}`);
  const [rev, ...file] = o.split(':');
  return result(`Reading ${file.join(':')} at ${rev || 'the index'}`);
}

function commit({ rest, has }: Git): Desc {
  const m = valueOf(rest, ['-m', '--message']);
  return result(has('--amend') ? 'Amending the last commit' : m ? `Committing “${clip(m.split('\n')[0], 50)}”` : 'Committing changes');
}

function checkout({ rest, ops, has, f }: Git): Desc {
  if (has('-b', '-B', '-c', '-C')) return result(`Creating branch ${valueOf(rest, ['-b', '-B', '-c', '-C']) ?? ''}`.trim());
  if (rest.includes('--')) return result(`Discarding changes to ${operands(rest.slice(rest.indexOf('--') + 1)).map(f).join(', ') || 'files'}`);
  return result(ops[0] ? `Switching to ${clip(ops[0], 40)}` : 'Switching branch');
}

function branch({ ops, has }: Git): Desc {
  if (has('-d', '-D', '--delete')) return result(`Deleting branch ${ops[0] ?? ''}`.trim());
  if (has('-m', '-M')) return result('Renaming a branch');
  return result(ops[0] && !has('--list', '-a', '-r', '-v', '-vv') ? `Creating branch ${ops[0]}` : has('--show-current') ? 'Checking the current branch' : 'Listing branches');
}

// `--abort` / `--continue`, else the operation itself.
const resumable =
  (abort: string, carryOn: string, start: (g: Git) => string): GitDescriber =>
  (g) =>
    result(g.has('--abort') ? abort : g.has('--continue') ? carryOn : start(g));

const STASH: Record<string, string> = { pop: 'Restoring stashed changes', apply: 'Restoring stashed changes', list: 'Listing stashes', drop: 'Dropping a stash', show: 'Viewing a stash' };
const WORKTREE: Record<string, string> = { add: 'Creating a worktree', remove: 'Removing a worktree', list: 'Listing worktrees', prune: 'Cleaning up worktrees' };
const fixed = (text: string): GitDescriber => () => result(text);

const GIT = new Map<string, GitDescriber>([
  ['status', fixed('Checking git status')],
  ['diff', diff],
  ['log', log],
  ['shortlog', log],
  ['reflog', log],
  ['show', show],
  ['blame', ({ ops, f }) => result(`Checking who changed ${ops.length ? f(ops.at(-1)) : 'the file'}`)],
  ['add', ({ ops, has, f }) => result(has('-A', '--all', '.') || ops.includes('.') ? 'Staging all changes' : `Staging ${shown(ops, f) || 'changes'}`)],
  ['commit', commit],
  ['push', ({ ops, has }) => result(has('--tags') ? 'Pushing tags' : ops[1] ? `Pushing ${clip(ops[1], 40)}` : 'Pushing to the remote')],
  ['pull', fixed('Pulling the latest changes')],
  ['fetch', ({ ops }) => result(ops[0] ? `Fetching from ${ops[0]}` : 'Fetching from the remote')],
  ['clone', ({ ops }) => result(`Cloning ${ops[0] ? clip(ops[0].replace(/^https?:\/\/(www\.)?/, '').replace(/\.git$/, ''), 50) : 'a repository'}`)],
  ['checkout', checkout],
  ['switch', checkout],
  ['restore', ({ ops, f }) => result(`Restoring ${shown(ops, f) || 'files'}`)],
  ['branch', branch],
  ['merge', resumable('Aborting the merge', 'Finishing the merge', ({ ops }) => `Merging ${ops[0] ?? 'changes'}`)],
  ['rebase', resumable('Aborting the rebase', 'Continuing the rebase', ({ ops }) => `Rebasing onto ${ops[0] ?? 'upstream'}`)],
  ['cherry-pick', resumable('Aborting the cherry-pick', 'Continuing the cherry-pick', ({ ops }) => `Cherry-picking ${clip(ops.join(' '), 30) || 'a commit'}`)],
  ['revert', ({ ops }) => result(`Reverting ${ops[0] ?? 'a commit'}`)],
  ['reset', ({ ops, has, f }) => result(has('--hard') ? 'Discarding local changes' : ops.length ? `Unstaging ${shown(ops, f)}` : 'Resetting changes')],
  ['stash', ({ rest }) => result(pick(STASH, rest[0]) ?? 'Stashing changes')],
  ['tag', ({ ops, has }) => result(ops.length && !has('-l', '--list') ? `Tagging ${ops[0]}` : 'Listing tags')],
  ['remote', ({ rest }) => result(rest[0] === 'add' ? `Adding remote ${rest[1] ?? ''}`.trim() : 'Checking remotes')],
  ['worktree', ({ rest }) => result(pick(WORKTREE, rest[0]) ?? 'Managing worktrees')],
  ['rm', ({ ops, f }) => result(`Removing ${shown(ops, f) || 'files'} from git`)],
  ['mv', ({ ops, f }) => result(ops.length === 2 ? `Renaming ${f(ops[0])} to ${f(ops[1])}` : 'Renaming files')],
  ['grep', ({ rest, f }) => describeGrep('git grep', rest, f, false)],
  ...['ls-files', 'ls-tree'].map((s): [string, GitDescriber] => [s, fixed('Listing tracked files')]),
  ...['rev-parse', 'rev-list', 'merge-base', 'describe', 'name-rev', 'symbolic-ref', 'for-each-ref', 'cat-file'].map((s): [string, GitDescriber] => [s, fixed('Inspecting the repository')]),
  ['config', fixed('Checking git settings')],
  ['init', fixed('Creating a git repository')],
  ['clean', fixed('Removing untracked files')],
  ['bisect', fixed('Bisecting history')],
  ['submodule', fixed('Updating submodules')],
  ['apply', fixed('Applying a patch')],
  ['am', fixed('Applying a patch')],
  ['format-patch', fixed('Exporting a patch')],
]);

export function describeGit(args: readonly string[], f: ShowPath): Desc {
  // Skip global options: git -C dir -c k=v --no-pager status
  let i = 0;
  while (i < args.length && (args[i] ?? '').startsWith('-')) i += /^(-C|-c|--git-dir|--work-tree)$/.test(args[i] ?? '') ? 2 : 1;
  const [sub, ...rest] = args.slice(i);
  if (sub === undefined) return result('Running git');
  const describe = GIT.get(sub);
  if (!describe) return result(`Running git ${sub}`);
  return describe({ rest, ops: operands(rest), has: (...flags) => flags.some((x) => rest.includes(x)), f });
}

const PR = (ref: string): Record<string, string> => ({
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
});
const ISSUE = (ref: string): Record<string, string> => ({ create: 'Opening an issue', view: `Reading issue${ref}`, list: 'Listing issues', comment: `Commenting on issue${ref}`, close: `Closing issue${ref}`, edit: `Editing issue${ref}` });
const RUN: Record<string, string> = { list: 'Listing CI runs', view: 'Checking a CI run', watch: 'Watching a CI run', rerun: 'Re-running CI' };
const RELEASE: Record<string, string> = { create: 'Publishing a GitHub release', view: 'Viewing a release', list: 'Listing releases', edit: 'Editing a release', upload: 'Uploading release files' };
const REPO: Record<string, string> = { view: 'Viewing the repository', clone: 'Cloning a repository', create: 'Creating a repository', fork: 'Forking a repository' };

export function describeGh(args: readonly string[]): Desc {
  const [area, action, ...rest] = args;
  const num = operands(rest).find((o) => /^#?\d+$/.test(o));
  const ref = num ? ` #${num.replace('#', '')}` : '';
  if (area === 'pr') return result(pick(PR(ref), action) ?? 'Working with pull requests');
  if (area === 'issue') return result(pick(ISSUE(ref), action) ?? 'Working with issues');
  if (area === 'run') return result(pick(RUN, action) ?? 'Checking CI runs');
  if (area === 'workflow') return result(action === 'run' ? 'Starting a workflow' : 'Checking workflows');
  if (area === 'release') return result(pick(RELEASE, action) ?? 'Working with releases');
  if (area === 'repo') return result(pick(REPO, action) ?? 'Working with the repository');
  if (area === 'api') {
    const what = action && !action.startsWith('-') ? ` (${clip(action.replace(/^\/?repos\/[^/]+\/[^/]+\/?/, ''), 30) || 'repo'})` : '';
    return result(`Calling the GitHub API${what}`);
  }
  if (area === 'auth') return result('Checking GitHub sign-in');
  if (area === 'search') return result('Searching GitHub');
  return result(`Running gh ${area ?? ''}`.trim());
}
