// Per-turn git checkpoints, single-file revert, turn rollback, and action command execution.

import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { killTree } from './proc.js';
import { MAX_SNAPSHOT, rel } from './adapters/common.js';

const MAX_EXEC_OUTPUT = 32 * 1024;
const EXEC_TIMEOUT_MS = 60_000;

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
    ...opts,
  });
}

function tryGit(cwd, args, opts) {
  try {
    return git(cwd, args, opts).toString('utf8').trim();
  } catch {
    return null;
  }
}

// Snapshot the working tree before a turn starts. `git stash create` writes a commit object
// holding tracked working-tree and index changes without touching HEAD, the index, or the stash
// reflog; if the tree is clean it prints nothing and HEAD is the snapshot. Pinning the SHA under
// refs/wisp/checkpoints/<session>/<turn> keeps `git gc` from collecting it.
export function captureCheckpoint(cwd, sessionId, turnId) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const head = tryGit(cwd, ['rev-parse', '--verify', 'HEAD']);
  if (!head) return null;
  const stash = tryGit(cwd, ['stash', 'create']);
  const commit = stash || head;
  if (sessionId && turnId) {
    tryGit(cwd, ['update-ref', `refs/wisp/checkpoints/${sessionId}/${turnId}`, commit]);
  }
  const branch = tryGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || '';
  const untrackedRaw = tryGit(cwd, ['ls-files', '--others', '--exclude-standard'], { maxBuffer: 2 * 1024 * 1024 });
  const untracked = untrackedRaw ? untrackedRaw.split('\n').filter(Boolean).slice(0, 500) : [];
  return {
    commit,
    head,
    dirty: !!stash,
    branch,
    untracked,
    at: Date.now(),
  };
}

// The first turn in a worktree made for it: clean, at its base commit, so the checkpoint is known
// without asking git (captureCheckpoint's synchronous calls held up every launch, once per run).
// The base commit stays reachable from the base branch, so it needs no pinning ref.
export function freshCheckpoint(wt) {
  return { commit: wt.head, head: wt.head, dirty: false, branch: wt.branch, untracked: [], at: Date.now() };
}

export function cleanupCheckpoints(cwd, sessionId) {
  if (!cwd || !sessionId || !fs.existsSync(cwd)) return;
  const refs = tryGit(cwd, ['for-each-ref', '--format=%(refname)', `refs/wisp/checkpoints/${sessionId}/`]);
  if (!refs) return;
  for (const ref of refs.split('\n').filter(Boolean)) {
    tryGit(cwd, ['update-ref', '-d', ref]);
  }
}

export function readGitFile(cwd, commit, file) {
  if (!cwd || !commit || !file || path.isAbsolute(file)) return null;
  const gitPath = `./${file.split(path.sep).join('/')}`;
  try {
    const out = git(cwd, ['show', `${commit}:${gitPath}`], { maxBuffer: 8 * MAX_SNAPSHOT });
    return out.length <= MAX_SNAPSHOT ? out.toString('utf8') : '';
  } catch {
    return null;
  }
}

function readDiskSnapshot(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    return st.size <= MAX_SNAPSHOT ? fs.readFileSync(abs, 'utf8') : null;
  } catch {
    return null;
  }
}

