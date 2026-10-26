// Helpers shared by the adapters: process plumbing, labels, and diff capture.

import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile, killTree } from '../proc.js';
import { gitSync } from '../git.js';
import { MAX_SNAPSHOT, rel } from '../paths.js';
import { clip } from '../util.js';

export const ASK_TIMEOUT_MS = 7 * 24 * 3600 * 1000; // ask_user may wait for the human a long time

export function detectVersion(bin, args = ['--version']) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 10_000 }, (err, stdout) => {
      resolve(err ? { available: false, error: err.message } : { available: true, version: stdout.trim().split('\n')[0] });
    });
  });
}

// Detect `bin`, or when it doesn't run, the first copy in fallbacks() that does: CLIs that live
// off PATH (an install wisp made, a desktop app's bundled CLI). Resolves detectVersion's answer
// plus the `bin` that answered. An explicit WISP_*_BIN override (`pinned`) is never second-guessed.
export async function detectFirst(bin, fallbacks, pinned = false) {
  const found = await detectVersion(bin);
  if (found.available || pinned) return { ...found, bin };
  for (const b of fallbacks().filter((f) => fs.existsSync(f))) {
    const there = await detectVersion(b);
    if (there.available) return { ...there, bin: b };
  }
  return { ...found, bin };
}

// Run `bin args` and resolve with stdout, or '' on any failure. Used for model discovery.
export function quietOutput(bin, args, timeout = 15_000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

// `bin --help`, from whichever stream it prints to (agy uses stderr), or ''.
export function helpText(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['--help'], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve(err ? '' : `${stdout}\n${stderr}`));
  });
}

// The thinking levels a CLI's --help gives for its effort flag: "(low, medium, high)",
// "(low|medium|high)" or "[possible values: low, medium, high]". [] when it lists none.
export function helpEfforts(text) {
  const at = text.search(/--(?:reasoning-)?effort\b/);
  if (at < 0) return [];
  // Just this flag's entry: up to the next option.
  const entry = text.slice(at).split(/\n\s*-{1,2}\w/)[0];
  const m = entry.match(/(?:\(\s*|possible values:\s*)([a-z]+(?:\s*[,|]\s*[a-z]+)+)/);
  return m ? m[1].split(/\s*[,|]\s*/) : [];
}

// Spawn a CLI that prints one JSON object per line. onJson gets each parsed line;
// onClose({ code, signal, stderr, stopped, stopRequested }) must emit the final `result` if the
// stream didn't. stopped: killed by stop() or a signal; stopRequested: by stop() only.
// onStderr (optional) sees stderr as it comes, for CLIs that only report trouble there.
export function spawnJsonl({ bin, args, cwd, env, input, onJson, onClose, onEvent, onStderr }) {
  // Some CLIs (opencode) take their working directory from $PWD rather than the real cwd.
  const child = spawn(bin, args, { cwd, env: { ...env, PWD: cwd }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {}); // the CLI may exit before reading stdin
  child.stdin.end(input ?? '');

  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-8000);
    onStderr?.(String(d));
  });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    onJson(msg);
  });

  let failed = false;
  let stopping = false; // Windows reports a taskkill'd child as an exit code, not a signal
  const done = new Promise((resolve) => {
    child.on('error', (err) => {
      failed = true;
      onEvent({ type: 'result', isError: true, text: `Could not start \`${bin}\`: ${err.message}` });
      resolve();
    });
    child.on('close', (code, signal) => {
      if (!failed) onClose({ code, signal, stderr: stderr.trim(), stopped: stopping || signal === 'SIGTERM' || signal === 'SIGINT', stopRequested: stopping });
      resolve();
    });
  });

  return {
    done,
    stop() {
      stopping = true;
      killTree(child);
    },
  };
}

// The result text for a CLI that ended without saying why.
export const exitText = (bin, code, signal) => `${bin} exited with ${signal || `code ${code}`}`;

