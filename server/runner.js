// Session orchestration: launches turns on adapters, folds their events into the
// session record, and handles follow-ups that arrive while the agent is busy: by default
// they interrupt the run and resume the session with the new message; with the `queue`
// setting they wait until the run finishes.

import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionToken } from './agent-token.js';
import { cappedRefusal } from './capped.js';
import { adapters, detectedVersion } from './adapters/index.js';
import { versionIn } from './adapters/common.js';
import { systemPrompt, parsePresentation, heroOf } from './protocol.js';
import { spellGuide } from './spell-guide.js';
import { paneGuide } from './pane-guide.js';
import { captureCheckpoint, freshCheckpoint, readGitFile } from './checkpoint.js';
import { teamNote, copies, SUBAGENT_ASK, AWAY_SUBAGENT, delegationReport, stillWorkingNote, REPORTS_BACK } from './subagents.js';
import { handoffNote, mapEffort } from './handoff.js';
import { openTerms } from './pty.js';
import { agentPrompt, plainMentions } from './mentions.js';
import { messageOf } from './channels/policy.js';
import { BTW_SYSTEM, BTW_TIMEOUT_MS, MAX_BTW, btwAnswer, btwPrompt } from './btw.js';
import { SIDE_APPLY, SIDE_APPLY_OTHER, SIDE_DENIED, SIDE_KEEP, SIDE_KEEP_OTHER, sideNote, sidePrompt } from './side.js';
import { createSideGate } from './side-gate.js';
import { bad, clip, MODES, newId } from './util.js';
import { LIMIT_CARRY_ON, laterNote, laterView } from './later.js';
import { HOMES as ACCOUNT_HOMES } from './accounts.js';
import { infraError } from './router.js';
import { KEYS as KEY_LOGINS, signedOutBy } from './agent-login.js';
import { refusalOf } from './refusal.js';
import { haltOf } from '../web/js/core/format.js';
import { vendorOf } from '../web/js/vendors.js';
import { goalNote, goalView } from './goal.js';
import { compactOffer, compactUntil } from '../web/js/cold-cache.js';
import { kitNote } from './crew.js';
import { planOf, toolSet, unitsOf } from './budget.js';
import { watchView } from './watch.js';
import { asks as projectAsks } from './project-trust.js';
import { leanTask } from './lean.js';
import { reviewView } from './services/review.js';

const MAX_ACTIVITY = 400;
const MAX_TEXT = 20_000; // an agent message, kept whole for the transcript up to this
const MAX_OUTPUT = 2_000; // what a tool call returned: its start and end past this
// The calls whose output the transcript shows. A read returns the file and an edit a confirmation.
const OUTPUT_KINDS = new Set(['run', 'search', 'web', 'tool', 'agent']);
// What a running turn's CLI said about itself, until the turn ends and it goes in stats.cli.
const cliSeen = new WeakMap();
const LINGER_MS = 3000; // how long a CLI may keep running after it reported its result
const BACKGROUND_MAX_MS = 60 * 60_000; // how long a turn may wait on its background tasks
const ASK_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-ask.js');
// The delegate tool lives on the same injected server, so harnesses name it like ask_user.
const delegateTool = (askTool) => askTool && askTool.replace(/ask_user$/, 'delegate');
// The answers a live approval offers. Typed text instead is a "no, do this instead".
export const APPROVAL = { allow: 'Allow', always: 'Always allow in this task', deny: 'Deny' };
const sameAction = (a, b) => a.tool === b.tool && a.detail === b.detail;

// A live approval's answer: the button the user clicked, a yes/no typed out, or anything else,
// which denies the call and hands the agent the user's words.
export function approvalDecision(text) {
  const t = String(text || '').trim();
  if (t === APPROVAL.always || /^(always\b|2$)/i.test(t)) return { decision: 'allow', always: true };
  if (t === APPROVAL.allow || /^(y|yes|ok|allow|approve|go ahead|1)$/i.test(t)) return { decision: 'allow' };
  if (t === APPROVAL.deny || /^(n|no|deny|reject|3)$/i.test(t)) return { decision: 'deny' };
  return { decision: 'deny', message: t };
}

// The follow-up that retries what a turn's permissions refused, once the user allowed it.
// What the harness's counters held after this conversation's last turn. A turn from before
// stats.totals kept the counters themselves in costUsd and models, or Codex's in its tokens. Codex
// totals name their thread: another account's turns ran on a thread of their own.
function priorTotals(session) {
  const here = (st) => !st.totals?.thread || st.totals.thread === session.agentSessionId;
  const st = session.turns.findLast((t) => t.stats && (t.agent || session.agent) === session.agent && here(t.stats))?.stats;
  return st ? st.totals || { costUsd: st.costUsd, models: st.models, inputTokens: st.inputTokens, cachedInputTokens: st.cachedInputTokens, outputTokens: st.outputTokens } : null;
}

function retryPrompt(items, scoped) {
  const list = items.map((b) => `- ${b.tool}${b.detail ? `: \`${b.detail}\`` : ''}`).join('\n');
  const how = scoped ? 'I allowed exactly these for this follow-up' : 'This follow-up runs in Full auto, so nothing is blocked';
  return `These actions were blocked by your permissions last turn:\n${list}\n\n${how}. Run them now and finish the task.`;
}

export { newId };

// A tool call's output for the transcript: whole when short, else its first and last lines (the
// end of a test run or a build is what tells how it went).
export function clipOutput(text) {
  const out = String(text ?? '').replace(/\s+$/, '');
  if (out.length <= MAX_OUTPUT) return out;
  let head = out.slice(0, 600);
  let tail = out.slice(-1300);
  if (head.includes('\n')) head = head.slice(0, head.lastIndexOf('\n'));
  if (tail.includes('\n')) tail = tail.slice(tail.indexOf('\n') + 1);
  const cut = out.slice(head.length, out.length - tail.length);
  const lines = cut.split('\n').length - 1;
  return `${head}\n… ${lines > 1 ? `${lines} lines` : `${cut.length} characters`} cut …\n${tail}`;
}

// A harness's event as a transcript step. A goal's check records its run with these too
// (server/goal-runs.js), so it reads like a task's.
export function stepOf(ev) {
  const item = { t: Date.now(), kind: ev.type === 'tool' ? ev.kind : ev.type === 'text' ? 'text' : 'error' };
  if (ev.type === 'tool') {
    Object.assign(item, { label: ev.label, file: ev.file, detail: ev.detail });
    if (ev.id) item.call = String(ev.id); // a tool_output later finds its call by this
    if (ev.output && OUTPUT_KINDS.has(item.kind)) item.output = clipOutput(ev.output);
  } else if (ev.type === 'text') item.label = ev.text.slice(0, MAX_TEXT);
  else item.label = `${ev.name || 'Tool'} failed: ${ev.text}`;
  return item;
}

// What a call returned, on its step: matched to the call by the harness's id. The step, or null.
// outAt: when it came in, nothing printed included (a quiet `until …; do sleep` is still activity):
// a reload reads it (web/js/no-output.js).
export function stepOutput(activity, ev) {
  const item = ev.id && activity.findLast((a) => a.call === String(ev.id));
  if (!item || !OUTPUT_KINDS.has(item.kind)) return null;
  item.outAt = Date.now();
  const output = clipOutput(ev.text);
  if (output.trim()) item.output = output;
  return item;
}

// Where the agent actually works: its own worktree when it has one, else the project folder.
// A side discussion (/side, server/side.js) reads its main task's folder.
export const workdir = (s) => s.sideOf?.cwd || s.worktree?.cwd || s.cwd;

// Where the agent works in the task's other folders (also): their worktrees, else the folders.
export const alsoDirs = (s) => (s.also || []).map((a) => a.worktree?.cwd || a.cwd);

// Settings → General → wisp blocks off: the agent answers in plain markdown. Not for crew jobs or
// spells (their blocks carry what wisp acts on), nor for subagents (they report to their lead).
export const plainAnswer = (s, store) => store?.config?.defaults?.blocks === 'off' && !s.crew && s.kind !== 'spell' && s.kind !== 'pane' && !s.parentId && !s.delegated;

// Worktree sessions get told where they are, so they don't go looking for the main checkout. A task
// with other folders (also) gets their paths: that's where the work in them goes.
function workspaceNote(s) {
  const wt = s.worktree;
  const also = s.also || [];
  const out = [];
  if (wt?.foreign) out.push(`You are in an existing git worktree (${wt.path}) on branch \`${wt.branch}\`, brought in from Conductor. It may hold uncommitted work from earlier sessions: keep it, and build on it. Don't remove this worktree or its folder, and don't stash, reset or clean it. Other agents may be working in the user's main checkout, so make every change here. Leave your changes uncommitted unless the user asks you to commit; the user ships them from wisp (commit, push, pull request).`);
  else if (wt) out.push(`You are in an isolated git worktree (${wt.path}) on branch \`${wt.branch}\`, created from \`${wt.baseRef}\` for this task only. Other agents may be working in the user's main checkout, so make every change here. Dependencies and build output (node_modules, virtualenvs, dist/) are not shared with the main checkout: install them if a command needs them. Leave your changes uncommitted unless the user asks you to commit; the user ships them from wisp (commit, push, pull request).`);
  if (also.length) {
    const line = (a) => (a.worktree ? `- \`${a.worktree.cwd}\`: a worktree of \`${a.cwd}\` on branch \`${a.worktree.branch}\` (from \`${a.worktree.baseRef}\`). Work here, not in \`${a.cwd}\`.` : `- \`${a.cwd}\``);
    out.push(`This task spans ${also.length + 1} folders. Besides your working directory (${workdir(s)}), you work in:\n${also.map(line).join('\n')}\n\nRead and change files in all of them as the task needs, using absolute paths outside your working directory. Run each folder's commands (tests, builds) from inside that folder.${also.some((a) => a.worktree) ? ' Leave the changes there uncommitted too; Ship it opens a pull request per repo.' : ''}`);
  }
  return out.length ? `\n\n## Workspace\n\n${out.join('\n\n')}` : '';
}

// A follow-up's { agent, model, effort }, or null when it's what the session already runs on.
// Fields left out keep the session's; a new harness without a model gets its default.
// No effort with a switch to another harness (Hand to <harness> on the refusal and limit cards): the
// task keeps its thinking level, as that harness (and model) names it, not its default (handoff.js).
// How long Sign in on a turn's card waits for its login: a login gives up after 15 minutes.
const SIGN_IN_MS = 16 * 60_000;
const signInAccount = (acc) => (acc && acc !== 'default' ? acc : '');
// Before this version, signing in can stop other running jobs on the same login.
const CLAUDE_SAFE_SIGN_IN = '2.1.318';
const before = (v, min) => !!v && v.localeCompare(min, 'en', { numeric: true }) < 0;

function changedRun(session, run) {
  if (!run || typeof run !== 'object') return null;
  const agent = run.agent || session.agent;
  const same = agent === session.agent;
  const model = String(run.model ?? (same ? session.model : '') ?? '');
  const levels = (model && adapters[agent]?.models?.find((m) => m.id === model)?.efforts) || adapters[agent]?.efforts || [];
  const next = { agent, model, effort: String(run.effort ?? (same ? session.effort : mapEffort(session.effort, levels)) ?? ''), ...(run.account !== undefined && { account: String(run.account || '') }) };
  return same && next.model === (session.model || '') && next.effort === (session.effort || '') && (next.account === undefined || next.account === (session.account || '')) ? null : next;
}

// The lead's roster changes between turns. Members it already used keep their child session (by
// name), so delegating to them again continues their conversation.
function setTeam(session, team) {
  if (team.length) session.subagents = team;
  else delete session.subagents;
  session.children ||= {};
}

