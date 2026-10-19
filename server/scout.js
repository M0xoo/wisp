// The scout: a quick look before an Auto task starts. scanProject() is free (files on disk: the
// test command, languages, size) and cached; scoutTask() asks a cheap model, read-only, which kind
// of task it is, how big, and which files matter. Auto routes on that, and the agent gets the
// file list and test command as a head start.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { detectTests } from './check.js';
import { askJson } from './quick.js';
import { TYPES } from './router.js';

const scans = new Map(); // dir -> { at, value }
const SCAN_TTL_MS = 10 * 60_000;

export function scanProject(dir, project = null) {
  const key = `${dir}\0${project?.testCommand || ''}`;
  const hit = scans.get(key);
  if (hit && Date.now() - hit.at < SCAN_TTL_MS) return hit.value;
  let files = [];
  try {
    files = execFileSync('git', ['ls-files'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20, timeout: 5000 }).toString().split('\n').filter(Boolean);
  } catch {}
  const ext = {};
  for (const f of files) {
    const e = path.extname(f).slice(1).toLowerCase();
    if (e && e.length <= 5) ext[e] = (ext[e] || 0) + 1;
  }
  const value = {
    tests: detectTests(dir, project),
    languages: Object.entries(ext).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([e]) => e),
    files: files.length,
  };
  scans.set(key, { at: Date.now(), value });
  return value;
}

// { type, size, files, tests, notes } from a cheap model, or null. Read-only, at most timeoutMs.
export async function scoutTask({ prompt, cwd, agents, timeoutMs = 75_000, scan = null }) {
  const ask = `A coding agent is about to work on the task below in this repository. Take a quick, read-only look (list and read a few files; don't run anything slow) and reply with one JSON object:

{"type": one of ${TYPES.map((t) => `"${t}"`).join(', ')},
 "size": "S" (a few lines in one file) | "M" (a few files) | "L" (many files or a design decision),
 "files": [up to 8 repo-relative paths that will most likely change or matter],
 "tests": "the command that runs the tests that cover this, or empty",
 "notes": "one sentence the agent should know before starting, or empty"}
${scan?.tests?.command ? `\nThe project's test command is \`${scan.tests.command}\`.` : ''}
<task>
${String(prompt).slice(0, 6000)}
</task>`;
  const j = await askJson({ agents, prompt: ask, cwd, timeoutMs });
  if (!j) return null;
  const files = (Array.isArray(j.files) ? j.files : []).map(String).filter((f) => f && !f.startsWith('/') && !f.includes('..')).slice(0, 8);
  return {
    type: TYPES.includes(j.type) ? j.type : null,
    size: ['S', 'M', 'L'].includes(j.size) ? j.size : null,
    files,
    tests: typeof j.tests === 'string' ? j.tests.slice(0, 200) : '',
    notes: typeof j.notes === 'string' ? j.notes.slice(0, 300) : '',
  };
}

// What the agent is told, appended to its system prompt.
export function scoutNote(scout) {
  if (!scout) return '';
  const lines = [];
  if (scout.files?.length) lines.push(`Likely relevant files: ${scout.files.map((f) => `\`${f}\``).join(', ')}.`);
  const tests = scout.tests || scout.testCommand;
  if (tests) lines.push(`Tests: \`${tests}\`. When you finish, wisp runs the project's tests itself and sends any new failures back to you.`);
  if (scout.notes) lines.push(scout.notes);
  return lines.length ? `\n\n## Scouted by wisp\n\n${lines.join('\n')}` : '';
}
