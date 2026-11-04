// /side: a side discussion about a task, on a page of its own ("/side why did it pick sqlite?").
// Where /btw is one quick answer under the turn, a side discussion is a task of its own: you go
// back and forth with it, and its answers are full reports (blocks, apps, everything). It works in
// the main task's folder as it is now and gets the main task's latest state with every message.
// It runs commands and edits files, but every write goes through a gate first (server/side-gate.js,
// on the harness's live approval route): this file holds the gate's pure parts, the clash check. A
// harness with no way to ask before a write (adapter.sideGate unset) stays read-only and says so.
// What the main task owns stays refused (ship, commit from wisp, rollback, fork, goal, terminal:
// notSide), and wisp's tools that act (launch, delegate, crew edits…) aren't offered
// (server/mcp-ask.js, WISP_READONLY).

import { btwDigest } from './btw.js';
import { bad } from './util.js';

export const SIDE_CMD = /^\/side(?:\s+|$)/i;

// The opening message in "/side why …" ('' for a bare /side), or null when the text isn't a /side.
export function sideAsk(text) {
  const t = String(text || '').trim();
  return SIDE_CMD.test(t) ? t.replace(SIDE_CMD, '').trim() : null;
}

// A route that belongs to the main task, on a side discussion: its folder is the main task's.
export function notSide(s, what = 'change the work') {
  if (s?.sideOf) throw bad(`A side discussion can't ${what}: that stays with the main task. Do it on the main task.`, 409);
}

// Why an approval in a read-only side discussion is refused (the harness hears it as the answer).
export const SIDE_DENIED = 'This is a read-only side discussion: this harness can\'t ask wisp before a write, so nothing may be changed here. Do not retry; answer from what you can read, and say what the main task (or the user) would have to do.';

// The clash card's two answers (server/side-gate.js), and what the agent hears after Keep.
export const SIDE_APPLY = 'Apply and tell main task';
export const SIDE_KEEP = 'Keep main’s version';
export const sideKept = (words) => `The user kept the main task's version: nothing was changed.${words ? ` They said: ${words}` : ''} Do not retry this change. Say what the user could tell the main task instead (a follow-up they can send there).`;

// The system prompt's part for a side discussion: what it is, and what it may do. name: the
// harness's, when it can't ask before a write.
export function sideNote(side, sessionTool = 'mcp__wisp__wisp_session', { edits = true, name = 'This harness' } = {}) {
  const of = side.sideOf;
  const read = `\`git status\`, \`git diff\`, \`git log\` show what it changed. ${sessionTool ? `\`${sessionTool}\` with id ${of.id} reads its whole record.` : ''}`;
  const open = `

# wisp side discussion

This task is a side discussion about another wisp task, the main task “${of.title}” (wisp task ${of.id}). Another agent run does the main task's work; here you talk it over with the user: explain what it did and why, review it, weigh options, plan what to ask it next.
`;
  const latest = `- Every message from the user starts with the main task's latest state (under "The main task now"). It may have moved on since your last answer: go by the latest one.`;
  if (!edits) {
    return `${open}
- Change nothing. No edits, no file writes, no commits, no branches, no installs, no commands with side effects, no new tasks. You run read-only; anything that would change something is refused. ${name} can’t ask wisp before a write, so side discussions on it only read.
- Read freely: the files in the folder you're in are the main task's work as it is right now (${read})
${latest}
- Answer as for any wisp task, wisp presentation block included. Where a change is wanted, say what to tell the main task (a follow-up the user can send there) instead of making it.`;
  }
  return `${open}
- You share the main task's folder: the files here are its work as it is right now (${read}) What you change lands in that work, and the main task may be editing at the same time.
- Run what the user asks and edit what they ask, when they ask. Don't start changes of your own: this is a discussion, the main task does the work.
- wisp checks every write before it happens. A file the main task hasn't touched goes through. One it changed elsewhere goes through with a warning. Lines it changed are a clash: the user sees a card here, and if they accept, wisp tells the main task. If they keep the main task's version your call is refused: don't retry it, and say what to tell the main task instead.
- Commits, pushes, resets, stashes, rebases, merges and the like rewrite the main task's work: they count as clashes, and so does a command that removes or writes over a file it changed (\`rm\`, \`>\`, \`sed -i\`, \`patch\`, \`cp\`…). wisp's own Ship, rollback, fork, goals and terminal stay on the main task. You can't start tasks, delegate or edit the crew.
${latest}
- Answer as for any wisp task, wisp presentation block included.`;
}