// On a wisp Grid, why the runs that were going when wisp last died stopped: its box ran out of
// memory (hostd sets WISP_OUT_OF_MEMORY to the box's limit, grid/hostd.js) or wisp restarted.
// The grid's account page has the waitlist for bigger cloud computers (#machines/bigger).
export function restartReason(env = process.env) {
  // short: a paused goal's why; asked: a side question that never got its answer.
  if (!env.WISP_OUT_OF_MEMORY) return { summary: 'wisp was restarted while this was running.', short: 'wisp was restarted', asked: 'wisp was restarted before this was answered.' };
  const m = /^(\d+(?:\.\d+)?)([kmg])b?$/i.exec(env.WISP_OUT_OF_MEMORY);
  const gb = m && Number(m[1]) / { k: 1048576, m: 1024, g: 1 }[m[2].toLowerCase()];
  const limit = gb ? ` (${Math.round(gb * 10) / 10} GB)` : '';
  const grid = String(env.WISP_GRID_URL || '').replace(/\/+$/, '');
  return {
    title: 'Out of memory',
    summary: `This cloud computer ran out of memory${limit} while this was running, so it restarted. Follow up to pick it back up.`,
    short: 'the cloud computer ran out of memory',
    asked: 'The cloud computer ran out of memory before this was answered.',
    blocks: [
      {
        type: 'callout',
        tone: 'info',
        title: 'Need more room?',
        text: `Running fewer things at once (a dev server, a browser, a database) helps it fit.${grid ? ` Bigger cloud computers are on the way: [join the waitlist](${grid}/#machines/bigger) and you’ll be among the first to get one.` : ''}`,
      },
    ],
  };
}

function autoTitle(prompt) {
  const line = plainMentions(messageOf(prompt) ?? prompt).trim().split('\n')[0].replace(/\s+/g, ' ');
  return line.length > 64 ? `${line.slice(0, 63)}…` : line;
}

// Delegations to members on another machine that the wisp this task came from runs (upstream),
// still waiting for it to pick them up (services/relay.js).
function relaysOf(s, store) {
  const relays = Object.values(s.children || {})
    .map((cid) => store?.get(cid))
    .filter((c) => c?.relay?.upstream && c.turns.at(-1)?.relay?.state === 'pending')
    .map((c) => ({ child: c.id, turn: c.turns.at(-1).id, machine: c.relay.machine }));
  return relays.length ? { relays } : {};
}

// A heavy run's memory and CPU: task id -> { rss, cpu }, kept by server/machine.js (only over 500 MB
// or 50%, and changed only when it moved by 20%).
export const taskRes = new Map();

// GET /sessions summarizes every task on each call (hundreds of them): each task's summary is
// kept until it's saved again (store.rev), something every row shows changes (store.epoch: the
// config, a task added or gone, a subagent's save) or the fields a change without a save would
// touch move. Only for the list: other callers get a fresh one they may change.
const listed = new WeakMap();
export function listSummary(s, store) {
  if (!store?.rev) return summarize(s, store);
  const key = `${store.rev.get(s) || 0}.${store.epoch}.${openTerms.has(s.id)}.${taskRes.get(s.id)?.rss ?? ''}:${taskRes.get(s.id)?.cpu ?? ''}.${s.updatedAt}.${s.state}.${s.unread}.${s.archived}.${!!s.ask}.${s.turns.length}.${s.turns.at(-1)?.status}`;
  const kept = listed.get(s);
  if (kept?.key === key) return kept.sum;
  const sum = summarize(s, store);
  listed.set(s, { key, sum });
  return sum;
}

// What a failure's hero says: the error's first line. The rest stays in its terminal block.
const firstLine = (text) => clip(String(text || '').split('\n').find((l) => l.trim()) || '', 200);

// Compact now for the list, which has no turns: the offer, and when it ends by itself (the page
// goes by that, since a kept summary doesn't age). web/js/cold-cache.js.
function compactSummary(s) {
  const offer = compactOffer(s);
  return offer ? { compactOffer: { ...offer, until: compactUntil(s) } } : {};
}

export function summarize(s, store) {
  const project = store?.projectFor(s.cwd);
  const last = s.turns.at(-1);
  // A compact turn reports nothing of its own: the row goes on saying what the last answer said.
  const report = last?.by === 'compact' && last.status === 'done' ? s.turns.findLast((t) => t.by !== 'compact') : last;
  const hero = heroOf(report?.presentation);
  // Only a running turn's last step is shown (and reading activity loads a task's heavy fields: store.js).
  const lastAct = last?.status === 'running' ? last.activity?.findLast?.((a) => a.kind !== 'text') : null;
  // A lead blocked on its subagents says who it's waiting for: in its turn, or after it ended with
  // them still at work (Runner #awaiting), when it stays in Working until their report is read.
  const owes = !s.parentId && s.state === 'running' && last?.status !== 'running' && !s.auto?.busy && s.goal?.status !== 'checking';
  const busy = last?.status === 'running' || owes ? (last?.delegations || []).filter((d) => store?.get(d.sessionId)?.turns.find((t) => t.id === d.turnId)?.status === 'running') : [];
  const waitingOn = busy.length ? `Waiting on ${[...new Set(busy.map((d) => d.name))].join(', ')}` : '';
  return {
    id: s.id,
    title: s.title,
    agent: s.agent,
    cwd: s.cwd,
    scratch: store?.isScratch?.(s.cwd) || undefined,
    project: s.agent === 'wisp' ? 'tour' : (store?.isScratch?.(s.cwd) ? 'General' : project?.name) || path.basename(s.cwd || ''),
    projectId: project?.id || null,
    color: project?.color || 'slate',
    mode: s.mode,
    model: s.model,
    effort: s.effort || '',
    ...(s.account && { account: s.account }), // which of the harness's accounts it runs on (server/accounts.js)
    ...(s.subagentModel !== undefined && { subagentModel: s.subagentModel }), // its own, over the setting ('' is the task's model)
    ...(s.skills && { skills: s.skills }),
    ...(planOf(s) && { plan: planOf(s) }), // its share of each kind of usage window (server/budget.js)
    state: s.state,
    unread: s.unread,
    archived: !!s.archived,
    ...(s.forLater && { forLater: { at: s.forLater.at, by: s.forLater.by } }), // parked to look at again (design/for-later.md)
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    turnCount: s.turns.length,
    queued: s.queue?.length || 0,
    ...(s.queueHeld && s.queue?.length && { queueHeld: true }), // a Stop held them: they wait for you
    later: laterView(s), // follow-ups and reminders scheduled on it (server/later.js)
    reminder: s.reminder ? { text: s.reminder.text, at: s.reminder.at, setAt: s.reminder.setAt, by: s.reminder.by, ...(s.reminder.from && { from: s.reminder.from }), ...(s.reminder.missed && { missed: true }) } : undefined,
    status: last?.status === 'running' || waitingOn || s.auto?.busy || s.goal?.status === 'checking' ? 'running' : last?.status === 'held' ? 'held' : hero?.status || (last?.status === 'error' ? 'blocked' : 'info'),
    ...(haltOf(last) && { halt: haltOf(last) }), // it failed, hit a limit or was refused: the row's word (web/js/core/format.js)
    preview: hero?.summary || '',
    // Ask near the limit (server/guard.js): it waits, held before it started or was sent.
    // ...or a changed harness (server/harness-watch.js, Ask before running a changed harness) waits for Trust.
    // ...or a repo's hooks, servers or setup (server/project-trust.js) wait for Trust and start.
    ...(last?.status === 'held' && { held: (({ kind, label, used, to, line, resetsAt, until, waiting, harness, project }) => (project ? { kind, project: { count: project.items.length, ...(project.changed && { changed: true }), ...(project.setup && { setup: project.setup }) } } : harness ? { kind, harness } : { kind, label, used, to, line, resetsAt, until, ...(waiting && { waiting: true }) }))(last.held) }),
    ...(s.watch && { watch: watchView(s) }), // a page its agent keeps updating beside it (server/watch.js)
    ...(s.tags?.length && { tags: s.tags }), // topic words its agent set with wisp_tag, for search (web/js/tags.js)
    live: s.ask ? `Asks: ${s.ask.question}` : last?.status === 'running' ? waitingOn || lastAct?.label || (last.by === 'compact' ? 'Compacting' : 'Starting up') : waitingOn ? waitingOn : s.auto?.busy ? s.auto.label : s.goal?.status === 'checking' ? 'Checking the goal' : '',
    term: openTerms.has(s.id) || undefined, // taken over in the page: a terminal is open
    ...(taskRes.has(s.id) && { res: taskRes.get(s.id) }), // a heavy run's { rss, cpu } (server/machine.js, design/machine.md)
    ...(s.tui && { tui: true }), // a terminal session: it opens on the agent's own CLI (services/tui.js)
    asks: !!s.ask || !!last?.presentation?.blocks?.some((b) => b.type === 'question'),
    question: s.ask?.question || '',
    options: s.ask?.options?.length && !s.ask.clash ? s.ask.options : undefined, // its choices, answered from the row on a phone (not a clash: that's read before it's answered)
    approval: !!s.ask?.permission, // the question is a live approval (Allow / Deny)
    branch: s.worktree?.branch || '',
    keepWorktree: !!s.keepWorktree, // the cleanup leaves its folder alone (services/worktrees.js)
    foreign: s.worktree?.foreign || '', // a worktree it was brought in on (services/bring-in.js): 'conductor', never removed
    // The task's other folders: their project, worktree branch and PR, for the card and the filter.
    ...(s.also?.length && {
      also: s.also.map((a) => {
        const p = store?.projectFor(a.cwd);
        return { cwd: a.cwd, project: p?.name || path.basename(a.cwd), projectId: p?.id || null, color: p?.color || 'slate', branch: a.worktree?.branch || '', pr: a.pr ? { number: a.pr.number, url: a.pr.url, state: a.pr.state, draft: a.pr.draft, review: a.pr.review, checks: a.pr.checks, conflict: !!a.pr.conflict } : null };
      }),
    }),
    toShip: s.toShip || null, // { dirty, ahead, unpushed } of the worktree, null until checked
    // Other open tasks in the same repo changing the same files (services/overlaps.js)
    ...(s.overlaps?.length && !s.archived && ['running', 'waiting', 'review'].includes(s.state) && { overlaps: s.overlaps }),
    shipping: s.shipping || null, // { step: 'start' | 'commit' | 'push' | 'pr', update } while Ship it runs
    pr: s.pr ? { number: s.pr.number, url: s.pr.url, state: s.pr.state, draft: s.pr.draft, review: s.pr.review, checks: s.pr.checks, conflict: !!s.pr.conflict } : null,
    // PRs its agent attached (wisp_pr), shown on the same row: [{ repo, pr }]
    ...(s.prs?.length && { prs: s.prs.map((x) => ({ repo: x.repo, pr: { number: x.pr.number, url: x.pr.url, state: x.pr.state, draft: x.pr.draft, review: x.pr.review, checks: x.pr.checks, conflict: !!x.pr.conflict } })) }),
    // wisp fixing the PR's merge conflicts on its own: { step: 'fixing' | 'pushing' | 'done' | 'failed', why }
    conflictFix: s.conflictFix ? { step: s.conflictFix.step, why: s.conflictFix.why || '' } : null,
    // Review by another harness of the PR's head (services/review.js): { status, current, by, findings, tests, why }
    review: reviewView(s),
    groupId: s.groupId || null,
    origin: s.origin || null, // { kind: 'recipe' | 'trigger' | 'telegram', id, name }
    ...(s.kind && { kind: s.kind }), // 'spell': a Cast a spell task; 'pane': a Make a pane task
    ...(s.lean && { lean: s.lean }), // 'on' | 'off': this task's own lean runs choice (server/lean.js)
    moved: s.moved || null, // { from }: carried on here from another place (services/move.js)
    movedTo: s.movedTo || null, // { id, place }: this one carried on there, and was archived
    ...(s.forkedFrom && { forkedFrom: s.forkedFrom }), // { id, title, turn, of }: a fork of that task (services/fork.js)
    ...(s.sideOf && { sideOf: { id: s.sideOf.id, title: s.sideOf.title, edits: s.mode !== 'plan' } }), // a side discussion about that task (server/side.js); edits: false on a harness that stays read-only
    ...(s.sides?.length && { sides: store ? s.sides.filter((x) => store.get(x)) : s.sides }), // its side discussions' ids
    ...(s.shared && { shared: { url: s.shared.url, host: s.shared.host, locked: !!s.shared.locked, work: !!s.shared.work, at: s.shared.at } }), // its share link (services/share.js)
    ...(s.sharedFrom && { sharedFrom: { id: s.sharedFrom.id, url: s.sharedFrom.url, host: s.sharedFrom.host, handle: s.sharedFrom.handle, name: s.sharedFrom.name, skills: (s.sharedFrom.kit || []).map((k) => k.name) } }), // imported from someone's share
    ...(s.forks?.length && { forks: store ? s.forks.filter((x) => store.get(x)) : s.forks }), // its forks' ids
    // The roster, for the stacked logos on the card: used = delegated to at least once, busy = working now.
    team: (s.subagents || []).flatMap((m) =>
      copies(m).map((name) => {
        // A crew member's jobs are its own tasks: the latest one this lead handed it.
        const child = store?.get(m.crew ? s.turns.flatMap((t) => t.delegations || []).findLast((d) => d.member === m.name)?.sessionId : s.children?.[name]);
        return { name, agent: child?.agent || m.agent, model: m.model, effort: m.effort, used: !!child, busy: child?.state === 'running', ...(m.crew && { crew: m.crew }) };
      }),
    ),
    ...(s.parentId && { parentId: s.parentId, member: s.member }),
    // A crew member's job (server/crew.js): what it was asked (for the member's thread) and the
    // tasks it followed up in.
    ...(s.crew && { crew: { id: s.crew.id, job: s.crew.job, ...(s.crew.from && { from: s.crew.from }), ...(s.crew.event && { event: s.crew.event }), prompt: plainMentions(s.turns[0]?.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 280), ...(s.crew.sent?.length && { sent: s.crew.sent }), ...(s.crew.kit && { kit: true }) } }),
    ...(s.delegated && { delegated: true }), // a delegate's run for a lead on another wisp (services/relay.js), not a task
    ...relaysOf(s, store),
    // The condition it keeps going for (server/goal.js): its state, round and checks.
    ...(s.goal && { goal: goalView(s.goal) }),
    followups: s.turns.slice(1).filter((t) => t.by !== 'wisp' && t.by !== 'compact').length, // yours, not Auto's repair rounds or a compaction
    ...compactSummary(s),
    // Auto's steps after the run: a hand-over, the best-of-2 pick.
    auto: s.auto
      ? {
          strategy: s.auto.strategy,
          busy: !!s.auto.busy,
          stage: s.auto.stage,
          escalatedTo: s.auto.escalatedTo || null,
          escalatedFrom: s.auto.escalatedFrom || null,
          reason: s.auto.reason || null, // why it moved on: tests | error | limit
          pick: s.auto.pick && !s.auto.pick.pending ? s.auto.pick : null,
        }
      : null,
    // Auto: what it picked and why, for the card's tooltip.
    route: s.route ? { goal: s.route.goal, type: s.route.type, label: s.route.label, effort: s.route.effort, chance: s.route.chance, n: s.route.n, usd: s.route.usd, explored: s.route.explored, trying: s.route.trying, alternatives: s.route.alternatives, why: s.route.why, suggest: s.route.suggest, pinned: s.route.pinned, ...(s.route.switched && { switched: true }) } : null,
  };
}

export class Runner extends EventEmitter {
  // bridge: { url, token } — how the injected ask_user MCP server reaches us.
  constructor(store, bridge) {
    super();
    this.store = store;
    this.bridge = bridge;
    this.live = new Map(); // sessionId -> adapter handle
    this.stopping = new Set();
    this.interrupting = new Set();
    this.signIns = new Map(); // turn id -> { sessionId, agent, account, until }: reruns a sign-in waits on (armSignIn)
    this.handing = new Set(); // ids whose run ended with a follow-up waiting to start: they stay in Working
    this.deleting = new Set(); // ids being deleted: their run ends quietly, no card back in Needs you, no "ready"
    this.answers = new Map(); // askId -> answer, until the MCP server picks it up
    this.sides = new Map(); // /btw id -> { sessionId, handle }: side questions being answered
    this.promptExtra = () => ''; // (session) => text appended to the system prompt (learned preferences)
    this.spellBlocks = () => []; // (session) => block types spells add, for the protocol
    this.routeAuto = null; // (prompt, { cwd }) => { agent, model, route } for subagents set to Auto
    // The crew (server/crew.js): a job's note in its system prompt, what its turn hands back
    // ({ quiet }), and a lead's delegation to a member (a job of its own, made by the crew).
    this.crewNote = () => '';
    this.crewDirs = () => [];
    this.crewTurn = () => ({});
    this.crewDelegate = null;
    this.crewChild = () => null; // a member's job on another machine, as last fetched (id → session)
    this.pipeline = null; // Auto's hand-over / best-of-2 steps (server/pipeline.js)
    this.accounts = null; // a harness's several accounts (server/accounts.js); null: only the CLI's own
    this.accountPref = () => ''; // (agent) => the account you last picked for it
    this.goals = null; // goals: keep going until a condition holds (server/goal.js)
    this.sidePending = new Map(); // a clash card's ask id -> the tool call it holds (server/side-gate.js)
    this.sideGate = createSideGate({
      store,
      workdir,
      change: (side, turn, ev) => adapters[side.agent]?.approveTool && this.#onEvent(side, turn, { type: 'change', ...ev }), // others report their own, once done
      warn: (side, turn, item) => this.#sideWarn(side, turn, item),
      ask: (side, a) => this.ask(side, a),
      tell: (side, text) => this.#tellMain(side, text),
      answered: (side, a) => this.#sideAnswered(side, a),
      touch: (side, turn) => this.#touch(side, { turn: turn?.id }),
    });

    // Anything that was mid-flight when wisp last died is now orphaned.
    const died = restartReason();
    for (const s of store.all()) {
      const t = s.turns.at(-1);
      delete s.ask;
      if (s.auto?.busy) Object.assign(s.auto, { busy: false, stage: 'cancelled', label: '' }); // Auto's step died with wisp
      // A goal whose round or check died with wisp waits for you (Resume picks it up).
      if (['working', 'checking'].includes(s.goal?.status) && (s.goal.status === 'checking' || s.state === 'running' || t?.status === 'running')) Object.assign(s.goal, { status: 'paused', why: died.short });
      if (s.state === 'running' || s.state === 'waiting' || t?.status === 'running') {
        if (t?.status === 'running') this.#finishTurn(s, t, { isError: true, stopped: true, text: '' }, died);
        s.state = 'review';
        store.save(s);
      }
      const asked = s.turns.flatMap((x) => x.btw || []).filter((b) => b.status === 'running');
      for (const b of asked) Object.assign(b, { status: 'error', error: died.asked });
      if (asked.length) store.save(s);
    }
  }

  // subagents: the team a lead may delegate to. parentId/member: this session is one of them.
  // also: the task's other folders, [{ cwd, worktree }] (services/launch.js).
  // history / title / moved: a task moved here from another place, with the turns it had there.
  create({ id = newId(), prompt, cwd, also = [], agent = 'claude', mode = 'auto', model = '', effort = '', account = '', attachments = [], worktree = null, groupId = null, origin = null, subagents = [], parentId = null, member = '', route = null, auto = null, scout = null, history = [], title = '', moved = null, kind = '', relay = null, delegated = null, crew = null, goal = null, forkedFrom = null, sideOf = null, hold = null, sharedFrom = null, idle = false, tui = false, subagentModel, skills = '', trial = null, capped = null }) {
    if (!adapters[agent] && !(relay && agent === 'auto')) throw new Error(`Unknown agent: ${agent}`);
    const now = Date.now();
    const session = {
      id,
      title: title || autoTitle(prompt),
      titleAuto: !title,
      agent,
      cwd,
      mode,
      model,
      effort,
      // You started it yourself (not a crew job, schedule, trigger or subagent): see #accountFor.
      ...(this.#accountFor(agent, account, !origin && !parentId && !crew && !delegated) && { account: this.#accountFor(agent, account, !origin && !parentId && !crew && !delegated) }),
      state: 'running',
      unread: false,
      createdAt: now,
      updatedAt: now,
      agentSessionId: null,
      agentSessions: {}, // harness -> its own conversation id, so switching back resumes it
      queue: [],
      turns: [...history],
      ...(moved && { moved }),
      ...(forkedFrom && { forkedFrom }), // { id, title, turn, of }: forked from that task's turn (services/fork.js)
      ...(sideOf && { sideOf }), // { id, title, cwd }: a side discussion about that task (server/side.js)
      ...(sharedFrom && { sharedFrom }), // { id, url, host, handle, name, title, kit? }: imported from a share (services/share.js)
      ...(capped && { capped }), // { mode }: started from a channel at that cap (server/capped.js)
      ...(kind && { kind }), // 'spell': a Cast a spell task (server/spell-guide.js); 'pane': Make a pane (server/pane-guide.js)
      ...(worktree && { worktree }),
      ...(also.length && { also }),
      ...(groupId && { groupId }),
      ...(origin && { origin }),
      ...(subagents.length && { subagents, children: {} }),
      ...(auto && { auto: { strategy: 'single', busy: false, stage: '', label: '', ...auto } }), // server/pipeline.js
      ...(scout && { scout }), // what the scout found before it started (server/scout.js)
      ...(parentId && { parentId, member }),
      ...(relay && { relay }), // a member on another machine: { machine, place, upstream? } (services/relay.js)
      ...(delegated && { delegated }), // a delegate's run for a lead elsewhere: { lead, name }
      ...(crew && { crew }), // a crew member's job: { id, job, from?, reply? } (server/crew.js)
      ...(route && { route }), // how Auto picked agent, model and level (server/router.js)
      ...(subagentModel !== undefined && { subagentModel }), // its own, over defaults.subagentModel: '' is the task's model
      ...(skills === 'off' && { skills }), // Claude Code without its skills (adapters/claude.js)
      ...(trial && { trial }), // Try it two ways: { differs, kept } (services/launch.js)
    };
    if (goal && !parentId && !delegated) this.goals?.attach(session, goal);
    this.store.put(session);
    if (!parentId && !delegated && !sideOf) for (const dir of [...also.map((a) => a.cwd), cwd]) this.store.touchProject(dir); // a subagent's cwd may be the lead's worktree
    // Ask near the limit (server/guard.js): an automation's task that would cross your line waits.
    // idle: an imported task with nothing asked yet: its history shows, and it waits for your follow-up.
    if (idle) Object.assign(session, { state: 'review', unread: false });
    else if (tui) this.#tuiTurn(session, prompt, attachments);
    else if (hold) this.#holdTurn(session, prompt, attachments, {}, hold);
    else this.#startTurn(session, prompt, attachments);
    return session;
  }

  // Terminal sessions (Settings → General): the task is the agent's own CLI in a terminal in the page,
  // started with the prompt (services/tui.js). wisp keeps the prompt as its one turn and runs nothing.
  #tuiTurn(session, prompt, attachments = []) {
    const turn = this.#newTurn(session, prompt, attachments);
    const name = adapters[session.agent]?.name || session.agent;
    Object.assign(turn, { tui: true, status: 'done', endedAt: Date.now(), presentation: { blocks: [{ type: 'hero', title: 'In the terminal', summary: `This task runs in ${name}'s own terminal. Open it to carry on.`, status: 'info' }] } });
    session.turns.push(turn);
    Object.assign(session, { tui: true, state: 'review', unread: false });
    this.#touch(session, { turn: turn.id });
  }

  // A run that would take its account's window past your line (server/guard.js), kept as a held
  // turn: its prompt shows, with a card (Start now, Wait until the reset, Skip this run), and the
  // task waits in Needs you. It goes by itself at `until` (Later's tick), or when you start it.
  // opts: what the follow-up carried (mode, run, team, by, later, goal), used when it goes.
  #holdTurn(session, prompt, attachments = [], opts = {}, hold) {
    const now = Date.now();
    const kind = session.turns.length ? 'followUp' : 'first';
    session.turns.push({
      id: newId(),
      prompt,
      agent: opts.run?.agent || session.agent,
      model: opts.run?.model ?? session.model,
      effort: opts.run?.effort ?? (session.effort || ''),
      ...(session.account && { account: session.account }),
      mode: opts.mode || session.mode,
      attachments: attachments.map(({ id, name, mime, size }) => ({ id, name, mime, size })),
      ...((opts.by === 'wisp' || opts.by === 'compact') && { by: opts.by }),
      ...(opts.by === 'wisp' && opts.goal && { goal: opts.goal }),
      ...(opts.by === 'later' && opts.later && { later: opts.later }),
      startedAt: now,
      endedAt: null,
      status: 'held',
      // A changed harness has no reset to wait for: it waits for Trust and start, or Skip.
      held: hold.project
        ? { kind, agent: hold.agent, project: hold.project, at: now }
        : hold.harness
        ? { kind, agent: hold.agent, harness: hold.harness, at: now }
        : { kind, agent: hold.agent, account: hold.account, id: hold.id, label: hold.label, used: hold.used, to: hold.to, line: hold.line, resetsAt: hold.resetsAt, until: this.guard?.until?.(hold) || now + 3600_000, at: now },
      run: { attachments, opts },
      activity: [],
      changes: [],
      presentation: null,
      stats: null,
    });
    session.state = 'review';
    session.unread = true;
    delete session.archived;
    delete session.forLater;
    this.#touch(session);
    this.emit('held', { session });
  }

  // The held turn goes now (Start now, or its reset came). false when there's none.
  release(session) {
    const t = session.turns.at(-1);
    if (t?.status !== 'held') return false;
    session.turns.pop();
    const { attachments = [], opts = {} } = t.run || {};
    const next = { text: t.prompt, attachments, ...opts };
    if (this.live.has(session.id)) {
      session.queue.push({ id: newId(), ...next });
      this.#touch(session);
      return true;
    }
    if (next.mode) session.mode = next.mode;
    if (next.run && adapters[next.run.agent]) this.#switchRun(session, next.run);
    if (next.team) setTeam(session, next.team);
    this.#startTurn(session, next.text, next.attachments, next);
    return true;
  }

  // Skip this run: the held turn stays, stopped, so the task says what was skipped and when.
  skipHeld(session) {
    const t = session.turns.at(-1);
    if (t?.status !== 'held') return false;
    const why = t.held.project ? 'This repo’s hooks, servers or setup weren’t trusted.' : t.held.harness ? `${adapters[t.held.agent]?.name || t.held.agent} had changed and wasn’t trusted.` : `${t.held.label} window was near its limit.`;
    Object.assign(t, { status: 'stopped', skipped: true, endedAt: Date.now(), presentation: { blocks: [{ type: 'hero', title: 'Skipped before it started', summary: why, status: 'info' }] } });
    delete t.run;
    session.state = 'done';
    session.unread = false;
    this.#touch(session);
    return true;
  }

  // mode: switch the permission mode (plan / edits / auto) from this follow-up on. A queued
  // follow-up keeps its own, so the run before it isn't affected. run: { agent, model, effort }
  // switches the harness, model and thinking level the same way (see #switchRun).
  // grants / once: a retry of what the last turn's permissions blocked (see approveBlocked).
  // by: 'wisp' for a follow-up wisp sends itself (Auto's repair round). Anything else is the
  // user's, and cancels whatever Auto was about to do next.
  // team: a new roster of subagents (normalized; [] drops them) for this follow-up and the ones after it.
  // by: 'later' for a follow-up scheduled earlier (server/later.js), with later: { by, setAt, at, late? }.
  // goal: the round a follow-up from wisp starts toward the task's goal (server/goal.js).
  // hold: Ask near the limit (server/guard.js) said this follow-up would cross your line: it's kept
  // as a held turn instead. Scheduled follow-ups and goal rounds are checked here themselves.
  // side: { id, title }: sent by wisp from that side discussion (the turn says so).
  reply(session, text, attachments = [], { queue = false, mode, run, team, grants, once, by, later, goal, hold, side } = {}) {
    if (!MODES.has(mode) || mode === session.mode || session.sideOf) mode = undefined; // a side discussion's mode is its harness's (sideMode)
    run = changedRun(session, run);
    if (session.parentId || session.sideOf || (team && JSON.stringify(team) === JSON.stringify(session.subagents || []))) team = undefined;
    // by: 'compact': Compact now (POST /sessions/:id/compact). Housekeeping, not a word from you:
    // what was going on carries on, and its turn checks nothing.
    const compact = by === 'compact';
    if (by !== 'wisp' && by !== 'later' && !compact) this.pipeline?.cancel(session);
    if (by !== 'wisp' && !compact) this.goals?.cancel(session);
    if (by !== 'wisp' && !compact) delete session.queueHeld; // you're back: a queue a Stop held carries on after this
    const extra = { ...(by === 'wisp' && goal && { goal }), ...(mode && { mode }), ...(run && { run }), ...(team && { team }), ...(grants?.length && { grants }), ...(MODES.has(once) && { once }), ...((by === 'wisp' || by === 'later' || compact) && { by }), ...(by === 'later' && later && { later }), ...(side && { side }) };
    if (session.ask && !Object.keys(extra).length) {
      this.answer(session, text);
      return { answered: true };
    }
    // A held run goes first: what you send now queues behind it. Switched to Full auto, a run held
    // on the repo's trust card goes in Full auto, unasked (not one whose new worktree's setup is
    // held: that setup runs from the card).
    const held = session.turns.at(-1);
    if (held?.status === 'held') {
      if (mode === 'auto' && held.held?.project && held.run && ![session, ...(session.also || [])].some((x) => x.worktree?.prepared?.held)) held.run.opts = { ...held.run.opts, mode };
      this.release(session);
      queue = true;
    }
    // Not the carry-on after a usage limit: it's sent at the reset, for a window you already chose to wait for.
    if (!hold && !session.parentId && !session.delegated && text !== LIMIT_CARRY_ON && (by === 'later' || (by === 'wisp' && goal))) hold = this.guard?.check?.({ agent: run?.agent || session.agent, account: run?.account ?? session.account, kind: 'followUp', session });
    let handle = this.live.get(session.id);
    // A CLI only lingering after its result has nothing left to wait for: let it go, so the hold holds.
    if (hold && handle && session.turns.at(-1)?.status !== 'running' && !session.queue.length) {
      handle.release();
      handle = null;
    }
    if (hold && !handle) {
      this.#holdTurn(session, text, attachments, extra, hold);
      return { held: true };
    }
    if (handle) {
      const turn = session.turns.at(-1);
      // The run already produced its result and the CLI is only lingering on its way out:
      // there's nothing to wait for, so let it go and start the follow-up now.
      if (turn?.status !== 'running') {
        session.queue.push({ id: newId(), text, attachments, ...extra });
        handle.release();
        return { queued: session.queue.length > 0 };
      }
      // Interrupting needs an agent session to resume; before the agent reports one, queue.
      if (queue || !session.agentSessionId) {
        session.queue.push({ id: newId(), text, attachments, ...extra });
        this.#touch(session);
        return { queued: true, ahead: session.queue.length - 1 };
      }
      // Ahead of anything queued, but after earlier interrupting follow-ups, so they keep their order.
      const at = session.queue.findIndex((q) => !q.now);
      session.queue.splice(at < 0 ? session.queue.length : at, 0, { id: newId(), text, attachments, now: true, ...extra });
      this.#interrupt(session);
      return { interrupted: true };
    }
    if (mode) session.mode = mode;
    if (run) this.#switchRun(session, run);
    if (team) setTeam(session, team);
    this.#startTurn(session, text, attachments, extra);
    return { queued: false };
  }

  // The card under a turn whose permissions refused something: allow retries it as a follow-up,
  // with exactly those actions allowed where the harness can scope a grant, else in Full auto for
  // that one follow-up. Deny just closes the card.
  approveBlocked(session, { turnId, allow }) {
    const turn = turnId ? session.turns.find((t) => t.id === turnId) : session.turns.at(-1);
    if (!turn?.blocked?.length) throw bad('Nothing on that turn is waiting for approval.', 404);
    if (allow && session.sideOf) throw bad('A side discussion can’t allow this: ask the main task to do it.', 409);
    if (turn.approval) throw bad(`Already ${turn.approval}.`, 409);
    // A CLI still lingering after its result doesn't count: reply() lets it go and starts the retry.
    if (turn !== session.turns.at(-1) || (this.live.has(session.id) && turn.status === 'running')) throw bad('The task has moved on since; send a follow-up instead.', 409);
    turn.approval = allow ? 'allowed' : 'denied';
    if (!allow) {
      this.#touch(session, { turn: turn.id });
      return { denied: true };
    }
    const scoped = turn.blocked.every((b) => b.rule !== undefined);
    const out = this.reply(session, retryPrompt(turn.blocked, scoped), [], scoped ? { grants: turn.blocked.map((b) => b.rule) } : { once: 'auto' });
    this.#touch(session, { turn: turn.id });
    return { ...out, scoped };
  }

  // A follow-up on another harness, model or thinking level. A model or level change resumes the
  // same conversation; a harness change resumes that harness's own one (if it ran earlier in this
  // task) or starts it fresh, and #startTurn hands it the turns it missed.
  #switchRun(session, { agent, model, effort, account }) {
    session.agentSessions ||= {};
    // Sessions from before agentSessions: their conversation belongs to the harness they ran on.
    if (session.agentSessionId) session.agentSessions[session.agent] = session.agentSessionId;
    for (const t of session.turns) t.agent ||= session.agent;
    // Auto's pick was overruled: the card stops crediting it, and the router learns (services/auto.js).
    if (session.route && (agent !== session.agent || model !== session.model || effort !== (session.effort || ''))) session.route.switched = true;
    // No effort with the switch (Hand to <harness> on the refusal and limit cards): the task keeps its
    // thinking level, as the new harness (and model) names it, not the new harness's default.
    if (agent !== session.agent) {
      session.agent = agent;
      session.agentSessionId = session.agentSessions[agent] || null;
      const acc = this.#accountFor(agent, account);
      if (acc) session.account = acc;
      else delete session.account;
    } else if (account !== undefined) this.#switchAccount(session, account);
    session.model = model;
    session.effort = effort;
  }

  // The account a run that nobody started by hand would get (Automations stop at checks it first).
  accountOf(agent, want = '') {
    return this.#accountFor(agent, want, false) || 'default';
  }

  // Which account a run of `agent` gets: the one asked for when the harness has it, else your last
  // pick (byHand: skipping one already at its limit, server/accounts.js pick). '' when the harness
  // has only the CLI's own.
  accountFor(agent, want = '', byHand = true) {
    return this.#accountFor(agent, want, byHand);
  }

  #accountFor(agent, want = '', byHand = true) {
    const a = this.accounts;
    if (!a?.multi?.(agent)) return '';
    if (want && want !== 'auto' && a.get(agent, want)) return want;
    return a.pick(agent, this.accountPref(agent), { byHand });
  }

  // Another account of the same harness from the next turn on. A harness whose conversations don't
  // carry over between logins starts a fresh one there, with a handoff of the turns it missed.
  #switchAccount(session, want) {
    const next = this.#accountFor(session.agent, want);
    const was = session.account || '';
    if (!next || next === was) return;
    if (ACCOUNT_HOMES[session.agent]?.resumes === false) {
      session.agentSessions ||= {};
      if (session.agentSessionId) session.agentSessions[`${session.agent}@${was || 'default'}`] = session.agentSessionId;
      session.agentSessionId = session.agentSessions[`${session.agent}@${next}`] || null;
    }
    session.account = next;
  }

  // The env a run on the task's account needs, its folder made ready first.
  #accountEnv(session, agent = session.agent) {
    const id = agent === session.agent ? session.account : '';
    if (!id || !this.accounts) return {};
    try {
      this.accounts.prepare(agent, id);
    } catch (err) {
      console.warn(`wisp: account ${agent}/${id}: ${err.message}`);
    }
    return this.accounts.envFor(agent, id);
  }

  // Drop a follow-up that hasn't gone out yet.
  unqueue(session, itemId) {
    const at = session.queue.findIndex((q) => q.id === itemId);
    if (at < 0) return false;
    session.queue.splice(at, 1);
    if (!session.queue.length) delete session.queueHeld;
    this.#touch(session);
    return true;
  }

  // A queued follow-up as the next turn: its own mode, harness, account and team from here on.
  #startQueued(session, next) {
    if (next.mode) session.mode = next.mode;
    if (next.run && adapters[next.run.agent]) this.#switchRun(session, next.run);
    if (next.account) this.#switchAccount(session, next.account);
    if (next.team) setTeam(session, next.team);
    this.#startTurn(session, next.text, next.attachments, next);
  }

  // Send now: this queued follow-up goes next, interrupting the run (as a follow-up sent while it
  // works does), or at once when nothing runs. Before the agent reports a session to resume it
  // can't interrupt: then it's just next. A queue a Stop held carries on after it.
  sendQueued(session, itemId) {
    const at = session.queue.findIndex((q) => q.id === itemId);
    if (at < 0) return false;
    const [q] = session.queue.splice(at, 1);
    delete session.queueHeld;
    if (q.by !== 'wisp') {
      this.pipeline?.cancel(session);
      this.goals?.cancel(session);
    }
    const handle = this.live.get(session.id);
    if (!handle) {
      this.#startQueued(session, q);
      return true;
    }
    const first = session.queue.findIndex((x) => !x.now);
    const running = session.turns.at(-1)?.status === 'running';
    session.queue.splice(first < 0 ? session.queue.length : first, 0, running && session.agentSessionId ? { ...q, now: true } : q);
    if (!running) handle.release();
    else if (session.agentSessionId) this.#interrupt(session);
    else this.#touch(session);
    return true;
  }

  // Combine queued follow-ups into one (ids, in the queue's order): it goes where the first was,
  // with its mode and harness, saying each in turn, with all their files. Only yours.
  mergeQueued(session, ids) {
    const want = new Set(ids);
    const picked = session.queue.filter((q) => want.has(q.id) && q.by !== 'wisp');
    if (picked.length < 2) return false;
    const [first, ...rest] = picked;
    first.text = picked.map((q) => q.text.trim()).join('\n\n');
    first.attachments = picked.flatMap((q) => q.attachments || []);
    session.queue = session.queue.filter((q) => !rest.includes(q));
    this.#touch(session);
    return true;
  }

  // Change what a queued follow-up says. Only yours: wisp's own (reports back, repairs) aren't.
  editQueued(session, itemId, text) {
    const q = session.queue.find((x) => x.id === itemId);
    if (!q || q.by === 'wisp') return false;
    q.text = text;
    this.#touch(session);
    return true;
  }

  // Put the queue in this order (ids). Ids it doesn't know are skipped; any left out keep their
  // place at the end, so an item queued meanwhile isn't lost. false when nothing's left to order.
  reorderQueue(session, ids) {
    if (!session.queue.length) return false;
    const byId = new Map(session.queue.map((q) => [q.id, q]));
    const picked = [...new Set(ids)].map((id) => byId.get(id)).filter(Boolean);
    const rest = session.queue.filter((q) => !picked.includes(q));
    session.queue.splice(0, session.queue.length, ...picked, ...rest);
    this.#touch(session);
    return true;
  }

  // /btw: a side question, answered by a read-only run of its own while the task's run carries on
  // (server/btw.js). It lands on the latest turn and never reaches the task's conversation.
  btw(session, question, attachments = []) {
    const turn = session.turns.at(-1);
    if (!turn) throw bad('Nothing to ask about yet.', 409);
    if ([...this.sides.values()].filter((x) => x.sessionId === session.id).length >= MAX_BTW) throw bad(`${MAX_BTW} side questions are still being answered. Ask again once one is in.`, 429);
    const entry = {
      id: newId(),
      question,
      status: 'running',
      askedAt: Date.now(),
      agent: session.agent,
      model: session.model || '',
      ...(attachments.length && { attachments: attachments.map(({ id, name, mime, size }) => ({ id, name, mime, size })) }),
    };
    (turn.btw ||= []).push(entry);
    this.#sideRun(session, turn, entry, attachments, !!adapters[session.agent]?.fork && !!session.agentSessionId);
    this.#btwChanged(session, turn);
    return entry;
  }

  // forked: on a copy of the agent's conversation, so it knows what the run did and why. A fork
  // that fails (a CLI too old to fork) asks again with wisp's record of the task instead.
  // What the agent saved in My Stuff this turn (wisp_save) shows in its answer as a stuff block: one
  // it left out goes before the closing actions. Each block keeps the item's title and kind as they
  // were, so it still reads right once the item is gone.
  #keepStuff(session, turn) {
    const blocks = turn.presentation?.blocks;
    if (!Array.isArray(blocks)) return;
    const saved = session.savedStuff || [];
    delete session.savedStuff;
    const shown = new Set(blocks.filter((b) => b?.type === 'stuff').map((b) => String(b.id || '').trim()));
    const add = saved.filter((id) => !shown.has(id) && this.stuff?.get(id)).map((id) => ({ type: 'stuff', id }));
    if (add.length) {
      const end = blocks.findIndex((b) => ['actions', 'next', 'question'].includes(b?.type));
      blocks.splice(end === -1 ? blocks.length : end, 0, ...add);
    }
    for (const b of blocks) {
      if (b?.type !== 'stuff' || typeof b.id !== 'string') continue;
      const it = this.stuff?.get(b.id.trim());
      if (it) Object.assign(b, { id: it.id, title: it.title, kind: it.kind });
    }
  }

  #sideRun(session, turn, entry, attachments, forked) {
    const adapter = adapters[entry.agent];
    const name = (t) => adapters[t.agent || session.agent]?.name || t.agent || session.agent;
    const question = agentPrompt(entry.question, this.store, { tool: null, self: session.id, stuff: this.stuff });
    entry.forked = forked;
    let reply = null;
    let handle;
    try {
      handle = adapter.run({
        prompt: btwPrompt(session, question, { forked, name }),
        attachments,
        cwd: workdir(session),
        dirs: alsoDirs(session),
        resumeId: forked ? session.agentSessionId : null,
        fork: forked,
        mode: 'plan',
        model: entry.model,
        effort: session.effort || '',
        systemPrompt: BTW_SYSTEM,
        accountEnv: this.#accountEnv(session, entry.agent),
        runEnv: { WISP_TASK: session.id },
        untrusted: !!this.projectPending(session, entry.agent),
        quiet: leanTask(session, this.store.config?.defaults), // a /btw is yours: lean as the task is (server/lean.js)
        onEvent: (ev) => {
          if (ev.type === 'result') reply = ev;
        },
      });
    } catch (err) {
      reply = { isError: true, text: err.message };
      handle = { done: Promise.resolve(), stop() {} };
    }
    const side = { sessionId: session.id, handle, timedOut: false };
    this.sides.set(entry.id, side);
    const timer = setTimeout(() => ((side.timedOut = true), handle.stop()), BTW_TIMEOUT_MS);
    handle.done.then(() => {
      clearTimeout(timer);
      if (this.sides.get(entry.id) !== side) return; // dismissed, or the task was deleted
      this.sides.delete(entry.id);
      const ok = reply && !reply.isError && !reply.stopped;
      if (!ok && forked && !side.timedOut) return this.#sideRun(session, turn, entry, attachments, false);
      if (ok) Object.assign(entry, { status: 'done', answer: btwAnswer(reply.text), ...(reply.stats?.costUsd && { costUsd: reply.stats.costUsd }) });
      else Object.assign(entry, { status: 'error', error: side.timedOut ? `No answer after ${BTW_TIMEOUT_MS / 60_000} minutes.` : clip(reply?.text || 'The side run ended without an answer.', 400) });
      entry.answeredAt = Date.now();
      this.#btwChanged(session, turn);
    });
  }

  // Dismiss a side question, stopping its run if it's still going.
  dropBtw(session, id) {
    const turn = session.turns.find((t) => t.btw?.some((b) => b.id === id));
    if (!turn) return false;
    turn.btw = turn.btw.filter((b) => b.id !== id);
    if (!turn.btw.length) delete turn.btw;
    this.sides.get(id)?.handle.stop();
    this.sides.delete(id);
    this.#btwChanged(session, turn);
    return true;
  }

  // The task is going away: its side questions stop too.
  stopSides(session) {
    for (const [id, side] of this.sides) {
      if (side.sessionId !== session.id) continue;
      this.sides.delete(id);
      side.handle.stop();
    }
  }

  // A side entry changed (a /btw answer, or a crew member's answer to an @mention: server/crew.js).
  sideChanged(session, turn) {
    this.#btwChanged(session, turn);
  }

  // A side question changed: the card repaints it in place. The task's own state is untouched.
  #btwChanged(session, turn) {
    this.store.save(session);
    this.emit('turn', { sessionId: session.id, turnId: turn.id });
  }

  // ask_user: the agent is blocked inside a tool call until answer() is called.
  // permission: set for a live approval ({ tool, action, detail }), see requestApproval().
  // connector: a connector waiting for the user's sign-in or keys ({ id, name, kind, keys }).
  // clash: a side discussion's clash card (server/side-gate.js).
  ask(session, { question, context, options, permission, connector, clash }) {
    const turn = session.turns.at(-1);
    session.ask = {
      id: newId(),
      question: String(question || '').trim() || 'The agent has a question.',
      context: context ? String(context) : '',
      options: Array.isArray(options) ? options.map(String).slice(0, 6) : [],
      askedAt: Date.now(),
      ...(permission && { permission }),
      ...(connector && { connector }),
      ...(clash && { clash }),
    };
    session.state = 'waiting';
    session.unread = true;
    delete session.archived; // a question needs the user, so it comes back to the feed
    const label = clash ? `Clash with the main task: ${clash.file || clash.command}` : permission ? `Needs your OK to ${permission.action}` : `Asked you: ${session.ask.question}`;
    if (turn) this.#onEvent(session, turn, { type: 'tool', kind: 'ask', label });
    this.#touch(session, { turn: turn?.id });
    this.emit('finished', { session: summarize(session, this.store) });
    return session.ask.id;
  }

  // Live approval: the harness asks before a tool call its permission mode doesn't allow on its
  // own (Claude's --permission-prompt-tool). It waits on the answer like ask_user; something the
  // user said "always" to earlier in this task goes through at once.
  requestApproval(session, { tool, input, tool_use_id }) {
    const adapter = adapters[session.agent];
    const p = adapter.permission?.(String(tool || ''), input && typeof input === 'object' ? input : {}, workdir(session)) || { tool: String(tool || 'tool'), action: `use ${tool}`, detail: '' };
    const turn = session.turns.at(-1);
    // A side discussion: wisp's gate decides (server/side-gate.js). On a harness that can't ask
    // before a write it stays read-only, and what its mode didn't allow is refused without asking.
    if (session.sideOf) {
      if (this.sideMode(session.agent) === 'edits') return this.#sideDecide(session, { tool: String(tool || ''), input: input && typeof input === 'object' ? input : {}, tool_use_id });
      if (turn) this.#onEvent(session, turn, { type: 'tool', kind: 'answer', label: `Refused (side discussions on ${adapter.name} only read): ${p.action}` });
      return { decision: 'deny', message: SIDE_DENIED };
    }
    if ((session.grants || []).some((g) => sameAction(g, p))) {
      if (turn) this.#onEvent(session, turn, { type: 'tool', kind: 'answer', label: `Allowed (always in this task): ${p.action}` });
      return { decision: 'allow' };
    }
    const id = this.ask(session, {
      question: `Allow ${adapter.name} to ${p.action}?`,
      context: p.why || '',
      options: [APPROVAL.allow, APPROVAL.always, APPROVAL.deny],
      permission: { tool: p.tool, action: p.action, detail: p.detail },
    });
    return { id };
  }

  async #sideDecide(session, call) {
    const out = await this.sideGate.decide(session, call);
    if (!out.id) return out;
    this.sidePending.set(out.id, out.pending);
    return { id: out.id };
  }

  // The mode a side discussion runs in on this harness: Edits behind the gate where wisp can ask
  // before a write, else Plan.
  sideMode(agent) {
    return adapters[agent]?.sideGate && this.bridge ? 'edits' : 'plan';
  }

  // The clash card's answer (POST /sessions/:id/clash, or /answer): action 'apply' or 'keep'.
  clashAnswer(session, { askId, action, sig, words } = {}) {
    const ask = session.ask;
    if (!ask?.clash || (askId && ask.id !== askId)) throw bad('That card has moved on.', 409);
    const pending = this.sidePending.get(ask.id);
    if (!pending) throw bad('That card has moved on.', 409);
    const out = this.sideGate.settle(session, pending, { action, sig, words });
    if (out.stale) throw Object.assign(bad('The main task moved: look at the card again before you apply it.', 409), { stale: true });
    this.sidePending.delete(ask.id);
    return out;
  }

  #sideAnswered(session, { decision, message, label }) {
    const ask = session.ask;
    this.answers.set(ask.id, { answer: label, decision, ...(message && { message }) });
    ask.answer = label;
    delete session.ask;
    session.state = this.live.has(session.id) ? 'running' : 'review';
    const turn = session.turns.at(-1);
    if (turn) this.#onEvent(session, turn, { type: 'tool', kind: 'answer', label });
    this.#touch(session, { turn: turn?.id });
  }

  // A row in a side discussion's turn: it touched what the main task is working on.
  #sideWarn(session, turn, item) {
    if (!turn) return;
    const list = (turn.sideWarn ||= []);
    if (!list.some((w) => w.kind === item.kind && w.file === item.file)) list.push(item);
    this.#touch(session, { turn: turn.id });
  }

  // What a side discussion did, for the main task: in its follow-up queue while it runs (Stop keeps
  // the queue), a follow-up when it's idle. A held turn stays held: this waits behind it.
  #tellMain(side, text) {
    const main = this.store.get(side.sideOf.id);
    if (!main) return false;
    const from = { id: side.id, title: side.title };
    if (main.turns.at(-1)?.status === 'held') {
      main.queue.push({ id: newId(), text, attachments: [], by: 'wisp', side: from });
      this.#touch(main);
      return true;
    }
    this.reply(main, text, [], { queue: true, by: 'wisp', side: from });
    return true;
  }

  answer(session, text) {
    const ask = session.ask;
    if (!ask) return false;
    // A clash card goes through its own recheck. Typed words keep main's version, with those words.
    if (ask.clash) {
      try {
        this.clashAnswer(session, text === SIDE_APPLY || text === SIDE_APPLY_OTHER ? { action: 'apply' } : { action: 'keep', words: text === SIDE_KEEP || text === SIDE_KEEP_OTHER ? '' : text });
        return true;
      } catch (err) {
        if (err.stale) return false;
        throw err;
      }
    }
    ask.answer = text;
    const turn = session.turns.at(-1);
    let label = `You answered: ${text}`;
    if (ask.permission) {
      const d = approvalDecision(text);
      this.answers.set(ask.id, { answer: text, ...d });
      const p = ask.permission;
      if (d.always) (session.grants ||= []).push({ tool: p.tool, detail: p.detail });
      // Denied here, so the turn's "blocked" card shouldn't offer it again.
      if (d.decision === 'deny' && turn) (turn.denied ||= []).push({ tool: p.tool, detail: p.detail });
      label = d.decision === 'allow' ? `You allowed${d.always ? ' (always in this task)' : ''}: ${p.action}` : `You denied: ${p.action}${d.message ? ` (“${d.message}”)` : ''}`;
    } else this.answers.set(ask.id, { answer: text });
    delete session.ask;
    session.state = this.live.has(session.id) ? 'running' : 'review';
    if (turn) this.#onEvent(session, turn, { type: 'tool', kind: 'answer', label });
    this.#touch(session, { turn: turn?.id });
    return true;
  }

  // { answer } once answered (plus { decision, message? } for an approval), { pending }, or { cancelled }.
  pollAnswer(askId) {
    if (this.answers.has(askId)) {
      const out = this.answers.get(askId);
      this.answers.delete(askId);
      return out;
    }
    const open = this.store.all().some((s) => s.ask?.id === askId);
    return open ? { pending: true } : { cancelled: true };
  }

  // delegate: the lead hands tasks to members of its team. Each member is one child session,
  // created on first use and resumed after that. Returns one record (or { error }) per task.
  async delegate(lead, tasks) {
    const turn = lead.turns.at(-1);
    if (turn?.status !== 'running') throw bad('The lead agent is not running.', 409);
    const team = lead.subagents || [];
    if (!team.length) throw bad('This session has no subagents yet. Name a harness (agent, and machine to run it elsewhere) in each task to create one.');
    const out = [];
    const claimed = new Set(); // copies handed a task in this call
    const busy = (name) => claimed.has(name) || this.live.has(lead.children?.[name]);
    for (const task of Array.isArray(tasks) ? tasks : []) {
      const want = String(task?.subagent || '').trim();
      const m = team.find((x) => x.name === want || copies(x).includes(want));
      const prompt = String(task?.prompt || '').trim();
      if (!m) {
        out.push({ subagent: want, error: `No subagent named "${want}". The team: ${team.map((x) => x.name).join(', ')}.` });
        continue;
      }
      if (!prompt) {
        out.push({ subagent: want, error: 'The task prompt is empty.' });
        continue;
      }
      // A member name goes to its first free copy; a copy name (codex#2) to that copy.
      const slot = (want === m.name ? copies(m) : [want]).find((n) => !busy(n));
      if (!slot) {
        out.push({ subagent: want, error: `${want} is still working${m.count > 1 && want === m.name ? ` (all ${m.count} copies)` : ''} on earlier tasks. Wait with subagent_results, then delegate again.` });
        continue;
      }
      claimed.add(slot);
      // A crew member: the crew starts a job for it, in its own folder, that the user sees. One of
      // the wisp that sent this task (upstream) is started by that wisp, through the relay below.
      if (m.crew && !m.upstream) {
        const job = await Promise.resolve(this.crewDelegate?.(lead, m, prompt) ?? { error: 'The crew is not available.' }).catch((err) => ({ error: err.message }));
        if (job.error) {
          out.push({ subagent: want, error: job.error });
          continue;
        }
        const d = { id: newId(), name: slot, member: m.name, crew: m.crew, agent: job.agent, model: job.model, effort: job.effort, ...(job.machine?.name && { place: job.machine.name }), sessionId: job.id, turnId: job.turns.at(-1).id, prompt, startedAt: Date.now() };
        (turn.delegations ||= []).push(d);
        out.push(d);
        continue;
      }
      let child = this.store.get(lead.children?.[slot]);
      // A member on another machine: the wisp that reaches it runs it there (services/relay.js).
      const relay = m.crew ? { machine: 'here', crew: m.crew, place: m.label || m.name, upstream: true } : m.machine ? { machine: m.machine, place: m.place || '', ...(m.upstream && { upstream: true }) } : null;
      if (relay && lead.capped) {
        out.push({ subagent: want, error: cappedRefusal('send work to another machine') });
        continue;
      }
      if (child && (relay || adapters[child.agent])) {
        child.cwd = workdir(lead); // follows the lead if its worktree moved
        child.mode = lead.mode; // and its mode, if a follow-up switched it
        if (lead.capped) child.capped = lead.capped; // and its cap, or that you lifted it
        else delete child.capped;
        if (relay) child.relay = relay; // the member may have moved between turns
        else delete child.relay;
        this.#startTurn(child, prompt);
      } else {
        // An Auto member is routed on its first task and keeps that pick, so later tasks resume it.
        // One on another machine is routed there, with the harnesses that machine has.
        const pick = m.agent === 'auto' && !relay ? this.routeAuto?.(prompt, { cwd: workdir(lead) }) : null;
        if (m.agent === 'auto' && !relay && !pick) {
          out.push({ subagent: want, error: 'Auto found no harness to run this on.' });
          continue;
        }
        const run = pick ? { agent: pick.agent, model: pick.model, effort: pick.effort || '', route: pick.route } : { agent: m.agent, model: m.model, effort: m.effort };
        child = this.create({ prompt, cwd: workdir(lead), ...run, mode: lead.mode, parentId: lead.id, member: slot, relay, capped: lead.capped });
        (lead.children ||= {})[slot] = child.id;
      }
      const d = { id: newId(), name: slot, member: m.name, agent: child.agent, model: child.model, effort: child.effort, ...(m.crew ? { crew: m.crew } : relay && { place: relay.place }), sessionId: child.id, turnId: child.turns.at(-1).id, prompt, startedAt: Date.now(), owed: true }; // owed until the lead has its report
      (turn.delegations ||= []).push(d);
      out.push(d);
    }
    const sent = out.filter((d) => !d.error);
    if (sent.length) this.#onEvent(lead, turn, { type: 'tool', kind: 'agent', label: `Delegated to ${[...new Set(sent.map((d) => d.name))].join(', ')}` });
    this.#touch(lead, { turn: turn.id });
    return out;
  }

  // A relayed member's live line (services/relay.js): what its run over there is doing.
  relayed(child, turn, { kind = 'agent', label }) {
    this.#onEvent(child, turn, { type: 'tool', kind: String(kind).slice(0, 20), label: String(label).slice(0, 200) });
  }

  // A relayed member's run ended over there: its report, edits (already applied to the lead's
  // folder when applied.applied) and what ran, as this turn's.
  relayDone(child, turn, { status, presentation, stats, changes = [], agent, model, effort, error, applied = {}, kept }) {
    if (turn.status !== 'running') return;
    if (agent && adapters[agent]) Object.assign(child, { agent, model: String(model || ''), effort: String(effort || '') });
    Object.assign(turn, { agent: child.agent, model: child.model, effort: child.effort || '' });
    turn.relay.state = 'done';
    if (applied.applied || kept) for (const c of Array.isArray(changes) ? changes.slice(0, 500) : []) if (c?.file) this.#onEvent(child, turn, { type: 'change', file: String(c.file), op: /^\w{1,12}$/.test(c.op || '') ? c.op : 'edit', edits: Array.isArray(c.edits) ? c.edits : [] });
    const place = child.relay?.place || 'the other machine';
    const note = error
      ? null
      : applied.conflicts?.length
        ? { type: 'callout', tone: 'warn', title: 'Applied with conflicts', text: `Its changes from ${place} clashed with edits made meanwhile. Conflict markers are left in: ${applied.conflicts.join(', ')}.` }
        : applied.error
          ? { type: 'callout', tone: 'danger', title: 'Changes not applied', text: `Its changes from ${place} didn’t apply to the lead’s folder (${applied.error}). The patch is saved at ${applied.file}.` }
          : kept
            ? { type: 'callout', tone: 'info', title: `Changes stayed on ${place}`, text: 'The folder isn’t a git repo, so its changes couldn’t be brought back.' }
            : null;
    const blocks = presentation?.blocks?.length
      ? [...presentation.blocks]
      : [{ type: 'hero', title: `${adapters[child.agent]?.name || 'This harness'} failed`, summary: firstLine(error) || 'The run on the other machine ended without a report.', status: 'blocked' }];
    if (note) blocks.splice(blocks[0]?.type === 'hero' ? 1 : 0, 0, note);
    turn.presentation = { ...(presentation || {}), blocks };
    turn.stats = stats || null;
    turn.endedAt = Date.now();
    turn.status = error ? 'error' : ['done', 'error', 'stopped'].includes(status) ? status : 'error';
    child.state = 'review';
    child.unread = false;
    this.store.save(child, { now: true });
    this.#touch(child, { turn: turn.id });
    this.#touchLead(child);
    this.#delegateDone(child, turn);
  }

  // Delegations by id (any turn), or the current turn's when ids is empty, with their child sessions.
  delegations(lead, ids = []) {
    const all = lead.turns.flatMap((t) => t.delegations || []);
    const list = ids.length ? all.filter((d) => ids.includes(d.id)) : lead.turns.at(-1)?.delegations || [];
    return list.map((d) => ({ d, child: this.store.get(d.sessionId) || this.crewChild(d.sessionId) }));
  }

  // A delegate's run ended. A lead still running collects the report itself (subagent_results, or
  // #reportBack when its turn ends); one whose turn already ended gets it as a follow-up now.
  // A stopped run owes nothing: the user stopped it, or the lead with it.
  #delegateDone(child, turn) {
    const lead = this.store.get(child.parentId);
    const d = lead?.turns.at(-1)?.delegations?.find((x) => x.owed && x.turnId === turn.id);
    if (!d) return;
    if (turn.status === 'stopped') delete d.owed;
    if (lead.turns.at(-1).status === 'running') return;
    if (turn.status !== 'stopped') this.#reportBack(lead);
    // The last one it waited on was stopped (you stopped it, or the lead with it): nothing comes
    // back, so the lead lands. You did it, so nobody is pinged. Its CLI may still linger after its
    // result (a slow machine's exit, or a Stop that hasn't landed yet): then it lands when that run
    // lets go (release() settles a handed one quietly), not never.
    else if (lead.state === 'running' && !lead.auto?.busy && lead.goal?.status !== 'checking' && !this.deleting.has(lead.id) && !this.#awaiting(lead).length) {
      if (this.live.has(lead.id)) this.handing.add(lead.id);
      else this.settle(lead, { quiet: true });
    }
  }

  // The lead's last turn's delegations still at work whose report it hasn't had. While there are
  // any, the lead isn't finished: it stays in Working and #reportBack starts its follow-up. One
  // whose session is gone (deleted), or whose turn says running with no run behind it, isn't waited on.
  #awaiting(lead) {
    if (lead.parentId) return [];
    return (lead.turns.at(-1)?.delegations || []).filter((d) => {
      if (!d.owed || this.deleting.has(d.sessionId)) return false;
      const child = this.store.get(d.sessionId);
      return child?.turns.find((t) => t.id === d.turnId)?.status === 'running' && (this.live.has(child.id) || !!child.relay);
    });
  }

  // Sends the lead the reports of its finished delegations that it hasn't read, as one follow-up
  // from wisp (merged into one still waiting in its queue). Returns whether it sent any.
  // ending: called from the lead's own #finishTurn, whose run lets go and starts the queue itself.
  #reportBack(lead, { ending = false } = {}) {
    if (this.deleting.has(lead.id)) return false;
    const done = (lead.turns.at(-1)?.delegations || []).filter((d) => d.owed && this.store.get(d.sessionId)?.turns.find((t) => t.id === d.turnId)?.status !== 'running');
    if (!done.length) return false;
    for (const d of done) delete d.owed;
    const reports = done.map((d) => delegationReport(d, this.store.get(d.sessionId), adapters)).join('\n\n---\n\n');
    const waiting = lead.queue.find((q) => q.reports);
    // Looked at before a follow-up starts here: that one is the run, not one lingering.
    const lingering = !ending && this.live.get(lead.id);
    if (waiting) waiting.text += `\n\n---\n\n${reports}`;
    else if (ending || lingering) lead.queue.push({ id: newId(), text: `${REPORTS_BACK}\n\n${reports}`, attachments: [], by: 'wisp', reports: true });
    else this.#startTurn(lead, `${REPORTS_BACK}\n\n${reports}`, [], { by: 'wisp', reports: true });
    // A CLI only lingering after its result: let it go so the follow-up starts now.
    if (lingering) lingering.release();
    this.#touch(lead);
    return true;
  }

  // A session's own fields changed outside a run (a crew job's follow-ups): save it and send its summary.
  refresh(session) {
    this.#touch(session);
  }

  // A crew job on another machine ended (server/crew.js): the lead that delegated it re-renders.
  touchLead(leadId, childId) {
    const lead = this.store.get(leadId);
    const turn = lead?.turns.findLast((t) => t.delegations?.some((d) => d.sessionId === childId));
    if (turn) this.#touch(lead, { turn: turn.id });
  }

  // A child's state changed: the lead's card shows it, so the lead's turn re-renders too.
  #touchLead(child) {
    const lead = (child.parentId || child.crew?.from?.id) && this.store.get(child.parentId || child.crew.from.id);
    if (!lead) return;
    const turn = lead.turns.findLast((t) => t.delegations?.some((d) => d.sessionId === child.id)) || lead.turns.at(-1);
    this.#touch(lead, { turn: turn?.id });
  }

  stop(session) {
    this.pipeline?.cancel(session);
    // A Stop during the goal's check: no run to stop, so the task lands here.
    if (!session.parentId && this.goals?.cancel(session, { stop: true }) && !this.live.has(session.id)) this.settle(session);
    // Your queued follow-ups stay, held: nothing goes out by itself after a Stop. The next message
    // you send (or Send now on one of them) carries the queue on.
    if (session.queue?.length) session.queueHeld = true;
    delete session.ask;
    for (const cid of Object.values(session.children || {})) {
      const child = this.store.get(cid);
      if (child) this.stop(child);
    }
    // A member on another machine: its turn ends here, and the relay stops the run over there.
    const last = session.turns.at(-1);
    if (session.relay && last?.status === 'running') this.#finishTurn(session, last, { stopped: true, text: '' });
    if (!this.live.has(session.id)) return;
    this.stopping.add(session.id);
    this.live.get(session.id).stop();
  }

  // Whether a run still works on the session. A CLI only lingering after its result (up to
  // LINGER_MS) is let go here: the task already shows as done, so Ship it and undo don't wait on it.
  working(session) {
    const handle = this.live.get(session.id);
    if (!handle) return false;
    if (session.turns.at(-1)?.status === 'running' || session.queue.length) return true;
    handle.release();
    return this.live.has(session.id);
  }

  // Stop the current run but keep the queue: done.finally() starts the next follow-up.
  #interrupt(session) {
    if (this.interrupting.has(session.id)) return; // already on its way down
    this.interrupting.add(session.id);
    this.stopping.add(session.id);
    this.live.get(session.id).stop();
  }

  // The record of a new turn, with the checkpoint taken before the agent touches anything.
  #newTurn(session, prompt, attachments, mode = session.mode) {
    const id = newId();
    // A subagent's edits land in the lead's turn, whose checkpoint already covers them.
    const checkpoint =
      session.agent === 'wisp' || session.parentId || session.sideOf
        ? null
        : !session.turns.length && session.worktree?.head
          ? freshCheckpoint(session.worktree)
          : captureCheckpoint(workdir(session), session.id, id);
    return {
      id,
      prompt,
      agent: session.agent,
      model: session.model,
      effort: session.effort || '',
      ...(session.account && { account: session.account }),
      mode,
      attachments: attachments.map(({ id, name, mime, size }) => ({ id, name, mime, size })),
      startedAt: Date.now(),
      endedAt: null,
      status: 'running',
      checkpoint,
      activity: [],
      changes: [],
      presentation: null,
      stats: null,
    };
  }

  // What a terminal session's CLI is told on top of its own prompt (services/tui.js): where it works,
  // and what wisp learned.
  terminalNote(session) {
    return workspaceNote(session) + this.promptExtra(session);
  }

  // The wisp protocol for this run: a lead hears about its team, a subagent that it can't ask.
  #systemPrompt(session, adapter, team) {
    const sub = session.parentId || session.delegated; // a delegate here, or one for a lead on another wisp
    const extraBlocks = sub ? [] : this.spellBlocks(session);
    const base = sub
      ? systemPrompt({ ask: SUBAGENT_ASK + (session.delegated ? AWAY_SUBAGENT : '') })
      : systemPrompt({ askTool: adapter.askTool, extraBlocks, apps: this.store.config?.defaults?.apps !== 'off', watch: this.store.config?.defaults?.watch !== 'off', blocks: !plainAnswer(session, this.store) }) + teamNote(team, adapters, delegateTool(adapter.askTool ?? 'mcp__wisp__ask_user'));
    const spell = session.kind === 'spell' ? spellGuide(adapter.askTool ?? 'mcp__wisp__ask_user') : session.kind === 'pane' ? paneGuide(adapter.askTool ?? 'mcp__wisp__ask_user') : '';
    const crew = session.crew ? this.crewNote(session) : '';
    // A shared task's skills and instructions came with it (services/share.js): written out in full.
    const kit = !sub && session.sharedFrom?.kit?.length ? kitNote({ kit: session.sharedFrom.kit }) : '';
    const side = session.sideOf ? sideNote(session, adapter.askTool === null || !this.bridge ? '' : (adapter.askTool ?? 'mcp__wisp__ask_user').replace(/ask_user$/, 'wisp_session'), { edits: this.sideMode(session.agent) === 'edits', name: adapter.name }) : '';
    return base + spell + crew + kit + side + goalNote(session) + workspaceNote(session) + this.promptExtra(session);
  }

  // wisp's own MCP server (ask_user, delegate), for harnesses that take one, and your connectors
  // (server/connectors.js). Subagents get only the connectors: they have nobody to ask.
  #mcpServers(session, adapter, team, mode) {
    if (adapter.askTool === null) return {};
    // A side discussion gets none: connectors can act on the world, and the gate only sees the folder.
    const yours = this.connectors?.({ agent: session.agent, mode: session.sideOf ? 'plan' : mode, cwd: workdir(session) }) || {};
    if (!this.bridge || session.parentId || session.delegated) return yours;
    return {
      ...yours,
      wisp: {
        command: process.execPath,
        args: [ASK_SERVER],
        env: {
          WISP_URL: this.bridge.url,
          WISP_TOKEN: sessionToken(this.bridge.token, session.id),
          WISP_SESSION: session.id,
          WISP_TURN: session.turns.at(-1)?.id || '', // so a run's leftover helper can tell its turn is over
          ...(adapter.approveTool && { WISP_APPROVE: '1' }),
          ...(session.kind === 'spell' && { WISP_SPELLS: '1' }),
          ...(session.capped && { WISP_CAPPED: '1' }), // the routes hold the cap; this only hides what they'd refuse
          ...(session.sideOf && { WISP_READONLY: '1' }), // a side discussion: wisp's tools that read, ask or show, plus the gate (server/side.js)
          ...(this.store.config?.defaults?.watch !== 'off' && { WISP_WATCH: '1' }),
          ...(team.length && { WISP_TEAM: JSON.stringify(team.map((m) => ({ name: m.name, agent: m.crew ? `${m.label || m.name} of the user's crew${m.role ? `, ${m.role}` : ''}` : adapters[m.agent]?.name || m.agent, model: m.crew ? 'own folder and memory' : m.model, effort: m.effort, use: m.use, count: m.count || 1, copies: copies(m), ...(m.machine && { place: m.place || 'another machine' }) }))) }),
        },
      },
    };
  }

  // spawn itself can throw (the system prompt and the roster go on the command line and in the
  // env, and the OS caps those): without this the turn would stay running with nothing behind it.
  #spawned(session, turn, team, start) {
    try {
      return start();
    } catch (err) {
      const big = err.code === 'E2BIG' || err.code === 'ENAMETOOLONG';
      const text = big ? `This run's instructions are too long for this computer to start it${team.length ? `: its team has ${team.length} delegates` : ''}. (${err.message})` : err.message;
      this.#finishTurn(session, turn, { isError: true, text });
      this.#touch(session);
      return null;
    }
  }

  // grants: harness rules allowing what the user approved, for this turn only. once: a mode for
  // this turn only (an approved retry the harness can't scope runs in Full auto).
  #startTurn(session, prompt, attachments = [], { grants = [], once, by, reports, later, goal, side } = {}) {
    if (!session.relay && this.#harnessHold(session, prompt, attachments, { grants, once, by, reports, later, goal, side })) return;
    // Project trust (server/project-trust.js): what this repo would run that you haven't trusted. The
    // task waits on a card listing it, unless you chose Run without them on it already. A subagent
    // or side discussion never waits: it runs without them (its lead was asked).
    // Full auto skips it: choosing it means don't ask me (it already skips every approval).
    if (session.sideOf) session.mode = this.sideMode(session.agent);
    const mode = MODES.has(once) && !session.sideOf ? once : session.mode;
    const project = session.relay ? null : this.projectPending(session, session.agent, mode);
    if (project && !session.parentId && !session.delegated && !session.sideOf && !project.items.every((x) => session.projectWithout?.includes(x.id))) {
      this.#holdTurn(session, prompt, attachments, { grants, once, by, reports, later, goal, side }, { agent: session.agent, project });
      return;
    }
    const turn = this.#newTurn(session, prompt, attachments, mode);
    if (session.relay) turn.relay = { state: 'pending' }; // until the relay picks it up
    if (by === 'wisp') turn.by = 'wisp'; // sent by wisp (Auto's repair round), not by you
    if (by === 'compact') turn.by = by;
    if (by === 'compact' && (session.state === 'done' || session.state === 'review')) turn.was = { state: session.state, unread: !!session.unread }; // it goes back there
    if (side) turn.side = side; // ...from that side discussion: what changed in the shared work
    if (project) turn.untrusted = true; // ran without the repo's hooks and servers
    if (by === 'wisp' && goal) turn.goal = goal; // ...going back to work on the goal: its round
    // A follow-up scheduled earlier (server/later.js): who set it and when. An agent's own wake-ups
    // count up until you say something, so it can't keep itself going for ever.
    if (by === 'later' && later) turn.later = later;
    if (turn.later?.by && turn.later.by !== 'user') session.laterChain = (session.laterChain || 0) + 1;
    else if (by !== 'wisp') delete session.laterChain;
    if (by !== 'compact') delete session.reminder; // a reminder on it is answered by carrying on
    if (reports) turn.reports = true; // ...with the reports of delegates that finished after the lead's turn
    // Side questions still being answered move to the new turn: the old one folds away on the card.
    const prev = session.turns.at(-1);
    // A crew member's follow-up brings its thread along, so its answer stays above what it asked for.
    const byCrew = /^@\[[^\]\n]{1,200}\]\(crew:[a-z0-9]{6,40}\)/.test(prompt);
    const open = prev?.btw?.filter((b) => b.status === 'running' || (byCrew && b.crew)) || [];
    if (open.length) {
      prev.btw = prev.btw.filter((b) => !open.includes(b));
      if (!prev.btw.length) delete prev.btw;
      turn.btw = open;
    }
    // Delegations whose report the lead hasn't had (a follow-up interrupted it) move too: the new
    // turn waits on them, subagent_results finds them, and their edits count on it.
    const owed = (!session.parentId && prev?.delegations?.filter((d) => d.owed)) || [];
    if (owed.length) {
      prev.delegations = prev.delegations.filter((d) => !d.owed);
      if (!prev.delegations.length) delete prev.delegations;
      turn.delegations = owed;
    }
    if (plainAnswer(session, this.store)) turn.plain = true;
    session.turns.push(turn);
    if (session.goal && !session.goal.from) session.goal.from = turn.id; // its changes are measured from here
    session.state = 'running';
    session.unread = false;
    if (by !== 'compact') delete session.archived;
    if (by !== 'compact') delete session.forLater; // new work: when it ends it lands in Needs you, not back in For later
    this.#touch(session, { turn: turn.id });
    this.#touchLead(session);
    this.emit('started', { session, turn });
    // A member on another machine runs over there: the relay carries it (services/relay.js).
    if (session.relay) {
      if (!session.relay.upstream) this.emit('relay', { session, turn });
      return;
    }

    // Where the plan went: this turn's part of the account's next move (server/budget.js).
    this.budget?.begin?.(session.agent, session.account || 'default', session.id, turn.id);
    let released = false;
    let linger;
    const adapter = adapters[session.agent];
    this.#watchHarness(session, turn, adapter);
    // Leads get the delegate tool next to ask_user; subagents get neither (nobody to ask).
    const team = adapter.askTool !== null && !session.delegated ? session.subagents || [] : [];
    // A harness that hasn't seen every earlier turn (the user switched to it) gets them first.
    // A harness whose conversations stay with the login counts another account's turns as missed.
    const perLogin = session.account && ACCOUNT_HOMES[session.agent]?.resumes === false;
    const mine = perLogin ? (t) => (t.agent || session.agent) === session.agent && (t.account || 'default') === session.account : undefined;
    const handoff = session.parentId ? '' : handoffNote(session, session.agent, session.agentSessionId, (t) => adapters[t.agent]?.name || t.agent, mine);
    // Mentioned tasks: a lead reads them with wisp_session; a run without wisp's tools gets their reports.
    const tools = !session.parentId && !session.delegated && adapter.askTool !== null && this.bridge;
    const text = agentPrompt(prompt, this.store, { tool: tools ? (adapter.askTool ?? 'mcp__wisp__ask_user').replace(/ask_user$/, 'wisp_session') : null, self: session.id, stuff: this.stuff });
    const still = owed.length && team.length && this.bridge ? stillWorkingNote(owed) : '';
    // A side discussion hears where its main task stands now, before each of your messages.
    const main = session.sideOf ? this.store.get(session.sideOf.id) || null : null;
    if (main) session.sideOf.cwd = workdir(main); // where the main task works now (it may have moved)
    const said = session.sideOf ? sidePrompt(main, text, (t) => adapters[t.agent || main?.agent]?.name || t.agent || main?.agent) : text;
    // Subagents on Haiku (Settings → Usage): Claude Code's subagents run on this model. A lead with a
    // team has no subagents of its own. The turn keeps it, so its receipt can say so.
    const delegating = team.length > 0 && !!this.bridge;
    const subagentModel = session.agent === 'claude' && !delegating ? (session.subagentModel ?? this.store.config?.defaults?.subagentModel) || '' : '';
    if (subagentModel) turn.run = { ...turn.run, subagentModel };
    const skills = session.agent === 'claude' && session.skills === 'off' ? 'off' : '';
    if (skills) turn.run = { ...turn.run, skills };
    const handle = this.#spawned(session, turn, team, () => adapter.run({
      // Anything in front of /compact stops it being a command.
      prompt: by === 'compact' ? prompt : [handoff, still, turn.later ? laterNote(turn.later) : '', said].filter(Boolean).join('\n\n'),
      attachments,
      cwd: workdir(session),
      dirs: [...alsoDirs((session.parentId && this.store.get(session.parentId)) || main || session), ...(session.crew ? this.crewDirs(session) : [])], // the task's other folders (a subagent's are its lead's), a crew job's skills
      resumeId: session.agentSessionId,
      prior: session.agentSessionId ? priorTotals(session) : null,
      unknownPrior: !!session.agentSessionId && !!session.worktree?.foreign && !priorTotals(session), // its chat ran elsewhere (adapters/claude.js countedFrom)
      mode,
      grants,
      model: session.model,
      effort: session.effort || '',
      systemPrompt: this.#systemPrompt(session, adapter, team),
      // A lead with a team delegates through wisp, so the harness's own subagent tool is switched off.
      delegating,
      subagentModel,
      skills,
      mcpServers: this.#mcpServers(session, adapter, team, mode),
      accountEnv: this.#accountEnv(session),
      // Every process the run starts inherits it, so it's still known as this task's once reparented (server/machine.js).
      runEnv: { WISP_TASK: session.id },
      untrusted: !!project,
      quiet: leanTask(session, this.store.config?.defaults), // only when asked: lean drops claude.ai connectors (server/lean.js)
      gate: !!session.sideOf && mode === 'edits', // every write waits on wisp (server/side-gate.js)
      capped: !!session.capped, // the harness keeps its shell off wisp's API (server/capped.js)
      probe: true,
      onEvent: (ev) => {
        // A lingering process we already let go of. A `cli` event is no process: a probe ends when it ends.
        // Nor is `billing` from the sign-in check (adapters/claude.js consoleProfile), which can outlast a quick turn.
        if (released && ev.type !== 'cli' && ev.type !== 'billing') return;
        const waiting = this.#onEvent(session, turn, ev) === 'waiting';
        // A CLI can outlive its result (flushing, or a background process it spawned holding
        // stdout open, so 'close' never fires). Don't hold the session hostage to that. A result
        // that left background tasks running gets up to BACKGROUND_MAX_MS for its next one.
        if (ev.type === 'result') {
          clearTimeout(linger);
          linger = setTimeout(release, waiting ? BACKGROUND_MAX_MS : LINGER_MS);
        }
      },
    }));
    if (!handle) return;
    // Ends the run exactly once: on exit, LINGER_MS after the result, or when a follow-up arrives.
    const release = () => {
      if (released) return;
      // Gone while waiting on background work (stopped, interrupted, or it died): the result it
      // gave before waiting is the best we have.
      if (turn.status === 'running') this.#finishTurn(session, turn, turn.interim || { isError: true, text: 'The agent exited without a result.' });
      released = true;
      clearTimeout(linger);
      handle.stop();
      if (this.live.get(session.id) !== handle) return;
      this.live.delete(session.id);
      this.interrupting.delete(session.id);
      this.stopping.delete(session.id); // a stop that landed after the result has nothing left to stop
      const next = session.queueHeld ? null : session.queue.shift();
      const handed = this.handing.delete(session.id);
      if (next && this.store.get(session.id)) this.#startQueued(session, next);
      // Kept in Working for a follow-up that was then taken back or stopped: it lands in your queue after all.
      else if (handed) this.settle(session, { quiet: true });
      else this.#touch(session);
    };
    handle.release = release;
    this.live.set(session.id, handle);
    handle.done.finally(release);
  }

  // Would a run of this task start held, on the changed harness's or the repo's card? Compact now
  // doesn't: it's refused instead (its own card would only stand in the way of a one-click action).
  startsHeld(session) {
    const w = this.harnessWatch;
    const bin = adapters[session.agent]?.bin?.();
    if (w && bin && this.store.config?.defaults?.harnessAsk === 'on' && w.suspect(session.agent, bin)) return true;
    const project = session.relay ? null : this.projectPending(session);
    return !!project && !project.items.every((x) => session.projectWithout?.includes(x.id));
  }

  // Project trust (server/project-trust.js): what a run of this task would run from its repo (Claude
  // Code's hooks and MCP servers, a new worktree's held setup) that isn't trusted, or null. Always
  // null in Full auto (mode: the run's): it runs them as it would with no trust check at all.
  projectPending(session, agent = session.agent, mode = session.mode) {
    const pt = this.projectTrust;
    if (!pt || !projectAsks(this.store.config?.defaults, mode)) return null;
    const held = [session, ...(session.also || [])].flatMap((x) => x.worktree?.prepared?.held || []);
    try {
      return pt.pending(workdir(session), agent, held);
    } catch {
      return null;
    }
  }

  // Harness watch (server/harness-watch.js): the program this run starts is looked at, and when it
  // isn't the one pinned, the turn carries the change ({ kind: update | warn, from, to, at }) so
  // the task says so, with Trust this version. Never in the way of the run.
  #watchHarness(session, turn, adapter) {
    const w = this.harnessWatch;
    const bin = adapter?.bin?.();
    if (!w || !bin) return;
    const known = w.change(session.agent);
    if (known) turn.harness = known;
    w.observe(session.agent, bin, detectedVersion(session.agent))
      .then((c) => {
        if (!c === !turn.harness && (!c || c.at === turn.harness.at)) return;
        if (c) turn.harness = c;
        else delete turn.harness;
        this.#touch(session);
      })
      .catch(() => {});
  }

  // Ask before running a changed harness (defaults.harnessAsk, off by default): a run whose program
  // may not be the pinned one is held before it starts (#holdTurn). Once it's hashed, one that was
  // only touched goes by itself; a changed one waits for Trust and start (POST /sessions/:id/held).
  #harnessHold(session, prompt, attachments, opts) {
    const w = this.harnessWatch;
    if (!w || this.store.config?.defaults?.harnessAsk !== 'on') return false;
    const bin = adapters[session.agent]?.bin?.();
    if (!bin || !w.suspect(session.agent, bin)) return false;
    this.#holdTurn(session, prompt, attachments, opts, { agent: session.agent, harness: w.change(session.agent) || { checking: true } });
    w.observe(session.agent, bin, detectedVersion(session.agent))
      .then((c) => {
        const t = session.turns.at(-1);
        if (t?.status !== 'held' || !t.held?.harness || !this.store.get(session.id)) return;
        if (!c) return this.release(session);
        t.held.harness = c;
        this.#touch(session);
      })
      .catch(() => {});
    return true;
  }

  #onEvent(session, turn, ev) {
    switch (ev.type) {
      case 'session':
        session.agentSessionId = ev.id;
        (session.agentSessions ||= {})[session.agent] = ev.id;
        return;
      case 'tool':
      case 'tool_error':
      case 'text': {
        if (ev.type === 'tool_error' && ev.id && session.sideOf) this.sideGate.toolDone(session, turn, ev.id, true).catch(() => {});
        // A failed call is over too: left open, a Task keeps *No output for 12 min* away for the whole turn.
        const failed = ev.type === 'tool_error' && stepOutput(turn.activity, { id: ev.id, text: '' });
        if (failed) this.emit('activity', { sessionId: session.id, turnId: turn.id, item: failed, update: true });
        const item = stepOf(ev);
        turn.activity.push(item);
        // The transcript says how many of the oldest steps it no longer has.
        if (turn.activity.length > MAX_ACTIVITY) turn.trimmed = (turn.trimmed || 0) + turn.activity.splice(0, turn.activity.length - MAX_ACTIVITY).length;
        this.emit('activity', { sessionId: session.id, turnId: turn.id, item });
        this.#touch(session, { quiet: ev.type === 'text' });
        return;
      }
      case 'tool_output': {
        if (ev.id && session.sideOf) this.sideGate.toolDone(session, turn, ev.id, false).catch(() => {});
        // What a call returned, for the transcript.
        const item = stepOutput(turn.activity, ev);
        if (!item) return;
        this.emit('activity', { sessionId: session.id, turnId: turn.id, item, update: true });
        this.store.save(session);
        return;
      }
      case 'change': {
        // A harness that reports an edit before it's allowed: on a side discussion the gate records it.
        if (ev.early && session.sideOf) return;
        let entry = turn.changes.find((c) => c.file === ev.file);
        if (!entry) {
          let beforeFile = ev.beforeFile;
          if (turn.checkpoint?.commit && !path.isAbsolute(ev.file)) {
            const fromGit = readGitFile(workdir(session), turn.checkpoint.commit, ev.file);
            if (fromGit !== null) beforeFile = fromGit;
            else if (!(turn.checkpoint.untracked || []).includes(ev.file)) beforeFile = null;
          }
          turn.changes.push((entry = { file: ev.file, op: ev.op, ...(beforeFile !== undefined ? { beforeFile } : {}), edits: [] }));
        }
        if (ev.op === 'create' && entry.edits.length === 0) entry.op = 'create';
        delete entry.reverted;
        const from = entry.edits.length;
        entry.edits.push(...ev.edits);
        // The transcript shows each edit under the call that made it: [from, to) in entry.edits.
        const call = !ev.by && turn.activity.findLast((a) => a.kind === 'edit' && a.file === ev.file);
        if (call) call.edits = [call.edits?.[0] ?? from, entry.edits.length];
        if (ev.by && !entry.by?.includes(ev.by)) (entry.by ||= []).push(ev.by);
        this.store.save(session);
        // A subagent's edits are the lead's too: they show up in its files, diffs and Ship it.
        const lead = session.parentId && this.store.get(session.parentId);
        const leadTurn = lead?.turns.at(-1);
        if (leadTurn?.status === 'running') this.#onEvent(lead, leadTurn, { ...ev, by: session.member });
        return;
      }
      case 'blocked': {
        // A side discussion: what was refused was the gate's or the card's answer, or its harness only
        // reads. A note at most, never something to allow and retry.
        if (session.sideOf) {
          if (session.mode === 'plan') turn.activity.push({ t: Date.now(), kind: 'answer', label: `Refused (side discussions on ${adapters[session.agent]?.name || session.agent} only read): ${clip(String(ev.detail || ev.tool || 'a change'), 120)}` });
          this.store.save(session);
          return;
        }
        // A tool call the harness's permissions refused. The card after the turn offers to retry it.
        const item = { tool: String(ev.tool || 'tool'), detail: String(ev.detail ?? ''), ...(ev.rule !== undefined && { rule: ev.rule }) };
        const list = (turn.blocked ||= []);
        if (!list.some((b) => sameAction(b, item))) list.push(item);
        this.store.save(session);
        return;
      }
      case 'limits': {
        // How much of this account's usage windows is gone (server/budget.js), and whether this run
        // is billed past the plan (extra usage, Codex credits): Past your plan on the turn.
        const past = this.budget?.record?.(session.agent, session.account || 'default', ev);
        if (past) this.#pastPlan(session, turn, past);
        return;
      }
      case 'billing':
        // Billed to an API key instead of the plan (Claude Code's apiKeySource), or to a Console
        // profile (`claude auth status`, which can answer after the turn ended).
        if (ev.kind) this.#pastPlan(session, turn, ev.kind);
        return;
      case 'tools': {
        // The run's tool list (details.tools), for the account comparison. The list is stored once per
        // task; later turns with the same tools keep only the hash.
        const seen = session.turns.filter((t) => t !== turn && t.details?.tools?.list).map((t) => t.details.tools.hash);
        (turn.details ||= {}).tools = toolSet(ev.list, seen);
        this.store?.save?.(session);
        return;
      }
      case 'cli': {
        const said = { ...(ev.version && { version: String(ev.version) }), ...(ev.catalog && { catalog: String(ev.catalog) }), ...(ev.models && { models: ev.models }) };
        if (turn.status === 'running') cliSeen.set(turn, { ...cliSeen.get(turn), ...said });
        // Its probe outran a fast turn. A turn with no stats stays that way: readers go by t.stats.
        else if (turn.stats) {
          turn.stats.cli = { ...turn.stats.cli, ...said };
          this.store?.save?.(session);
          if (!this.deleting.has(session.id)) this.emit('turn', { sessionId: session.id, turnId: turn.id });
        }
        return;
      }
      case 'background': {
        turn.background = ev.tasks;
        if (turn.interim) this.#waitItem(session, turn);
        else this.store.save(session);
        return;
      }
      case 'result':
        // It ended its turn in plain text with background tasks still running ("I'll report once
        // it's done"): the CLI wakes it up when they finish and it reports again, so the turn stays
        // open. A full presentation is a finished task that left something up (a dev server).
        // Toward a goal, a subagent still at work means it isn't done either, whatever it said:
        // the goal is checked on the report that follows, not on this one.
        const subagents = ev.backgroundAgents > 0 && session.goal?.status === 'working' && !session.parentId && !session.delegated;
        if (ev.background > 0 && !ev.isError && (subagents || (!turn.plain && parsePresentation(ev.text).fallback))) {
          turn.interim = { text: ev.text, stats: ev.stats };
          this.#waitItem(session, turn);
          return 'waiting';
        }
        this.#finishTurn(session, turn, ev);
        return;
    }
  }

  // What the CLI was this turn: stats.cli (web/js/what-changed.js; each key only when known). A
  // harness that reports it never gets detect's version: a stale one beside its own would read as a move.
  #keepCli(session, turn) {
    const agent = turn.agent || session.agent;
    const { version = adapters[agent]?.reportsCli ? '' : versionIn(detectedVersion(agent)), catalog, models } = cliSeen.get(turn) || {};
    const tools = turn.details?.tools?.hash;
    const account = turn.account || session.account;
    const cli = { ...(version && { version }), ...(tools && { tools }), ...(catalog && { catalog }), ...(models && { models }), ...(account && { account }) };
    if (Object.keys(cli).length) turn.stats.cli = cli;
  }

  // The live line while a turn waits on its background tasks.
  #waitItem(session, turn) {
    const tasks = turn.background || [];
    const label = !tasks.length
      ? 'Background work finished, wrapping up'
      : tasks.length === 1
        ? `Waiting on background task: ${tasks[0]}`
        : `Waiting on ${tasks.length} background tasks`;
    this.#onEvent(session, turn, { type: 'tool', kind: 'background', label: label.slice(0, 200) });
  }

  // reason: why it stopped, a summary or { title, summary, blocks } (restartReason).
  #finishTurn(session, turn, ev, reason) {
    const why = typeof reason === 'object' && reason ? reason : { summary: reason };
    let crewOut = {};
    turn.endedAt = Date.now();
    this.budget?.end?.(session.agent, session.account || 'default', session.id, turn.id);
    delete turn.interim;
    delete turn.background;
    turn.stats = ev.stats || null;
    if (turn.stats) this.#keepCli(session, turn);
    this.guard?.changed?.(turn.agent || session.agent); // its cost counts in the next estimate
    this.budget?.spend?.(turn.agent || session.agent, session.account || 'default', unitsOf(turn.stats), { failed: !!ev.isError && !ev.stopped });
    if (session.sideOf) this.sideGate.turnEnded(session, turn);
    delete session.ask;
    if (this.stopping.delete(session.id)) ev = { ...ev, stopped: true };
    const interrupted = ev.stopped && this.interrupting.has(session.id);
    if (ev.stopped) {
      turn.status = 'stopped';
      turn.presentation = {
        blocks: [
          interrupted
            ? { type: 'hero', title: 'Interrupted', summary: 'You sent a follow-up while this was running, so it picked that up instead.', status: 'partial' }
            : { type: 'hero', title: why.title || 'Stopped', summary: why.summary || 'You stopped this run. Follow up to pick it back up.', status: 'partial' },
          ...(turn.changes.length ? [{ type: 'files', items: turn.changes.map((c) => ({ path: c.file, change: c.op === 'create' ? 'added' : 'modified' })) }] : []),
          ...(interrupted ? [] : why.blocks || []),
        ],
      };
    } else if (ev.isError) {
      turn.status = 'error';
      turn.presentation = {
        blocks: [
          { type: 'hero', title: `${adapters[session.agent]?.name || 'This harness'} failed`, summary: firstLine(ev.text) || 'It ended without saying why.', status: 'blocked' },
          { type: 'terminal', output: ev.text || 'No output.', exitCode: 1 },
          { type: 'next', items: ['Try again', 'Explain what went wrong'] },
        ],
      };
    } else {
      turn.status = 'done';
      turn.raw = ev.text; // kept so the turn can be re-parsed if the parser improves
      turn.presentation = parsePresentation(ev.text);
      if (turn.plain || turn.stats?.compact) delete turn.presentation.fallback; // asked for plain text (wisp blocks off), or no answer at all: not a slip
      if (session.crew && turn.by !== 'compact') crewOut = this.crewTurn(session, turn) || {}; // its memory comes out of the report
      this.store.keepImages(session, turn);
      this.store.keepDocs?.(session, turn);
      this.store.keepTasks?.(turn);
      this.#keepStuff(session, turn);
      const hero = heroOf(turn.presentation);
      // The first answer names the task after what was asked (its hero's topic), never after what the
      // agent did (its title): with no topic the prompt's first line stays. A quick answer has no
      // hero: its wisp block's (or crew block's) topic names it (presentation.topic). Compare runs
      // keep the prompt's title: they're one task, and one run's answer shouldn't name it.
      const named = [hero?.topic, turn.presentation.topic].find((t) => typeof t === 'string' && t.trim());
      const topic = named ? clip(named, 64) : '';
      if (topic && session.titleAuto && session.turns.length === 1 && !session.groupId) session.title = topic;
    }
    if (!ev.stopped) blockedCard(turn);
    // A usage limit: the turn asks you what next (or waits for the reset, below).
    if (ev.isError && !ev.stopped) this.#atLimit(session, turn, ev);
    // Turned down: the turn offers to hand the same prompt to another of your harnesses.
    if (!ev.stopped && ev.isError && !turn.limit && !turn.devices) this.#signedOut(session, turn, ev);
    if (!ev.stopped && !turn.limit && !turn.signedOut) this.#refused(session, turn, ev);
    // A lead that ends its turn without reading what its delegates finished gets it as a follow-up.
    if (!ev.stopped && !session.parentId) this.#reportBack(session, { ending: true });
    // Auto checks the work before it reaches you: the session stays in Working meanwhile.
    // A follow-up starts as soon as this run lets go: stay in Working rather than flash through Needs you.
    const handing = this.live.has(session.id) && (interrupted || (session.queue.length > 0 && !session.queueHeld));
    if (handing) this.handing.add(session.id);
    // Delegates it sent off (wait: false) still at work: the lead isn't finished. It stays in
    // Working, unread and unannounced, until their report comes back and that follow-up ends.
    const owes = !ev.stopped && !handing && this.#awaiting(session).length > 0;
    const compact = turn.by === 'compact';
    const checks = !handing && !owes && !compact && !!this.pipeline?.wants(session, turn, ev);
    // No Auto step: the goal (if any) is checked now. With one, Auto's settle() hands over to it.
    const goal = !handing && !owes && !checks && !compact && !!this.goals?.wants(session, turn, ev);
    const holding = checks || goal || owes;
    session.state = holding || handing ? 'running' : 'review';
    session.unread = !holding && !handing;
    // At a usage limit with Wait for the reset on (and Auto not moving it elsewhere): the task waits
    // under Scheduled and carries on in the same conversation after the reset. Nobody is pinged.
    const waits = !!turn.limit && !holding && !handing && !!this.waitAtLimit?.(session, turn.limit.until);
    if (waits) this.#waitsForReset(session, turn);
    // A crew check-in that found nothing (archived too), or a delegated job (its lead reads the
    // answer): filed under Done, nobody is pinged.
    // A compaction is housekeeping: the task goes back to where it was and nobody is pinged. One
    // that failed or was stopped shows like any run, also from Archived or For later.
    const back = (compact && turn.status === 'done' && !handing && turn.was) || null;
    delete turn.was;
    if (compact && !back) {
      delete session.archived;
      delete session.forLater;
    }
    const quiet = ((crewOut.quiet || crewOut.filed) && !holding && !handing) || waits || !!back;
    // A quiet check-in that scheduled a follow-up (resume_later) is filed under Done, not archived:
    // Later lets what an archived task scheduled lapse, so it would never come back.
    if (quiet) Object.assign(session, { state: 'done', unread: false, ...(crewOut.quiet && !session.later?.length && { archived: true }) }, back);
    if (crewOut.quiet && !holding && !handing) turn.quiet = true; // for the member's track record (usage.js crewStats)
    // A crew report worth reading but not urgent: filed in For later, unread, and nobody is pinged.
    const parked = !!crewOut.later && !quiet && !holding && !handing && !crewOut.filed;
    if (parked) session.forLater = { at: Date.now(), by: 'crew' };
    this.store.save(session, { now: true });
    this.#touch(session, { turn: turn.id });
    this.emit('ended', { session, turn, interrupted, errorText: ev.isError && !ev.stopped ? ev.text : '' });
    this.#touchLead(session);
    if (session.parentId) this.#delegateDone(session, turn);
    if (checks || goal) setImmediate(() => (checks ? this.pipeline.run(session, turn) : this.goals.run(session, turn)));
    // The follow-up starts right away; don't notify for the run it replaced. A subagent reports
    // to its lead, not to the user.
    else if (!holding && !handing && !quiet && !parked && !session.parentId && !session.delegated && !this.deleting.has(session.id)) this.emit('finished', { session: summarize(session, this.store) });
  }

  // The run hit its account's usage limit: that account is marked until its reset, and the turn
  // asks you what next (turn.limit: wait for the reset, continue on another of your accounts, hand
  // it to another harness, or the provider's extra usage). wisp never moves to another account by
  // itself: the providers' terms forbid getting around their limits (design/accounts.md).
  // The reset time comes from what the CLI last said about the account's windows (server/budget.js)
  // when it knows, else from the error's text.
  #atLimit(session, turn, ev) {
    const limit = infraError(ev.text);
    if (limit?.scope !== 'agent' || session.parentId || session.delegated) return;
    if (limit.kind === 'device') return this.#deviceLimit(session, turn, ev);
    const accounts = this.accounts;
    const multi = !!session.account && !!accounts?.multi?.(session.agent);
    const reset = this.budget?.resetAt?.(session.agent, session.account || 'default');
    const ms = reset ? reset - Date.now() : limit.ms;
    if (multi) accounts.cool(session.agent, session.account, { ms, why: clip(String(ev.text || '').split('\n').find((l) => l.trim()) || '', 160) });
    const from = multi ? accounts.get(session.agent, session.account) : null;
    const others = multi ? accounts.list(session.agent).filter((a) => a.id !== session.account && a.state === 'ready').map(({ id, label, kind }) => ({ id, label, kind })) : [];
    turn.limit = {
      account: session.account || '',
      until: reset || from?.until || Date.now() + limit.ms,
      others,
      kind: from?.kind || 'personal',
      extra: ACCOUNT_HOMES[session.agent]?.extra || '',
    };
    turn.presentation = {
      blocks: [
        // No time here: the card under it says when, in the page's own time format.
        { type: 'hero', title: `${from?.label || adapters[session.agent]?.name || 'This harness'} is at its usage limit`, summary: others.length ? 'Wait for the reset, continue on another of your accounts, or hand the task to another agent.' : 'Wait for the reset, or hand the task to another agent.', status: 'blocked' },
        { type: 'terminal', output: ev.text || 'No output.', exitCode: 1 },
      ],
    };
  }

  // Its harness is signed out (server/agent-login.js signedOutBy): the hero says so and the card
  // under it (turn.signedOut) signs in where you are. Nothing waits or pauses: Auto leaves it alone
  // (pipeline.js wants) and a crew or scheduled job gets the same card. wisp never moves it to
  // another account by itself; `others` are the accounts the card offers. `scope` stays '' here: a
  // session on a machine lives on that machine's wisp, and the page knows which one it's on.
  // A subagent's failure goes to its lead as it is.
  #signedOut(session, turn, ev) {
    if (session.parentId || session.relay) return;
    const agent = turn.agent || session.agent;
    if (!ev.authFailed && !signedOutBy(agent, ev.text)) return;
    const account = turn.account || session.account || '';
    const multi = !!this.accounts?.multi?.(agent);
    const others = multi ? this.accounts.list(agent).filter((a) => a.id !== (account || 'default') && a.state === 'ready').map(({ id, label, kind }) => ({ id, label, kind })) : [];
    const oldCli = agent === 'claude' && before(turn.stats?.cli?.version || versionIn(detectedVersion(agent)), CLAUDE_SAFE_SIGN_IN);
    turn.signedOut = { agent, account, scope: '', others, ...(oldCli && { oldCli }) };
    const how = KEY_LOGINS[agent] ? 'Add your API key' : 'Sign in';
    turn.presentation = {
      blocks: [
        { type: 'hero', title: `${adapters[agent]?.name || 'This harness'} is signed out`, summary: this.#rerunsItself(session, turn) ? `${how} and wisp sends your request again, in this same conversation.` : `${how}, then Try again.`, status: 'blocked' },
        { type: 'terminal', output: ev.text || 'No output.', exitCode: 1 },
      ],
    };
    this.#askCli(session, turn, agent, account);
  }

  // The words alone can be wrong: Codex answers 401 in an outage while signed in (openai/codex#48237),
  // and a Claude refresh race fails a run on a good login. So the CLI is asked, once, beside the
  // turn's end: signed in, and the hero stops asking for a sign-in. No answer changes nothing.
  async #askCli(session, turn, agent, account) {
    try {
      const said = await this.authStatus?.(agent, account);
      if (said?.signedIn !== true || this.store.get(session.id) !== session || session.turns.at(-1) !== turn || !turn.signedOut || turn.signedOut.rerun) return;
      turn.signedOut.stillIn = true;
      const name = adapters[agent]?.name || 'This harness';
      const hero = agent === 'codex' ? { title: `${name} is refusing requests`, summary: 'It says it’s signed in, but the service answered 401, so signing in again is unlikely to help. Try again in a while.' } : { title: `${name} couldn’t use its sign-in`, summary: 'It says it’s signed in now, so this may have been a hiccup. Try again.' };
      turn.presentation.blocks = turn.presentation.blocks.map((b) => (b.type === 'hero' ? { ...b, ...hero } : b));
      this.store?.save?.(session);
      this.#touch(session, { turn: turn.id });
    } catch {}
  }

  // Whether signing in sends this turn's request again by itself: only what you asked for, as you
  // asked it (or a follow-up you scheduled). Anything else gets Try again.
  #rerunsItself(session, turn) {
    return !session.parentId && !session.delegated && !session.sideOf && !session.tui && !turn.plain && (!turn.by || turn.by === 'later');
  }

  // Sign in on a turn's card: this login or key, when it lands, sends the request again. In memory
  // on purpose: a login flow doesn't survive a restart either. Keyed on the turn, so two tabs arm one.
  armSignIn(session, turnId) {
    const turn = session.turns.at(-1);
    if (turn?.id !== turnId || !turn.signedOut || turn.signedOut.rerun || !this.#rerunsItself(session, turn)) return false;
    const { agent, account } = turn.signedOut;
    this.signIns.set(turnId, { sessionId: session.id, agent, account: signInAccount(account), until: Date.now() + SIGN_IN_MS });
    return true;
  }

  // That login was cancelled or failed.
  disarmSignIn(agent, account) {
    const acc = signInAccount(account);
    for (const [id, x] of this.signIns) if (x.agent === agent && x.account === acc) this.signIns.delete(id);
  }

  // A login or key finished here. Only armed turns run: a sign-in from Settings or a terminal leaves
  // the card saying Signed in with Try again. skip(session): it can't run now (open in a terminal).
  async signInDone(agent, account, { skip } = {}) {
    const acc = signInAccount(account);
    for (const [id, x] of [...this.signIns]) {
      if (x.until < Date.now()) this.signIns.delete(id);
      if (x.agent !== agent || x.account !== acc || !this.signIns.delete(id)) continue;
      const session = this.store?.get?.(x.sessionId);
      // Filed meanwhile (marked done, archived): it moved on, the card stays for when you're back.
      if (!session || session.archived || session.state === 'done' || skip?.(session)) continue;
      await this.rerunSignedOut(session, id).catch((err) => console.warn(`wisp: rerun after sign-in: ${err.message}`));
    }
  }

  // The failed request again, in the same conversation: Sign in's rerun, Try again, or Continue on
  // <account> from the card. turn.signedOut.rerun is what makes it once: saved before anything is
  // sent, it holds across two tabs, a phone, a refresh, a replayed event and a restart.
  async rerunSignedOut(session, turnId, { account } = {}) {
    const turn = session.turns.at(-1);
    // An error as the latest turn means no run is going; a CLI lingering after it is let go by reply().
    const can = () => session.turns.at(-1) === turn && session.state !== 'running' && !session.queue.length;
    if (turn?.id !== turnId || !turn.signedOut || turn.signedOut.rerun || turn.status !== 'error' || !can()) return { rerun: false };
    turn.signedOut.rerun = Date.now();
    this.store?.save?.(session, { now: true });
    try {
      await this.readyToRun?.(session); // an idle task's worktree may have gone meanwhile
      if (!can()) return { rerun: false };
      const run = account ? { account } : undefined;
      // Turns keep an upload's id and name, a run needs its file.
      const files = turn.attachments?.length ? (this.uploads?.resolve?.(turn.attachments.map((a) => a.id)) ?? turn.attachments) : [];
      const hold = session.parentId || session.delegated ? null : this.guard?.check?.({ agent: session.agent, account: account ?? session.account, kind: 'followUp', session });
      this.reply(session, turn.prompt, files, { hold, run });
      return { rerun: true };
    } catch (err) {
      delete turn.signedOut.rerun; // it never went: the card offers it again
      this.store?.save?.(session, { now: true });
      throw err;
    }
  }

  // The harness turned the task down (server/refusal.js): the hero says so, and the card under it
  // (turn.refusal) offers Hand to <another harness> with the same prompt and this task's turns
  // (handoff.js). Never by itself, and never another account of the same harness or another harness on the same vendor's model: that would be
  // asking the same model the same question again. A subagent's or a delegated job's
  // refusal goes to its lead as it is.
  #refused(session, turn, ev) {
    if (session.parentId || session.delegated || turn.plain) return;
    const r = refusalOf({ text: ev.text, stopReason: ev.stopReason, isError: !!ev.isError, changes: turn.changes?.length || 0 });
    if (!r) return;
    const agent = turn.agent || session.agent;
    const name = adapters[agent]?.name || 'This harness';
    // Whose model refused (web/js/vendors.js): the card only offers another vendor's.
    const model = String(turn.model ?? session.model ?? '');
    const vendor = vendorOf(model, agent);
    turn.refusal = { agent, model, ...(vendor && { vendor }), kind: r.kind, ...(r.line && { line: r.line }) };
    const rest = (turn.presentation?.blocks || []).filter((b) => b.type !== 'hero' && b.type !== 'next');
    turn.presentation = {
      blocks: [
        { type: 'hero', title: `${name} turned this task down`, summary: 'Hand the same prompt, with what this task has seen, to another agent, or rephrase it and follow up.', status: 'blocked' },
        ...(rest.length ? rest : [{ type: 'markdown', text: ev.text || 'No answer.' }]),
      ],
    };
  }

  // A run billed past its plan (turn.overage: 'extra' usage, Codex 'credits', an 'api' key, a Console 'profile'): the
  // turn's receipt says so, and Plan budget counts it for the week (server/budget.js overage()).
  #pastPlan(session, turn, kind) {
    if (!turn || turn.overage) return;
    turn.overage = { kind, at: Date.now() };
    this.budget?.overage?.(session.agent, session.account || 'default', kind, session.id, turn.id);
    this.store.save(session);
    if (turn.status !== 'running' && !this.deleting.has(session.id)) this.emit('turn', { sessionId: session.id, turnId: turn.id }); // landed after it ended
  }

  // Refused because too many devices or sessions are signed in on the account (Codex): no window to
  // wait out and nothing another account should get around, so no limit card, just what happened
  // and what to do. The account isn't marked: it has room the moment one sign-in goes.
  #deviceLimit(session, turn, ev) {
    const name = adapters[session.agent]?.name || 'This harness';
    turn.devices = true;
    turn.presentation = {
      blocks: [
        { type: 'hero', title: `${name} refused: too many devices signed in`, summary: `Your ${name} account has as many devices or sessions open as its plan allows, so it turned this run down. Your usage isn’t used up.`, status: 'blocked' },
        { type: 'checklist', title: 'What you can do', items: [{ text: `Close ${name} on another computer, in your editor or in its app, or sign out there`, done: false }, { text: 'Then Rerun this task, or hand it to another agent', done: false }] },
        { type: 'terminal', output: ev.text || 'No output.', exitCode: 1 },
      ],
    };
  }

  // Wait for the reset is on and wisp scheduled the carry-on: the hero says so instead of asking.
  #waitsForReset(session, turn) {
    const hero = turn.presentation?.blocks?.find((b) => b.type === 'hero');
    if (hero) Object.assign(hero, { summary: 'It carries on by itself after the reset, in this same conversation.', status: 'partial' });
    turn.limit.waiting = true;
  }

  // Auto is done with a session it held: it lands in your queue (quiet: handed to another run,
  // which will be the one to notify).
  // A goal still being worked on takes over first: it's checked before the task lands.
  settle(session, { quiet = false } = {}) {
    if (session.state !== 'running' || (this.live.has(session.id) && session.turns.at(-1)?.status === 'running')) return this.#touch(session);
    const last = session.turns.at(-1);
    if (!quiet && last && this.goals?.wants(session, last, { stopped: last.status === 'stopped', isError: last.status === 'error' })) {
      this.#touch(session);
      return void setImmediate(() => this.goals.run(session, last));
    }
    session.state = 'review';
    session.unread = !quiet;
    this.store.save(session, { now: true });
    this.#touch(session, { turn: session.turns.at(-1)?.id });
    if (!quiet && !session.parentId && !session.delegated && !this.deleting.has(session.id)) this.emit('finished', { session: summarize(session, this.store) });
  }

  // A line in a turn's activity from wisp itself (Auto's check, repair, hand-over).
  note(session, turn, { kind = 'check', label }) {
    const item = { t: Date.now(), kind, label: String(label).slice(0, 300), by: 'wisp' };
    turn.activity.push(item);
    this.emit('activity', { sessionId: session.id, turnId: turn.id, item });
    this.#touch(session, { turn: turn.id });
  }

  #touch(session, { turn, quiet } = {}) {
    if (this.deleting.has(session.id)) return; // going away: a last summary would bring its card back
    session.updatedAt = Date.now();
    this.store.save(session);
    if (!quiet) this.emit('summary', summarize(session, this.store));
    if (turn) this.emit('turn', { sessionId: session.id, turnId: turn });
  }
}

