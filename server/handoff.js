// Switching harness in a follow-up. Each harness keeps its own conversation (native session id),
// so a harness picked up mid-task hasn't seen the turns that ran elsewhere. handoffNote() writes
// those turns out (requests, reports, files touched) and goes ahead of the follow-up's prompt.
// A harness that ran earlier in the task resumes its own session and only hears what it missed.

import { textMentions } from './mentions.js';
import { blocksToMarkdown } from './render.js';
import { clip, truncate } from './util.js';

const BUDGET = 24_000; // characters of earlier turns, newest kept first
const PER_TURN = 6_000;
// The parts of a report worth passing on. Diffs, code and terminal output are on disk or in git.
const KEEP = new Set(['hero', 'markdown', 'steps', 'stats', 'files', 'tests', 'commits', 'checklist', 'callout', 'question', 'next']);

// The turns before the current one that `agent` hasn't seen: everything after the last turn it
// ran, or all of them when it has no conversation of its own to resume (resumeId). Only a gap
// that another harness filled counts: on its own, a harness has nothing to catch up on.
// Turns that ran on another place before the task moved here (t.moved) count as unseen by every
// harness: their conversations stayed there.
export function missedTurns(session, agent, resumeId) {
  const prior = session.turns.slice(0, -1);
  const missed = resumeId ? prior.slice(prior.findLastIndex((t) => !t.moved && (t.agent || agent) === agent) + 1) : prior;
  return missed.some((t) => t.moved || (t.agent || agent) !== agent) ? missed : [];
}

function turnText(t, n, name) {
  const blocks = (t.presentation?.blocks || []).filter((b) => KEEP.has(b?.type));
  const report = t.status === 'running' ? '' : blocksToMarkdown(blocks, t) || clip(t.raw, 1500);
  const files = (t.changes || []).filter((c) => !c.reverted).map((c) => `\`${c.file}\``);
  return truncate(
    [
      `### Turn ${n} · ${name(t)}${t.model ? ` (${t.model})` : ''}${t.moved ? ` · on ${t.moved}` : ''}${t.status === 'stopped' ? ' · stopped' : t.status === 'error' ? ' · failed' : ''}${t.rolledBackAt ? ' · rolled back, its edits were undone' : ''}`,
      `**User:** ${textMentions(t.prompt)}`,
      report && `**Report:**\n\n${report}`,
      files.length && `**Files it edited:** ${files.join(', ')}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
    PER_TURN,
  );
}

// The note for `agent` taking the next turn, or '' when it has seen everything.
// name(turn) → the harness's display name for that turn.
export function handoffNote(session, agent, resumeId, name) {
  const missed = missedTurns(session, agent, resumeId);
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
  const others = [...new Set(missed.filter((t) => t.agent !== agent).map(name))].join(', ');
  const places = [...new Set(missed.map((t) => t.moved).filter(Boolean))].join(', ');
  const intro = places
    ? `You are taking over a task that ran on another computer (${places})${others ? `, on ${others}` : ''}, and was moved here. Its work so far is already in this folder: committed work as commits, the rest as uncommitted changes. Below is what happened so far, oldest first; read the files and \`git diff\` for the details, then carry on with the follow-up.`
    : fresh
      ? `You are taking over a task that another coding agent (${others}) has been working on. Its work is already in this folder. Below is what happened so far, oldest first; read the files and \`git diff\` for the details, then carry on with the follow-up.`
      : `While you were away, this task continued on another coding agent (${others}). Its work is already in this folder. Below is what happened since your last turn, oldest first; check the files and \`git diff\` before you rely on what you remember.`;
  return [
    '## Earlier in this task',
    intro,
    dropped ? `_${dropped} earlier turn${dropped > 1 ? 's' : ''} left out for length._` : '',
    ...parts,
    '---',
    '## Follow-up',
  ]
    .filter(Boolean)
    .join('\n\n');
}