// What goes before each of the user's messages: the main task as it stands now. main is null
// once it's gone.
export function sidePrompt(main, text, name) {
  const head = main ? `## The main task now: “${main.title}”\n\n${btwDigest(main, name) || '_Nothing has run on it yet._'}` : '## The main task now\n\n_The main task was deleted: only what was said here, and its folder as it is, are left._';
  return `${head}\n\n---\n\n## The user, in this side discussion\n\n${text}`;
}


// --- the clash check: pure, in the file's current line numbers (1-based, as git's new side) ---

const lf = (t) => String(t ?? '').replace(/\r\n/g, '\n');
const lineAt = (text, i) => text.slice(0, i).split('\n').length;

// Every place text sits in content, as [first line, last line]. A trailing newline ends the last
// line rather than starting another.
function places(content, text) {
  const c = lf(content);
  const t = lf(text);
  if (!t) return [];
  const out = [];
  const span = Math.max(t.replace(/\n$/, '').length - 1, 0);
  for (let i = c.indexOf(t); i >= 0; i = c.indexOf(t, i + t.length)) out.push([lineAt(c, i), lineAt(c, i + span)]);
  return out;
}

// The lines an Edit's old_string touches, every match (a harness refuses an ambiguous one, and
// replace_all takes them all). null when it isn't in the file.
export function editLines(content, old) {
  if (content === null || content === undefined || !old) return null;
  const at = places(content, old);
  return at.length ? at : null;
}

// git diff -U0 of one file: { from, to, gone } per hunk, in the file as it is now. A pure deletion
// has no lines left: it's the gap after line `to` (from = to + 1), which only an edit spanning both
// sides of it meets.
export function parseHunks(diff) {
  const out = [];
  let cur = null;
  for (const l of lf(diff).split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m) {
      const start = Number(m[1]);
      const n = m[2] === undefined ? 1 : Number(m[2]);
      out.push((cur = n ? { from: start, to: start + n - 1, gone: [] } : { from: start + 1, to: start, gone: [] }));
    } else if (cur && l[0] === '-') cur.gone.push(l.slice(1));
  }
  return out;
}

// Where the side's own block is in the file now: its closest match to where it was put (the same
// text elsewhere stays main's), or all of them for a replace_all.
function ownRanges(content, o) {
  const at = places(content, o.text);
  if (o.all || at.length < 2) return at;
  return [at.reduce((best, x) => (Math.abs(x[0] - o.at) < Math.abs(best[0] - o.at) ? x : best))];
}

// What's left of a line range after taking the side's ranges out.
function minus({ from, to }, mine) {
  let left = [{ from, to }];
  for (const [a, b] of mine) left = left.flatMap((r) => (b < r.from || a > r.to ? [r] : [...(r.from < a ? [{ from: r.from, to: a - 1 }] : []), ...(b < r.to ? [{ from: b + 1, to: r.to }] : [])]));
  return left;
}

// main's changed lines in one file, or null when it has none:
//   diff     git diff -U0 HEAD of the file ('' when clean); changed with no hunks (a binary, a mode
//            change) counts as every line
//   whole    a file git doesn't track, that main made: every line
//   content  the file now
//   running  main's running turn's edits of it ({ after }): what git may no longer show (it
//            committed). One that can't be placed, with no hunks to go by, makes it unknown.
//   own      the side's own blocks ({ text, gone?, at, all? }, addOwn): no longer main's
export function mainChanges({ diff = '', whole = false, content = null, running = [], own = [] }) {
  const lines = lf(content).replace(/\n$/, '').split('\n').length;
  const all = whole || (!!diff.trim() && !parseHunks(diff).length);
  const hunks = all ? [{ from: 1, to: lines, gone: [] }] : parseHunks(diff);
  if (!hunks.length && !running.length) return null;
  const mine = own.flatMap((o) => ownRanges(content, o));
  const gone = new Set(own.flatMap((o) => lf(o.gone).split('\n')));
  const out = [];
  for (const h of hunks) {
    if (h.from > h.to) {
      if (!h.gone.every((l) => gone.has(l))) out.push({ from: h.from, to: h.to }); // a deletion the side didn't make
    } else out.push(...minus(h, mine));
  }
  let placed = 0;
  for (const r of running) {
    const at = places(content, r.after);
    if (at.length) placed++;
    for (const [from, to] of at) out.push(...minus({ from, to }, mine));
  }
  const unknown = !hunks.length && placed < running.length;
  if (!out.length && !unknown) return null;
  out.sort((a, b) => a.from - b.from || a.to - b.to);
  return { lines: out.filter((r, i) => !i || r.from !== out[i - 1].from || r.to !== out[i - 1].to), ...(unknown && { unknown }) };
}

