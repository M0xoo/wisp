// The gate on a side discussion's writes (server/side.js): every Edit, Write and command of its run
// comes through here before it happens, on the harness's live approval route (requestApproval).
// A file the main task hasn't touched goes through, one it changed elsewhere goes with a warning
// row, and a clash waits on a card in the side, never in the main task, so a main task in Full auto
// isn't interrupted. Apply rechecks first: the main task may have moved while the card sat there.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { git, gitSync } from './git.js';
import { MAX_SNAPSHOT } from './paths.js';
import { SIDE_APPLY, SIDE_KEEP, addOwn, clashCheck, commandClash, mainChanges, sideKept, sideTell } from './side.js';

const MAX_SHOWN = 4000; // of a proposed change or main's lines, on the card
const MAX_LINES = 40;
const MAX_HASHED = 500; // dirty files a command's before and after compare
const WRITES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const clip = (t) => (String(t).length > MAX_SHOWN ? `${String(t).slice(0, MAX_SHOWN)}…` : String(t));
const sha = (t) => crypto.createHash('sha1').update(t).digest('hex').slice(0, 16);
const tryGit = (cwd, args) => {
  try {
    return gitSync(cwd, args, { maxBuffer: 8 * MAX_SNAPSHOT }).toString('utf8');
  } catch {
    return '';
  }
};

// A path as the folder sees it: /tmp and /private/tmp are one on macOS, and harnesses hand us the
// real one. The file may not exist yet.
function inFolder(file, cwd) {
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const abs = path.resolve(cwd, String(file || ''));
  const out = path.relative(real(cwd), path.join(real(path.dirname(abs)), path.basename(abs)));
  return { abs, rel: out.split(path.sep).join('/'), outside: !out || out.startsWith('..') || path.isAbsolute(out) };
}

function readText(abs) {
  try {
    const st = fs.statSync(abs);
    return st.isFile() && st.size <= MAX_SNAPSHOT ? fs.readFileSync(abs, 'utf8') : null;
  } catch {
    return null;
  }
}

// What a tool call writes: { file, tool, old, text, all }, one per edit of a MultiEdit.
function writesOf(tool, input) {
  const file = input.file_path || input.notebook_path || input.path;
  if (tool === 'Edit') return [{ file, tool: 'Edit', old: input.old_string ?? '', text: input.new_string ?? '', all: !!input.replace_all }];
  if (tool === 'MultiEdit') return (input.edits || []).map((e) => ({ file, tool: 'Edit', old: e.old_string ?? '', text: e.new_string ?? '', all: !!e.replace_all }));
  return [{ file, tool: 'Write', text: String(input.content ?? input.new_source ?? '') }];
}

// Every file that differs from HEAD, git's or not, relative to cwd.
const CHANGED = ['diff', 'HEAD', '--name-only', '--relative', '--no-renames', '-z'];
const FRESH = ['ls-files', '--others', '--exclude-standard', '-z'];
const fileList = (changed, fresh) => [...new Set(`${changed}\0${fresh}`.split('\0').filter(Boolean))].sort();
async function dirtyFiles(cwd) {
  const list = (args) => git(cwd, args).catch(() => '');
  return fileList(...(await Promise.all([list(CHANGED), list(FRESH)])));
}
const dirtyNow = (cwd) => fileList(tryGit(cwd, CHANGED), tryGit(cwd, FRESH));

const WORST = { none: 0, overlap: 1, clash: 2 };