function writeDiskSnapshot(abs, content) {
  if (content === null || content === undefined) {
    fs.rmSync(abs, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function resolveInsideCwd(cwd, file) {
  if (!file || typeof file !== 'string') {
    throw Object.assign(new Error('file path required'), { status: 400 });
  }
  const abs = path.resolve(cwd, file);
  const relPath = path.relative(cwd, abs);
  if (!relPath || relPath.startsWith('..') || path.isAbsolute(relPath)) {
    throw Object.assign(new Error(`File lies outside the project folder: ${file}`), { status: 400 });
  }
  return { abs, relPath: rel(file, cwd) || relPath };
}

function findChangeEntry(turn, file, cwd) {
  if (!turn?.changes?.length) return null;
  const r = rel(file, cwd);
  return (
    turn.changes.find((c) => c.file === file || c.file === r) ||
    turn.changes.find((c) => c.file.endsWith('/' + file) || file.endsWith('/' + c.file))
  );
}

const sessionDir = (session) => session.worktree?.cwd || session.cwd;

// Revert (or re-apply when restore=true) a single file's changes from `turn`.
export function revertFileChange(session, turn, file, { restore = false } = {}) {
  const cwd = sessionDir(session);
  const { abs, relPath } = resolveInsideCwd(cwd, file);
  const entry = findChangeEntry(turn, file, cwd);
  const commit = turn.checkpoint?.commit;
  if (!entry && !commit) {
    throw Object.assign(new Error(`No captured changes or checkpoint for ${relPath}`), { status: 404 });
  }

  if (restore) {
    if (entry?.afterSnapshot !== undefined) {
      writeDiskSnapshot(abs, entry.afterSnapshot);
    } else if (entry?.edits?.length) {
      if (entry.op === 'create' || entry.op === 'write') {
        writeDiskSnapshot(abs, entry.edits.at(-1).after ?? '');
      } else {
        let cur = readDiskSnapshot(abs) ?? '';
        for (const e of entry.edits) {
          if (e.before && cur.includes(e.before)) cur = cur.replace(e.before, e.after ?? '');
        }
        writeDiskSnapshot(abs, cur);
      }
    } else {
      throw Object.assign(new Error(`Nothing to re-apply for ${relPath}`), { status: 400 });
    }
    if (entry) entry.reverted = false;
    if (turn.changes?.every((c) => !c.reverted)) delete turn.rolledBackAt;
    return { file: entry?.file || relPath, reverted: false };
  }

  // Save what is currently on disk so the user can Undo / Re-apply in one click.
  const currentOnDisk = readDiskSnapshot(abs);
  if (entry) entry.afterSnapshot = currentOnDisk;

  // 1. Prefer the exact pre-turn file content recorded when the turn first touched the file.
  if (entry && entry.beforeFile !== undefined) {
    writeDiskSnapshot(abs, entry.op === 'create' ? null : entry.beforeFile);
  } else if (commit) {
    // 2. Otherwise check the turn's git checkpoint commit.
    const fromGit = readGitFile(cwd, commit, entry?.file || relPath);
    if (fromGit !== null) {
      writeDiskSnapshot(abs, fromGit);
    } else if (entry?.op === 'create' || !(turn.checkpoint?.untracked || []).includes(entry?.file || relPath)) {
      writeDiskSnapshot(abs, null);
    } else if (entry?.edits?.length) {
      reverseEditsOnDisk(abs, entry);
    }
  } else if (entry) {
    // 3. Fallback for non-git folders or legacy turns.
    if (entry.op === 'create') {
      writeDiskSnapshot(abs, null);
    } else if (entry.op === 'write' && entry.edits?.[0]?.before !== undefined) {
      writeDiskSnapshot(abs, entry.edits[0].before);
    } else {
      reverseEditsOnDisk(abs, entry);
    }
  }

  if (entry) entry.reverted = true;
  return { file: entry?.file || relPath, reverted: true };
}

function reverseEditsOnDisk(abs, entry) {
  const cur = readDiskSnapshot(abs);
  if (cur === null) return;
  let next = cur;
  for (const e of [...(entry.edits || [])].reverse()) {
    if (e.after && next.includes(e.after)) {
      next = next.replace(e.after, e.before ?? '');
    }
  }
  writeDiskSnapshot(abs, next);
}

// Restore the project working tree to the state before `turn` ran (or undo that rollback when restore=true).
export function rollbackToTurn(session, turn, { restore = false } = {}) {
  const cwd = sessionDir(session);
  const idx = session.turns.indexOf(turn);
  if (idx < 0) throw Object.assign(new Error('No such turn'), { status: 404 });
  const affected = session.turns.slice(idx);
  const touchedFiles = [...new Set(affected.flatMap((t) => (t.changes || []).map((c) => c.file)))];

  if (restore) {
    const pre = turn.preRollback;
    if (!pre) {
      for (const t of affected) {
        for (const c of t.changes || []) {
          revertFileChange(session, t, c.file, { restore: true });
        }
        delete t.rolledBackAt;
      }
      return { files: touchedFiles, rolledBack: false };
    }
    if (pre.commit) {
      tryGit(cwd, ['checkout', pre.commit, '--', '.']);
      tryGit(cwd, ['read-tree', 'HEAD']);
    }
    for (const [relFile, content] of Object.entries(pre.files || {})) {
      const { abs } = resolveInsideCwd(cwd, relFile);
      writeDiskSnapshot(abs, content);
    }
    for (const t of affected) {
      delete t.rolledBackAt;
      for (const c of t.changes || []) c.reverted = false;
    }
    return { files: Object.keys(pre.files || {}).length ? Object.keys(pre.files) : touchedFiles, rolledBack: false };
  }

  const cp = turn.checkpoint;
  const preUntracked = new Set(cp?.untracked || []);
  const curUntrackedRaw = cp?.commit ? tryGit(cwd, ['ls-files', '--others', '--exclude-standard'], { maxBuffer: 2 * 1024 * 1024 }) : null;
  const curUntracked = curUntrackedRaw ? curUntrackedRaw.split('\n').filter(Boolean).slice(0, 500) : [];
  const newUntracked = curUntracked.filter((f) => !preUntracked.has(f));

  // Snapshot current state of all affected files + new untracked files + git tree before rolling back so Undo works.
  const preFiles = {};
  for (const f of [...new Set([...touchedFiles, ...newUntracked])]) {
    try {
      const { abs } = resolveInsideCwd(cwd, f);
      preFiles[f] = readDiskSnapshot(abs);
    } catch {}
  }
  const preCp = captureCheckpoint(cwd, session.id, `${turn.id}-undo`);
  turn.preRollback = { commit: preCp?.commit || null, files: preFiles };

  if (cp?.commit) {
    // Find any tracked files added since the checkpoint commit so we can remove them too.
    const addedRaw = tryGit(cwd, ['diff', '--name-only', '--diff-filter=D', 'HEAD', cp.commit]) || '';
    const addedTracked = addedRaw.split('\n').filter(Boolean);

    // Restore tracked files from the checkpoint commit.
    tryGit(cwd, ['checkout', cp.commit, '--', '.']);
    // Keep the git index aligned with HEAD rather than the stash commit's tree.
    tryGit(cwd, ['read-tree', 'HEAD']);

    for (const f of [...addedTracked, ...newUntracked]) {
      try {
        const { abs } = resolveInsideCwd(cwd, f);
        fs.rmSync(abs, { force: true });
      } catch {}
    }

    // Restore or remove untracked files touched in the affected turns.
    for (const t of affected.slice().reverse()) {
      for (const c of t.changes || []) {
        try {
          const { abs, relPath } = resolveInsideCwd(cwd, c.file);
          const inGit = readGitFile(cwd, cp.commit, relPath) !== null;
          if (!inGit) {
            if (c.op === 'create' || (!preUntracked.has(relPath) && c.beforeFile === null)) {
              fs.rmSync(abs, { force: true });
            } else if (typeof c.beforeFile === 'string') {
              writeDiskSnapshot(abs, c.beforeFile);
            }
          }
        } catch {}
      }
    }
  } else {
    // Non-git folder or turn without a git checkpoint: revert each turn's captured file changes in reverse.
    for (const t of affected.slice().reverse()) {
      for (const c of [...(t.changes || [])].reverse()) {
        revertFileChange(session, t, c.file, { restore: false });
      }
    }
  }

  const now = Date.now();
  for (const t of affected) {
    t.rolledBackAt = now;
    for (const c of t.changes || []) c.reverted = true;
  }
  return { files: touchedFiles, rolledBack: true, commit: cp?.head || cp?.commit || null };
}

// Run a shell command from an actionable presentation block inside `cwd`.
export function execCommand(cwd, command, { timeoutMs = EXEC_TIMEOUT_MS } = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) return Promise.reject(Object.assign(new Error('command required'), { status: 400 }));
  const t0 = Date.now();

  return new Promise((resolve) => {
    const child = nodeSpawn(cmd, {
      cwd,
      env: { ...process.env, PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', CI: '1' },
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const append = (chunk) => {
      if (out.length < MAX_EXEC_OUTPUT) out += chunk.toString('utf8').slice(0, MAX_EXEC_OUTPUT - out.length);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        command: cmd,
        output: (out ? `${out}\n` : '') + err.message,
        exitCode: 1,
        durationMs: Date.now() - t0,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const suffix = timedOut ? `\n[timed out after ${Math.round(timeoutMs / 1000)}s]` : '';
      resolve({
        command: cmd,
        output: (out.replace(/\s+$/, '') + suffix).trim(),
        exitCode: timedOut ? 124 : (code ?? 1),
        durationMs: Date.now() - t0,
      });
    });
  });
}
