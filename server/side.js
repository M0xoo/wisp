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
- Commits, pushes, resets, stashes, rebases, merges and the like rewrite the main task's work: they count as clashes. wisp's own Ship, rollback, fork, goals and terminal stay on the main task. You can't start tasks, delegate or edit the crew.
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
const SHARED_GIT = new Set(['reset', 'checkout', 'switch', 'restore', 'clean', 'stash', 'rebase', 'merge', 'commit', 'push', 'pull', 'cherry-pick', 'revert', 'am']);
const GIT_READS = { stash: new Set(['list', 'show']) };
const dryRun = (args) => args.some((a) => a === '--dry-run' || /^-[a-z]*n[a-z]*$/i.test(a));

// One command line into its simple commands, as word lists. Not a shell: quotes and the separators
// are all it needs to find the program and its arguments. `bash -c "…"` is read too.
function simpleCommands(text) {
  const out = [];
  let words = [];
  let word = '';
  let quote = '';
  let has = false;
  const end = () => {
    if (has) words.push(word);
    word = '';
    has = false;
  };
  const flush = () => {
    end();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && i + 1 < text.length) word += text[++i];
      else word += c;
    } else if (c === '"' || c === "'") [quote, has] = [c, true];
    else if (c === '\\' && i + 1 < text.length) [word, has] = [word + text[++i], true];
    else if (c === '`' || c === '(' || c === ')' || c === ';' || c === '|' || c === '&' || c === '\n') flush();
    else if (c === '$' && text[i + 1] === '(') (flush(), i++);
    else if (c === ' ' || c === '\t') end();
    else [word, has] = [word + c, true];
  }
  flush();
  return out.flatMap((w) => {
    // Wrappers and assignments before the program.
    let i = 0;
    while (i < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]) || ['sudo', 'command', 'time', 'env', 'nohup', 'exec'].includes(w[i]))) i++;
    const c = w.slice(i);
    if (/^(ba|z|da)?sh$/.test(c[0] || '') || c[0] === 'eval') {
      const at = c[0] === 'eval' ? 1 : c.indexOf('-c') + 1;
      return at > 0 && c[at] ? simpleCommands(c.slice(at).join(' ')) : [];
    }
    return c.length ? [c] : [];
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

// A command's verdict before it runs: none, or clash with why ('shared' or 'removes') and the files
// of main's it removes. files: main's changed files, relative to cwd. An argument the shell would
// expand can't be read here, so with main's work around it counts (fails towards a card).
export function commandClash(command, { files = [], cwd = '' } = {}) {
  const hit = new Set();
  let shared = false;
  for (const w of simpleCommands(String(command || ''))) {
    if (w[0] === 'git') {
      let i = 1;
      while (i < w.length && w[i].startsWith('-')) i += w[i] === '-C' || w[i] === '-c' ? 2 : 1;
      const sub = w[i];
      const rest = w.slice(i + 1);
      if (!SHARED_GIT.has(sub)) continue;
      if (GIT_READS[sub]?.has(rest[0])) continue;
      if (sub === 'clean' && dryRun(rest)) continue;
      shared = true;
    } else if (['rm', 'mv', 'unlink'].includes(w[0].split('/').pop())) {
      for (const a of w.slice(1)) {
        if (a.startsWith('-')) continue;
        const wild = /[*?[{$~]/.test(a);
        const p = cleanPath(a, cwd);
        for (const f of files) {
          const full = cleanPath(f, cwd);
          if (wild || full === p || full.startsWith(`${p}/`)) hit.add(f);
        }
      }
    }
  }
  if (shared) return { level: 'clash', why: 'shared', files: [...hit] };
  return hit.size ? { level: 'clash', why: 'removes', files: [...hit] } : { level: 'none' };
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
