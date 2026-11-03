// Switching harness in a follow-up. Each harness keeps its own conversation (native session id),
// so a harness picked up mid-task hasn't seen the turns that ran elsewhere. handoffNote() writes
// those turns out (requests, reports, files touched) and goes ahead of the follow-up's prompt.
// A harness that ran earlier in the task resumes its own session and only hears what it missed.

import { textMentions } from './mentions.js';
import { blocksToMarkdown } from './render.js';
import { clip, truncate } from './util.js';

const BUDGET = 24_000; // characters of earlier turns, newest kept first
const MAX_RULES = 12;
const RULE_CHARS = 300;
const PER_TURN = 6_000;
// The parts of a report worth passing on. Diffs, code and terminal output are on disk or in git.
const KEEP = new Set(['hero', 'markdown', 'steps', 'stats', 'files', 'tests', 'commits', 'checklist', 'callout', 'question', 'next']);

// The turns before the current one that `agent` hasn't seen: everything after the last turn it
// ran, or all of them when it has no conversation of its own to resume (resumeId). Only a gap
// that another harness filled counts: on its own, a harness has nothing to catch up on.
// Turns that ran on another place before the task moved here (t.moved) count as unseen by every
// harness: their conversations stayed there. So do a fork's first turns (t.forked, services/fork.js):
// they ran in the task it was forked from, and a shared task's (t.shared, services/share.js): they
// ran on someone else's wisp.
// mine(turn): whether the conversation being resumed ran that turn (by default: the same harness;
// a harness whose conversations stay with the login also needs the same account).
export function missedTurns(session, agent, resumeId, mine = (t) => (t.agent || agent) === agent) {
  const prior = session.turns.slice(0, -1);
  const missed = resumeId ? prior.slice(prior.findLastIndex((t) => !t.moved && !t.forked && !t.shared && mine(t)) + 1) : prior;
  return missed.some((t) => t.moved || t.forked || t.shared || !mine(t)) ? missed : [];
}