// The verdict on one write. tool: 'Edit' (old: what it replaces) or 'Write' (the whole file); main:
// from mainChanges. none: main hasn't touched the file. overlap: main changed it, not these lines.
// clash: these lines, a Write over its work, or anything the check can't place (it fails towards a
// card, never a silent overwrite).
export function clashCheck({ content, main, tool, old }) {
  if (!main) return { level: 'none' };
  if (tool === 'Write') return { level: 'clash', why: 'write', hits: main.lines };
  const lines = editLines(content, old);
  if (!lines || main.unknown) return { level: 'clash', why: 'unlocated', lines: lines || [], hits: main.lines };
  const hits = main.lines.filter((r) => lines.some(([a, b]) => a <= r.to && r.from <= b));
  return hits.length ? { level: 'clash', why: 'lines', lines, hits } : { level: 'overlap', lines };
}

// A write the side made, for mainChanges: an edit inside a block it already owns stays that block.
export function addOwn(list, { old, text, gone, at, all }) {
  const host = old ? list.find((o) => o.text.includes(old)) : null;
  if (host) return list.map((o) => (o === host ? { ...o, text: o.text.replace(old, text) } : o));
  return [...list, { text, ...(gone && { gone }), at, ...(all && { all }) }];
}

// Commands that rewrite the work the two share, whatever main changed. git stash list and the like
// only read, and so does a dry run.
const SHARED_GIT = new Set(['reset', 'checkout', 'switch', 'restore', 'clean', 'stash', 'rebase', 'merge', 'commit', 'push', 'pull', 'cherry-pick', 'revert', 'am', 'rm', 'mv', 'apply', 'update-ref']);
const dryRun = (args) => args.some((a) => a === '--dry-run' || /^-[a-z]*n[a-z]*$/i.test(a));
function gitRewrites(sub, rest) {
  if (sub === 'stash') return !['list', 'show'].includes(rest[0]);
  if (sub === 'clean' || sub === 'rm' || sub === 'mv') return !dryRun(rest);
  if (sub === 'apply') return rest.includes('--apply') || !rest.some((a) => ['--check', '--stat', '--numstat', '--summary'].includes(a));
  // Listing and creating are free; moving or deleting a branch (main's, perhaps) isn't.
  if (sub === 'branch') return rest.some((a) => /^-[a-zA-Z]*[dDmMCf]/.test(a) || ['--delete', '--move', '--force'].includes(a));
  if (sub === 'worktree') return rest[0] === 'remove' || rest[0] === 'move';
  return SHARED_GIT.has(sub);
}

// What goes before the program: assignments, wrappers and the shell's own keywords.
const LEADERS = new Set(['sudo', 'command', 'time', 'env', 'nohup', 'exec', '{', '!', 'if', 'then', 'elif', 'else', 'while', 'until', 'do']);
const REDIRECT = /&>>?|>>|>\||>&|>/y;
const HEREDOC = /^<<(-?)\s*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([^\s;|&<>()]+))/;