// What the turn's permissions refused, as one "blocked" block after the hero: the harness's own
// reports (which can carry a rule to allow exactly that) merged with the agent's "blocked" block,
// minus anything the user already denied. turn.blocked keeps the list for the retry.
function blockedCard(turn) {
  const blocks = turn.presentation?.blocks || [];
  const own = blocks.filter((b) => b.type === 'blocked').flatMap((b) => (Array.isArray(b.items) ? b.items : []));
  const items = [...(turn.blocked || [])];
  for (const i of own) {
    if (!i || typeof i !== 'object') continue;
    const item = { tool: String(i.tool || 'tool'), detail: String(i.detail ?? i.command ?? i.path ?? ''), ...(i.why && { why: String(i.why) }) };
    const known = items.find((b) => sameAction(b, item) || (item.detail && b.detail === item.detail));
    if (known) known.why ||= item.why;
    else items.push(item);
  }
  // The agent may name a tool its own way (shell for Bash): the same command still counts.
  const left = items.filter((b) => !(turn.denied || []).some((d) => sameAction(d, b) || (b.detail && d.detail === b.detail))).slice(0, 12);
  // A run in Full auto was already allowed everything wisp can allow: what its harness still refused
  // was its own safety check (Claude Code's on a heredoc it can't parse), which no rule lifts. The
  // card still says what was refused, with nothing to retry.
  if (left.length && turn.mode !== 'auto') turn.blocked = left;
  else delete turn.blocked;
  if (!turn.presentation) return;
  const rest = blocks.filter((b) => b.type !== 'blocked');
  if (left.length) rest.splice(rest[0]?.type === 'hero' ? 1 : 0, 0, { type: 'blocked', items: left.map(({ rule, ...b }) => b) });
  turn.presentation.blocks = rest;
}