// One earlier turn as markdown: the request, its report and the files it edited. /btw uses it too.
export function turnText(t, n, name) {
  const blocks = (t.presentation?.blocks || []).filter((b) => KEEP.has(b?.type));
  const report = t.status === 'running' ? '' : blocksToMarkdown(blocks, t) || clip(t.raw, 1500);
  const files = (t.changes || []).filter((c) => !c.reverted).map((c) => `\`${c.file}\``);
  return truncate(
    [
      `### Turn ${n} · ${name(t)}${t.model ? ` (${t.model})` : ''}${t.moved ? ` · on ${t.moved}` : ''}${t.status === 'stopped' ? ' · stopped' : t.status === 'error' ? ' · failed' : ''}${t.rolledBackAt ? ' · rolled back, its edits were undone' : ''}`,
      `**User:** ${textMentions(t.prompt)}`,
      report && `**Report:**\n\n${report}`,
      files.length && `**Files it edited:** ${files.join(', ')}`,
      t.delegations?.length && `**Delegated:** ${t.delegations.map((d) => `@${d.name} (${clip(textMentions(d.prompt || ''), 120)})`).join('; ')}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
    PER_TURN,
  );
}

// What the user ruled out or narrowed in their own messages ("don't touch the migrations", "only
// change web/", "leave the tests alone"): a turn digest clips them, and a harness that takes the task
// over (a refusal or limit hand-off, a switch) would lose them. Lines from the user's own turns only
// (not wisp's carry-ons, goal rounds or scheduled follow-ups), oldest first, each once.
const RULE = [
  /\b(?:don'?t|do not|never|must not|mustn'?t|shouldn'?t|should not|avoid)\s+(?:\w+ing\s+)?(?:touch|chang|modif|edit|delet|remov|renam|refactor|rewrit|add|commit|push|merge|install|upgrad|bump|deploy|publish|run)\w*/i,
  /\bonly\s+(?:change|touch|edit|modify|work (?:in|on))\b/i,
  /\bleave\b.{1,80}?\b(?:alone|as (?:it )?is|untouched)\b/i,
  /\bwithout (?:changing|touching|modifying|editing)\b/i,
  /\bkeep\b.{1,60}?\b(?:as (?:it )?is|unchanged|untouched)\b/i,
  /\b(?:no new|not? (?:any )?new) (?:dependenc|packages?|librar|files?)\w*/i,
];
export function constraintsOf(session) {
  const out = [];
  for (const t of session.turns || []) {
    if (t.by || t.goal || t.later || !t.prompt) continue;
    const text = textMentions(String(t.prompt)).replace(/[\u2018\u2019]/g, "'");
    for (const raw of text.split(/\n+|(?<=[.!?])\s+(?=[A-Z])/)) {
      const line = raw.replace(/^\s*(?:[-*•>]|\d+[.)])\s*/, '').trim();
      if (!line || !RULE.some((r) => r.test(line))) continue;
      const rule = clip(line, RULE_CHARS);
      if (!out.includes(rule)) out.push(rule);
    }
  }
  return out.slice(-MAX_RULES);
}

// What carries over to the harness taking the task: the user's constraints and the task's Done
// when (the goal's own section in the system prompt explains the checking; this keeps it in view).
function keepNote(session) {
  const rules = constraintsOf(session);
  const goal = session.goal && !['met', 'impossible', 'out', 'handed'].includes(session.goal.status) ? session.goal.text : '';
  if (!rules.length && !goal) return '';
  return [
    '### What still holds',
    'The user set these earlier in this task. They hold for you too, whatever the turns below did:',
    [...rules.map((r) => `- ${r}`), ...(goal ? [`- Done when: ${clip(goal.replace(/\s+/g, ' '), 600)}`] : [])].join('\n'),
  ].join('\n\n');
}

// The same thinking level on the harness taking over, as close as it has one: Claude's medium is
// Codex's medium, Claude's max is Codex's xhigh (its highest). '' when it has none or none was set.
const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function mapEffort(effort, levels = []) {
  if (!effort || !levels.length) return '';
  if (levels.includes(effort)) return effort;
  const at = LEVELS.indexOf(effort);
  if (at < 0) return '';
  const known = levels.filter((l) => LEVELS.includes(l));
  if (!known.length) return '';
  return known.reduce((best, l) => (Math.abs(LEVELS.indexOf(l) - at) < Math.abs(LEVELS.indexOf(best) - at) || (Math.abs(LEVELS.indexOf(l) - at) === Math.abs(LEVELS.indexOf(best) - at) && LEVELS.indexOf(l) < LEVELS.indexOf(best)) ? l : best));
}

// The note for `agent` taking the next turn, or '' when it has seen everything.
// name(turn) → the harness's display name for that turn.
export function handoffNote(session, agent, resumeId, name, mine) {
  const missed = missedTurns(session, agent, resumeId, mine);
  if (!missed.length) return '';
  const all = session.turns.slice(0, -1);
  const parts = [];
  let used = 0;
  for (let i = missed.length - 1; i >= 0; i--) {
    const text = turnText(missed[i], all.indexOf(missed[i]) + 1, name);
    if (used + text.length > BUDGET && parts.length) break;
    parts.unshift(text);
    used += text.length;
  }
  const dropped = missed.length - parts.length;
  const fresh = !resumeId;
  // The same harness on another account (server/accounts.js) has no other name to give.
  const others = [...new Set(missed.filter((t) => t.agent !== agent).map(name))].join(', ') || `${name(missed.at(-1))}, signed in to another account`;
  const places = [...new Set(missed.map((t) => t.moved).filter(Boolean))].join(', ');
  const f = session.forkedFrom;
  const sh = session.sharedFrom;
  const intro = sh && missed.some((t) => t.shared)
    ? `You are carrying on a task that ${sh.name || 'someone'}${sh.handle ? ` (@${sh.handle})` : ''} shared from their wisp (“${sh.title}”), now in the user's own wisp. Its work so far is in this folder when it came with the share: committed work as commits, the rest as uncommitted changes. Below is what happened so far, oldest first; read the files and \`git diff\` for the details, then do what the follow-up asks.`
    : f && missed.some((t) => t.forked)
    ? `This task is a fork of another one (“${f.title}”), made from its turn ${f.turn} of ${f.of} to try another way. You carry on from there in a copy of its work, on a branch of its own: what you change here doesn’t touch the original, which carries on separately. Below is what happened up to the fork, oldest first; read the files and \`git diff\` for the details, then do what the follow-up asks.`
    : places
    ? `You are taking over a task that ran on another computer (${places})${others ? `, on ${others}` : ''}, and was moved here. Its work so far is already in this folder: committed work as commits, the rest as uncommitted changes. Below is what happened so far, oldest first; read the files and \`git diff\` for the details, then carry on with the follow-up.`
    : fresh
      ? `You are taking over a task that another coding agent (${others}) has been working on. Its work is already in this folder. Below is what happened so far, oldest first; read the files and \`git diff\` for the details, then carry on with the follow-up.`
      : `While you were away, this task continued on another coding agent (${others}). Its work is already in this folder. Below is what happened since your last turn, oldest first; check the files and \`git diff\` before you rely on what you remember.`;
  return [
    '## Earlier in this task',
    intro,
    keepNote(session),
    dropped ? `_${dropped} earlier turn${dropped > 1 ? 's' : ''} left out for length._` : '',
    ...parts,
    '---',
    '## Follow-up',
  ]
    .filter(Boolean)
    .join('\n\n');
}