// The runner's side of it: its store, workdir, and how a turn gets a change, a warning row, a card, an
// answer and a repaint; tell sends the main task a message.
export function createSideGate({ store, workdir, change, warn, ask, tell, answered, touch }) {
  const notices = new Map(); // tool call id → what to tell main once its write has happened
  const windows = new Map(); // tool call id → a command's before, to compare after it ran

  const mainOf = (side) => store.get(side.sideOf.id) || null;
  const runningEdits = (main, rel) => {
    const t = main?.turns.at(-1);
    if (t?.status !== 'running') return [];
    return (t.changes || []).filter((c) => c.file === rel && !c.reverted).flatMap((c) => (c.edits || []).map((e) => ({ after: e.after ?? '' })));
  };

  // main's lines in one file, in the folder as it is now (a few ms of git per write).
  function look(side, rel, content) {
    const cwd = workdir(side);
    const diff = tryGit(cwd, ['diff', 'HEAD', '-U0', '--no-color', '--no-ext-diff', '--', rel]);
    const whole = !diff && !!tryGit(cwd, ['ls-files', '--others', '--exclude-standard', '--', rel]).trim();
    return mainChanges({ diff, whole, content, running: runningEdits(mainOf(side), rel), own: side.sideOwn?.[rel] || [] });
  }

  // The verdict on a tool call's writes, worst first. A MultiEdit's later edits may not be in the
  // file yet, so it's taken as a whole against the file as it is.
  function check(side, tool, input) {
    const cwd = workdir(side);
    let worst = { level: 'none' };
    let at = null;
    for (const w of writesOf(tool, input)) {
      const { abs, rel, outside } = inFolder(w.file, cwd);
      at = { rel, abs };
      if (outside) continue; // not the shared work
      const content = readText(abs);
      const main = look(side, rel, content);
      const v = { ...clashCheck({ content, main, tool: w.tool, old: w.old }), file: rel, w, content };
      if (WORST[v.level] > WORST[worst.level]) worst = v;
    }
    return { ...worst, file: worst.file || at?.rel || '' };
  }

  // What the card shows. sig: the clash as it stands, so a stale card can tell it moved on (and a
  // change elsewhere in the file, that only shifts line numbers, doesn't).
  function cardOf(side, v, extra = {}) {
    const main = mainOf(side);
    const text = (v.content === null || v.content === undefined ? '' : String(v.content)).replace(/\r\n/g, '\n').split('\n');
    const shown = (v.hits || []).slice(0, 12).map((r) => ({ from: r.from, to: r.to, text: clip(text.slice(r.from - 1, Math.max(r.to, r.from - 1)).slice(0, MAX_LINES).join('\n')) }));
    const card = {
      kind: v.why === 'write' ? 'write' : v.why === 'lines' ? 'lines' : 'unlocated',
      file: v.file,
      mainTitle: main?.title || side.sideOf.title,
      lines: v.lines || [],
      proposed: { before: clip(v.w.old ?? ''), after: clip(v.w.text) },
      main: shown,
      ...extra,
    };
    return { ...card, sig: sha(JSON.stringify([v.level, card.kind, card.main.map((m) => m.text), card.proposed])) };
  }

  const commandCard = (side, command, v, files) => ({ kind: 'command', command: clip(command), files: v.files || [], why: v.why, mainTitle: mainOf(side)?.title || side.sideOf.title, main: [], lines: [], sig: sha(JSON.stringify([command, v.files || [], files])) });

  const askCard = (side, card) => ask(side, { question: card.kind === 'command' ? 'This command rewrites work the main task shares' : `This clashes with the main task in ${card.file}`, options: [SIDE_APPLY, SIDE_KEEP], clash: card });

  // Everything main changed, by file, for commands: what git says plus its running turn.
  function mainFilesOf(side, dirty) {
    const t = mainOf(side)?.turns.at(-1);
    const live = t?.status === 'running' ? (t.changes || []).map((c) => c.file) : [];
    const own = Object.keys(side.sideOwn || {});
    return [...new Set([...dirty.filter((f) => !own.includes(f)), ...live])].sort();
  }

  // A hash per dirty file: what a command changed is what differs after it.
  async function snapshot(cwd) {
    const hashes = new Map();
    for (const f of (await dirtyFiles(cwd)).slice(0, MAX_HASHED)) {
      try {
        hashes.set(f, crypto.createHash('sha1').update(fs.readFileSync(path.join(cwd, f))).digest('hex'));
      } catch {
        hashes.set(f, 'gone');
      }
    }
    return hashes;
  }

  // A command finished: a file it changed that main changed too gets the warning row and the message.
  async function closeWindow(side, turn, id) {
    const w = windows.get(id);
    if (!w) return;
    windows.delete(id);
    const now = await snapshot(workdir(side));
    const main = mainOf(side);
    const during = (main?.turns.at(-1)?.changes || []).map((c) => `${c.file}:${c.edits?.length || 0}`);
    const moved = new Set(during.filter((x) => !w.during.includes(x)).map((x) => x.replace(/:\d+$/, '')));
    const changed = [...new Set([...now.keys(), ...w.before.keys()])].filter((f) => now.get(f) !== w.before.get(f));
    for (const file of changed) {
      if (!w.files.includes(file) || moved.has(file)) continue; // main's own edit in the meantime isn't the command's
      warn(side, turn, { kind: 'command', file, main: main?.title || side.sideOf.title });
      tell(side, sideTell(side, { by: 'command', file, command: w.command, after: tailOf(path.join(workdir(side), file)) }, turn.prompt));
    }
  }
  const tailOf = (abs) => {
    const t = readText(abs);
    return t === null ? undefined : t.trimEnd().split('\n').slice(-6).join('\n');
  };

  // What a write adds to the side: it owns those lines now, and they're in its turn's files.
  function record(side, turn, tool, input) {
    const cwd = workdir(side);
    for (const w of writesOf(tool, input)) {
      const { abs, rel, outside } = inFolder(w.file, cwd);
      if (outside) continue;
      const content = readText(abs);
      if (w.tool === 'Write') {
        change(side, turn, { file: rel, op: content === null ? 'create' : 'write', edits: [{ before: content ?? '', after: w.text.slice(0, MAX_SNAPSHOT) }] });
        (side.sideOwn ||= {})[rel] = [{ text: w.text, at: 1 }]; // the whole file is the side's now
      } else {
        change(side, turn, { file: rel, op: 'edit', edits: [{ before: w.old, after: w.text }] });
        const at = content?.replace(/\r\n/g, '\n').indexOf(w.old.replace(/\r\n/g, '\n')) ?? -1;
        (side.sideOwn ||= {})[rel] = addOwn(side.sideOwn[rel] || [], { old: w.old, text: w.text, gone: w.old, at: at >= 0 ? content.slice(0, at).split('\n').length : 1, all: w.all });
      }
    }
  }

  // Tell main once the write is done, or at once when the harness doesn't say (see toolDone).
  const noteTell = (side, useId, text) => {
    if (useId) notices.set(useId, { side: side.id, text });
    else tell(side, text);
  };

  return {
    // A tool call the harness asks about: { decision } at once, or { id } for a card.
    async decide(side, { tool, input = {}, tool_use_id: useId }) {
      const turn = side.turns.at(-1);
      if (tool === 'Bash') {
        const command = String(input.command || '');
        const cwd = workdir(side);
        const files = mainFilesOf(side, await dirtyFiles(cwd));
        const v = commandClash(command, { files, cwd });
        const open = async () => {
          if (useId) windows.set(useId, { before: await snapshot(cwd), files, command, during: (mainOf(side)?.turns.at(-1)?.changes || []).map((c) => `${c.file}:${c.edits?.length || 0}`) });
        };
        if (v.level === 'none') {
          await open();
          return { decision: 'allow' };
        }
        return { id: askCard(side, commandCard(side, command, v, files)), pending: { tool, input, useId } };
      }
      if (!WRITES.has(tool)) return { decision: 'allow' }; // it reads, fetches or asks: nothing of the work's
      const v = check(side, tool, input);
      if (v.level === 'clash') return { id: askCard(side, cardOf(side, v)), pending: { tool, input, useId } };
      if (v.level === 'overlap') warn(side, turn, { kind: 'overlap', file: v.file, main: mainOf(side)?.title || side.sideOf.title });
      record(side, turn, tool, input);
      return { decision: 'allow' };
    },

    // The card's answer. apply rechecks, and a card that no longer holds is redrawn instead of
    // written: { stale: true }. words: typed instead of a button, which keeps main's version.
    settle(side, pending, { action, sig, words }) {
      const ask = side.ask;
      const turn = side.turns.at(-1);
      if (action !== 'apply') {
        answered(side, { decision: 'deny', message: sideKept(words), label: `You kept the main task’s version: ${ask.clash.file || ask.clash.command}${words ? ` (“${words}”)` : ''}` });
        return { kept: true };
      }
      const bash = pending.tool === 'Bash';
      let fresh;
      if (bash) {
        const files = mainFilesOf(side, dirtyNow(workdir(side)));
        fresh = commandCard(side, pending.input.command, commandClash(pending.input.command, { files, cwd: workdir(side) }), files);
      } else {
        const v = check(side, pending.tool, pending.input);
        fresh = v.level === 'clash' ? cardOf(side, v) : { ...ask.clash, kind: 'cleared', main: [], sig: sha(`cleared:${v.level}:${v.file}`) };
      }
      if (fresh.sig !== (sig || ask.clash.sig)) {
        ask.clash = { ...fresh, moved: true };
        ask.question = fresh.kind === 'cleared' ? `The main task moved: ${fresh.file} no longer clashes` : 'The main task moved: this still clashes';
        touch(side, turn);
        return { stale: true };
      }
      if (!bash) record(side, turn, pending.tool, pending.input);
      const what = bash ? { command: pending.input.command, file: fresh.files?.[0] } : { file: fresh.file, lines: fresh.lines, before: fresh.proposed.before, after: fresh.proposed.after };
      noteTell(side, pending.useId, sideTell(side, what, turn?.prompt));
      answered(side, { decision: 'allow', label: `You applied it and told the main task: ${fresh.file || fresh.command}` });
      return { applied: true };
    },

    // The harness says a tool call ended: its write happened (or failed), so main can hear it now.
    toolDone(side, turn, id, failed) {
      const n = notices.get(id);
      if (n) {
        notices.delete(id);
        if (!failed) tell(side, n.text);
      }
      return closeWindow(side, turn, id);
    },

    // The run ended: anything still open is settled from what's on disk.
    turnEnded(side, turn) {
      for (const [id, n] of notices) {
        if (n.side !== side.id) continue;
        notices.delete(id);
        tell(side, n.text);
      }
      for (const id of windows.keys()) closeWindow(side, turn, id).catch(() => {});
    },
  };
}