// One command line into its simple commands: { words, outs }, the word list and the files it
// redirects output to. Not a shell: quotes, separators, redirects and heredocs are all it needs to
// find the program, its arguments and its targets. `bash -c "…"` is read too. A $(…) or `…` in an
// argument stays in it as a `$`: what it prints can't be read here.
function simpleCommands(text) {
  const out = [];
  let words = [];
  let outs = [];
  let docs = []; // heredocs opened on this line
  let word = '';
  let quote = '';
  let has = false;
  let into = ''; // the next word is a redirect's: '>' a target, '<' an input
  let tick = false;
  const end = () => {
    if (has) {
      if (into === '>') outs.push(word);
      else if (!into) words.push(word);
      into = '';
    }
    word = '';
    has = false;
  };
  const flush = () => {
    end();
    into = '';
    if (words.length || outs.length) out.push({ words, outs });
    words = [];
    outs = [];
  };
  const substitution = () => {
    [word, has] = [`${word}$`, true];
    flush();
  };
  const dropFd = () => {
    if (/^\d+$/.test(word)) [word, has] = ['', false];
  };
  // A heredoc's body isn't commands, and can hold anything (an apostrophe would swallow what comes
  // next). With no closing line, the rest is read as commands: an arithmetic 1<<2 is no heredoc.
  const pastDocs = (nl) => {
    let at = nl;
    for (const d of docs) {
      for (let p = at + 1, e; p <= text.length; p = e + 1) {
        e = text.indexOf('\n', p);
        if (e < 0) e = text.length;
        if ((d.tabs ? text.slice(p, e).replace(/^\t+/, '') : text.slice(p, e)) === d.tag) {
          at = e;
          break;
        }
      }
    }
    docs = [];
    return at;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && i + 1 < text.length) word += text[++i];
      else word += c;
    } else if (c === '"' || c === "'") [quote, has] = [c, true];
    else if (c === '\\' && text[i + 1] === '\n') i++;
    else if (c === '\\' && i + 1 < text.length) [word, has] = [word + text[++i], true];
    else if (c === '#' && !has) {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl - 1;
    } else if (c === '\n') {
      flush();
      i = pastDocs(i);
    } else if (c === '>' || (c === '&' && text[i + 1] === '>')) {
      REDIRECT.lastIndex = i;
      const op = REDIRECT.exec(text)[0];
      if (c === '>') dropFd();
      end();
      i += op.length - 1;
      const dup = op === '>&' && /^(?:\d+|-)(?=[\s;|&)]|$)/.exec(text.slice(i + 1, i + 12));
      if (dup) i += dup[0].length; // 2>&1: no file
      else if (text[i + 1] !== '(') into = '>'; // tee >(cmd) writes to a command
    } else if (c === '<') {
      const doc = text[i + 1] === '<' && text[i + 2] !== '<' && HEREDOC.exec(text.slice(i));
      dropFd();
      end();
      if (doc) {
        docs.push({ tabs: !!doc[1], tag: doc[2] ?? doc[3] ?? doc[4] });
        i += doc[0].length - 1;
      } else if (text.startsWith('<<<', i)) [i, into] = [i + 2, '<'];
      else if (text[i + 1] === '>') [i, into] = [i + 1, '>'];
      else if (text[i + 1] === '&') [i, into] = [i + 1, '<'];
      else if (text[i + 1] !== '(') into = '<';
    } else if (c === '`') {
      if (tick) flush();
      else substitution();
      tick = !tick;
    } else if (c === '$' && text[i + 1] === '(') {
      substitution();
      i++;
    } else if (c === '(' || c === ')' || c === ';' || c === '|' || c === '&') flush();
    else if (c === ' ' || c === '\t') end();
    else [word, has] = [word + c, true];
  }
  flush();
  return out.flatMap(({ words: w, outs: to }) => {
    let i = 0;
    while (i < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]) || LEADERS.has(w[i]))) i++;
    const c = w.slice(i);
    const own = to.length ? [{ words: [], outs: to }] : []; // `sh run.sh > a.js` still writes a.js
    if (/^(ba|z|da)?sh$/.test(c[0] || '') || c[0] === 'eval') {
      const at = c[0] === 'eval' ? 1 : c.findIndex((x) => /^-[a-z]*c$/.test(x)) + 1;
      return [...(at > 0 && c[at] ? simpleCommands(c.slice(at).join(' ')) : []), ...own];
    }
    return c.length ? [{ words: c, outs: to }] : own;
  });
}

const cleanPath = (p, cwd) => {
  const abs = p.startsWith('/') ? p : `${cwd}/${p}`;
  const parts = [];
  for (const x of abs.split('/')) {
    if (x === '..') parts.pop();
    else if (x && x !== '.') parts.push(x);
  }
  return parts.join('/');
};