export function attachmentNote(files, how = 'Read images and PDFs with your file-reading tool') {
  if (!files.length) return '';
  const lines = files.map((f) => `- ${f.path}  (${f.mime}, ${Math.max(1, Math.round(f.size / 1024))} KB)`);
  return `\n\n<attachments>\nThe user attached these files. ${how}; for video/audio/other formats use the shell (e.g. ffmpeg, ffprobe) if needed.\n${lines.join('\n')}\n</attachments>`;
}

// Harnesses without a system-prompt flag get the wisp protocol in front of the first prompt.
// Follow-ups resume the same session, so the protocol is still in context.
export function withProtocol(prompt, systemPrompt, resumeId) {
  return resumeId ? prompt : `${systemPrompt.trim()}\n\n---\n\n# Task\n\n${prompt}`;
}

export { clip, MAX_SNAPSHOT, rel };

// The crew and connector tools of wisp's MCP server (mcp-ask.js), by bare tool name; null for any other tool.
export function crewToolLabel(tool, input = {}) {
  const who = clip(String(input?.member || input?.name || ''), 40);
  if (tool === 'wisp_crew') return { kind: 'tool', label: 'Listing your crew' };
  if (tool === 'wisp_crew_add') return { kind: 'tool', label: `Adding ${who || 'a member'} to your crew` };
  if (tool === 'wisp_crew_edit') return { kind: 'tool', label: `Changing ${who || 'a crew member'}` };
  if (tool === 'wisp_crew_remove') return { kind: 'tool', label: `Removing ${who || 'a member'} from your crew` };
  if (tool === 'wisp_connectors') return { kind: 'tool', label: 'Listing your connectors' };
  if (tool === 'wisp_connector_add') return { kind: 'tool', label: `Adding ${who || 'a connector'} to your connectors` };
  if (tool === 'wisp_connector_signin') return { kind: 'ask', label: `Waiting for you to sign in to ${who || 'a connector'}` };
  return null;
}

export function flatten(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => c.text || '').join('\n');
  return '';
}

function readSnapshot(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    return st.size <= MAX_SNAPSHOT ? fs.readFileSync(abs, 'utf8') : '';
  } catch {
    return null;
  }
}

// For harnesses that only report "file X changed" after the fact. The "before" side comes from,
// in order: the content after the previous change we saw, else a snapshot taken when the
// harness announced the edit (only if it predates the write — the harness doesn't wait for us),
// else the file as it was when the turn started — `git stash create` captures tracked
// working-tree changes without touching anything — else nothing (treated as a new file).
export function fileTracker(cwd) {
  const known = new Map(); // rel path -> content after our last change() (null = missing)
  const announced = new Map(); // rel path -> content when the harness announced an edit
  let base;
  const git = (args, opts) => gitSync(cwd, args, opts);
  try {
    // Pinned before the agent starts writing.
    base = git(['stash', 'create']).toString().trim() || git(['rev-parse', '--verify', 'HEAD']).toString().trim();
  } catch {
    base = null;
  }
  const fromGit = (r) => {
    if (!base || path.isAbsolute(r)) return null;
    try {
      const out = git(['show', `${base}:./${r.split(path.sep).join('/')}`], { maxBuffer: 8 * MAX_SNAPSHOT }); // git wants / even on Windows
      return out.length <= MAX_SNAPSHOT ? out.toString('utf8') : '';
    } catch {
      return null;
    }
  };

  return {
    remember(file) {
      const r = rel(file, cwd);
      if (!known.has(r) && !announced.has(r)) announced.set(r, readSnapshot(path.resolve(cwd, file)));
    },
    // Call after the harness wrote `file`. Returns a `change` event payload, or null if unchanged.
    change(file) {
      const r = rel(file, cwd);
      const after = readSnapshot(path.resolve(cwd, file));
      let before;
      if (known.has(r)) before = known.get(r);
      // An empty snapshot may be the write caught half way (truncated, not written yet): ask git.
      else if (announced.has(r) && announced.get(r) !== after && announced.get(r) !== '') before = announced.get(r);
      else before = fromGit(r);
      known.set(r, after);
      announced.delete(r);
      if (before === after) return null;
      return { file: r, op: before === null ? 'create' : 'write', beforeFile: before, edits: [{ before: before ?? '', after: after ?? '' }] };
    },
  };
}