// An argument the shell would expand.
const expands = (a) => /[*?[{$~]/.test(a);
const plain = (args) => args.filter((a) => !a.startsWith('-'));

// The files of a `sed -i`, `perl -i` or `ruby -i` (nothing without it): what's left after the flags
// and the script, which can hold anything (`s/a*/b/` is no wildcard). scripted: the short flags that
// bring their own script, so the first plain argument is a file. inPlace: the flag that says it.
function inPlaceFiles(args, scripted, inPlace = /^-[^-MmI]*i/) {
  if (!args.some((a) => inPlace.test(a) || /^--in-place(=|$)/.test(a))) return [];
  const paths = [];
  let script = false;
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (/^--(expression|file)$/.test(a)) [script, j] = [true, j + 1];
    else if (/^--(expression|file)=/.test(a)) script = true;
    else if (a.startsWith('--')) continue;
    else if (scripted.test(a)) {
      script = true;
      if (scripted.exec(a)[0] === a) j++;
    } else if (a.startsWith('-')) {
      if (/i$/.test(a) && (args[j + 1] === '' || /^\.[^/]*$/.test(args[j + 1] || ''))) j++; // BSD: -i "" or -i .bak
    } else paths.push(a);
  }
  return script ? paths : paths.slice(1);
}

// The files of a gawk `-i inplace` (nothing without it): the flags, then the program unless -f, -e
// or -E brought it, then the files.
function awkFiles(args) {
  const paths = [];
  let inPlace = false;
  let script = false;
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (a === '--') {
      paths.push(...args.slice(j + 1));
      break;
    }
    const long = /^--(include|load|file|exec|source|assign|field-separator)(=.*)?$/.exec(a);
    const short = /^-([ifeEvFl])(.*)$/.exec(a);
    if (long || short) {
      const flag = long ? { include: 'i', file: 'f', exec: 'E', source: 'e' }[long[1]] : short[1];
      const value = (long ? long[2]?.slice(1) : short[2]) || args[++j];
      if (flag === 'i') inPlace ||= /^inplace(\.awk)?$/.test(value || '');
      if (['f', 'e', 'E'].includes(flag)) script = true;
    } else if (a === '-' || !a.startsWith('-')) paths.push(a);
  }
  if (!inPlace) return [];
  return script ? paths : paths.slice(1);
}

// What a `patch` writes: the -o file, the file it names, or (usually) the ones its diff names, which
// come from a file or stdin and can't be read here: '*', every file of main's. --dry-run writes nothing.
function patchTargets(args) {
  const paths = [];
  let out = null;
  let dir = '';
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (a === '--') {
      paths.push(...args.slice(j + 1));
      break;
    }
    if (a === '--dry-run' || a === '--check') return [];
    const long = /^--(input|output|directory|strip|reject-file|fuzz|ifdef|get|debug|prefix|basename-prefix|suffix|version-control|reject-format|quoting-style)(=.*)?$/.exec(a);
    if (long) {
      const value = long[2]?.slice(1) ?? args[++j];
      if (long[1] === 'output') out = value;
      if (long[1] === 'directory') dir = value;
    } else if (a === '-' || !a.startsWith('-')) paths.push(a);
    else if (!a.startsWith('--')) {
      for (let k = 1; k < a.length; k++) {
        if (a[k] === 'C') return []; // BSD's --check
        if (!'BDFVYdgioprxz'.includes(a[k])) continue; // these take a value, here or as the next argument
        const value = a.slice(k + 1) || args[++j];
        if (a[k] === 'o') out = value;
        if (a[k] === 'd') dir = value;
        break;
      }
    }
  }
  const at = (f) => (dir && !f.startsWith('/') ? `${dir}/${f}` : f);
  if (out !== null) return out === '-' ? [] : [at(out)];
  return paths.length && paths[0] !== '-' ? [at(paths[0])] : ['*'];
}

// Where a cp, install or rsync lands, and what it brings.
function copyOf(prog, args) {
  const paths = [];
  let dest = null;
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (prog !== 'rsync' && (/^-[a-zA-Z]*t$/.test(a) || a === '--target-directory')) dest = args[++j];
    else if (prog !== 'rsync' && a.startsWith('--target-directory=')) dest = a.slice(19);
    else if (!a.startsWith('-')) paths.push(a);
  }
  return dest === null ? { dest: paths.at(-1), sources: paths.slice(0, -1) } : { dest, sources: paths };
}

function truncated(args) {
  const paths = [];
  for (let j = 0; j < args.length; j++) {
    if (['-s', '--size', '-r', '--reference'].includes(args[j])) j++;
    else if (!args[j].startsWith('-')) paths.push(args[j]);
  }
  return paths;
}

// A command's verdict before it runs: none, or clash with why ('shared', 'removes' or 'writes') and
// the files of main's it hits. files: main's changed files, relative to cwd. An argument the shell
// would expand can't be read here, so with main's work around it counts (fails towards a card).
// A file main hasn't touched is free, however the command writes it.
export function commandClash(command, { files = [], cwd = '' } = {}) {
  const removed = new Set();
  const written = new Set();
  let shared = false;
  let here = cwd; // a `cd` in the chain moves what relative paths mean
  let lost = false; // cd "$D": they could mean anything now
  // tree: a folder, and everything of main's in it.
  const reach = (a, into, tree = false) => {
    if (!a) return;
    const wild = expands(a) || (lost && !a.startsWith('/'));
    const p = cleanPath(a, here);
    for (const f of files) {
      const full = cleanPath(f, cwd);
      if (wild || full === p || (tree && full.startsWith(`${p}/`))) into.add(f);
    }
  };
  for (const { words: w, outs } of simpleCommands(String(command || ''))) {
    for (const t of outs) reach(t, written);
    if (!w.length) continue;
    const prog = w[0].split('/').pop();
    const args = w.slice(1);
    if (prog === 'cd') {
      const to = plain(args)[0];
      if (!to || expands(to)) lost = true;
      else {
        here = cleanPath(to, here);
        if (to.startsWith('/')) lost = false;
      }
    } else if (prog === 'git') {
      let i = 0;
      while (i < args.length && args[i].startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1;
      const sub = args[i];
      const rest = args.slice(i + 1);
      if (!gitRewrites(sub, rest)) continue;
      shared = true;
      if (sub === 'rm' || sub === 'mv') for (const a of plain(rest)) reach(a, removed, true);
    } else if (['rm', 'mv', 'unlink'].includes(prog)) {
      for (const a of plain(args)) reach(a, removed, true);
    } else if (prog === 'sed' || prog === 'gsed' || prog === 'perl') {
      for (const a of inPlaceFiles(args, prog === 'perl' ? /^-[^i]*[eE]/ : /^-[^i]*[ef]/)) reach(a, written);
    } else if (prog === 'ruby') {
      for (const a of inPlaceFiles(args, /^-[^i]*e/, /^-[^-rIEe]*i/)) reach(a, written);
    } else if (prog === 'awk' || prog === 'gawk') {
      for (const a of awkFiles(args)) reach(a, written);
    } else if (prog === 'patch') {
      for (const a of patchTargets(args)) reach(a, written);
    } else if (prog === 'tee') {
      for (const a of plain(args)) reach(a, written);
    } else if (prog === 'truncate') {
      for (const a of truncated(args)) reach(a, written);
    } else if (prog === 'dd') {
      for (const a of args) if (a.startsWith('of=')) reach(a.slice(3), written);
    } else if (prog === 'cp' || prog === 'install' || prog === 'rsync') {
      const { dest, sources } = copyOf(prog, args);
      if (!dest) continue;
      reach(dest, written);
      for (const s of sources) {
        // Into a folder: only what lands on main's file counts, `cp y src/` doesn't.
        const name = s.endsWith('/') ? '*' : s.split('/').pop();
        if (expands(name)) reach(dest, written, true);
        else reach(`${dest}/${name}`, written, true);
      }
    }
  }
  const hit = [...new Set([...removed, ...written])];
  if (shared) return { level: 'clash', why: 'shared', files: hit };
  if (removed.size) return { level: 'clash', why: 'removes', files: hit };
  return written.size ? { level: 'clash', why: 'writes', files: hit } : { level: 'none' };
}

const clipText = (t, n) => (String(t).length > n ? `${String(t).slice(0, n)}…` : String(t));

// The message the main task gets. what: { file, lines?, before?, after?, command? }; asked: the
// user's message in the side.
export function sideTell(side, what, asked) {
  const where = `${what.file ? `\`${what.file}\`` : 'the work'}${what.lines?.length ? ` (line${what.lines.length > 1 || what.lines[0][0] !== what.lines[0][1] ? 's' : ''} ${what.lines.map(([a, b]) => (a === b ? a : `${a}–${b}`)).join(', ')})` : ''}`;
  const change = what.command ? `Command:\n\n\`\`\`\n${clipText(what.command, 500)}\n\`\`\`` : what.after !== undefined ? `What changed:\n\n\`\`\`diff\n${what.before ? `${clipText(what.before, 1200).split('\n').map((l) => `- ${l}`).join('\n')}\n` : ''}${clipText(what.after, 1200).split('\n').map((l) => `+ ${l}`).join('\n')}\n\`\`\`` : '';
  return `From the side discussion “${side.title}” (wisp task ${side.id}): ${what.by === 'command' ? `a command there changed ${where}, which you changed too.` : `the user accepted a change to ${where} over yours.`}

${change}

Why: they asked there: “${clipText(asked || '', 300)}”

Read the file as it is now before you touch it again, and keep this change unless the user says otherwise.`;
}
