// Switching harness in a follow-up (v1 server/handoff.js). Each harness keeps its own conversation,
// so one picked up mid-task hasn't seen the turns that ran elsewhere: handoffNote() writes those
// turns out (requests, reports, files touched) ahead of the follow-up's prompt.

import { blocksToMarkdown } from './blocks/render.ts';
import { textMentions } from './mentions.ts';
import type { Session, Turn } from './model.ts';
import { clip, truncate } from './util.ts';

const BUDGET = 24_000; // characters of earlier turns, newest kept first
const MAX_RULES = 12;
const RULE_CHARS = 300;
const PER_TURN = 6_000;
// The parts of a report worth passing on. Diffs, code and terminal output are on disk or in git.
const KEEP: ReadonlySet<string> = new Set(['hero', 'markdown', 'steps', 'stats', 'files', 'tests', 'commits', 'checklist', 'callout', 'question', 'next']);

export type NameOf = (t: Turn) => string;

/**
 * The turns before the current one that `agent` hasn't seen: everything after the last turn it
 * ran, or all of them when it has no conversation to resume. Only a gap another harness filled
 * counts. Moved, forked and shared turns count as unseen by every harness.
 */
export function missedTurns(session: Session, agent: string, resumeId: string | null | undefined, mine: (t: Turn) => boolean = (t) => (t.agent || agent) === agent): Turn[] {
  const prior = session.turns.slice(0, -1);
  const missed = resumeId ? prior.slice(prior.findLastIndex((t) => !t.moved && !t.forked && !t.shared && mine(t)) + 1) : prior;
  return missed.some((t) => t.moved || t.forked || t.shared || !mine(t)) ? missed : [];
}

/** One earlier turn as markdown: the request, its report and the files it edited. /btw uses it too. */
export function turnText(t: Turn, n: number, name: NameOf): string {
  const blocks = (t.presentation?.blocks ?? []).filter((b) => KEEP.has(b?.type));
  const report = t.status === 'running' ? '' : blocksToMarkdown(blocks, t) || clip(t.raw, 1500);
  const files = (t.changes ?? []).filter((c) => !c.reverted).map((c) => `\`${c.file}\``);
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

// What the user ruled out or narrowed in their own messages: a turn digest clips them, and a harness
// taking the task over would lose them.
const RULE: readonly RegExp[] = [
  /\b(?:don'?t|do not|never|must not|mustn'?t|shouldn'?t|should not|avoid)\s+(?:\w+ing\s+)?(?:touch|chang|modif|edit|delet|remov|renam|refactor|rewrit|add|commit|push|merge|install|upgrad|bump|deploy|publish|run)\w*/i,
  /\bonly\s+(?:change|touch|edit|modify|work (?:in|on))\b/i,
  /\bleave\b.{1,80}?\b(?:alone|as (?:it )?is|untouched)\b/i,
  /\bwithout (?:changing|touching|modifying|editing)\b/i,
  /\bkeep\b.{1,60}?\b(?:as (?:it )?is|unchanged|untouched)\b/i,
  /\b(?:no new|not? (?:any )?new) (?:dependenc|packages?|librar|files?)\w*/i,
];

export function constraintsOf(session: Session): string[] {
  const out: string[] = [];
  for (const t of session.turns ?? []) {
    if (t.by || t.goal || t.later || !t.prompt) continue;
    const text = textMentions(String(t.prompt)).replace(/[‘’]/g, "'");
    for (const raw of text.split(/\n+|(?<=[.!?])\s+(?=[A-Z])/)) {
      const line = raw.replace(/^\s*(?:[-*•>]|\d+[.)])\s*/, '').trim();
      if (!line || !RULE.some((r) => r.test(line))) continue;
      const rule = clip(line, RULE_CHARS);
      if (!out.includes(rule)) out.push(rule);
    }
  }
  return out.slice(-MAX_RULES);
}

/** `doneWhen`: the task's goal, when wisp.goal has one in progress (it says so through the session's ext). */
function keepNote(session: Session, doneWhen: string): string {
  const rules = constraintsOf(session);
  if (!rules.length && !doneWhen) return '';
  return [
    '### What still holds',
    'The user set these earlier in this task. They hold for you too, whatever the turns below did:',
    [...rules.map((r) => `- ${r}`), ...(doneWhen ? [`- Done when: ${clip(doneWhen.replace(/\s+/g, ' '), 600)}`] : [])].join('\n'),
  ].join('\n\n');
}

// The same thinking level on the harness taking over, as close as it has one.
const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function mapEffort(effort: string, levels: readonly string[] = []): string {
  if (!effort || !levels.length) return '';
  if (levels.includes(effort)) return effort;
  const at = LEVELS.indexOf(effort);
  if (at < 0) return '';
  const known = levels.filter((l) => LEVELS.includes(l));
  if (!known.length) return '';
  const d = (l: string): number => Math.abs(LEVELS.indexOf(l) - at);
  return known.reduce((best, l) => (d(l) < d(best) || (d(l) === d(best) && LEVELS.indexOf(l) < LEVELS.indexOf(best)) ? l : best));
}

function introOf(session: Session, missed: Turn[], others: string, places: string, fresh: boolean): string {
  const f = session.forkedFrom;
  const sh = (session.sharedFrom ?? null) as { name?: string; handle?: string; title?: string } | null;
  if (sh && missed.some((t) => t.shared))
    return `You are carrying on a task that ${sh.name || 'someone'}${sh.handle ? ` (@${sh.handle})` : ''} shared from their wisp (“${sh.title}”), now in the user's own wisp. Its work so far is in this folder when it came with the share: committed work as commits, the rest as uncommitted changes. Below is what happened so far, oldest first; read the files and \`git diff\` for the details, then do what the follow-up asks.`;
  if (f && missed.some((t) => t.forked))
    return `This task is a fork of another one (“${f.title}”), made from its turn ${f.turn} of ${f.of} to try another way. You carry on from there in a copy of its work, on a branch of its own: what you change here doesn’t touch the original, which carries on separately. Below is what happened up to the fork, oldest first; read the files and \`git diff\` for the details, then do what the follow-up asks.`;
  if (places)
    return `You are taking over a task that ran on another computer (${places})${others ? `, on ${others}` : ''}, and was moved here. Its work so far is already in this folder: committed work as commits, the rest as uncommitted changes. Below is what happened so far, oldest first; read the files and \`git diff\` for the details, then carry on with the follow-up.`;
  if (fresh)
    return `You are taking over a task that another coding agent (${others}) has been working on. Its work is already in this folder. Below is what happened so far, oldest first; read the files and \`git diff\` for the details, then carry on with the follow-up.`;
  return `While you were away, this task continued on another coding agent (${others}). Its work is already in this folder. Below is what happened since your last turn, oldest first; check the files and \`git diff\` before you rely on what you remember.`;
}

/** The note for `agent` taking the next turn, or '' when it has seen everything. */
export function handoffNote(session: Session, agent: string, resumeId: string | null | undefined, name: NameOf, mine?: (t: Turn) => boolean, doneWhen = ''): string {
  const missed = missedTurns(session, agent, resumeId, mine);
  if (!missed.length) return '';
  const all = session.turns.slice(0, -1);
  const parts: string[] = [];
  let used = 0;
  for (let i = missed.length - 1; i >= 0; i--) {
    const t = missed[i] as Turn;
    const text = turnText(t, all.indexOf(t) + 1, name);
    if (used + text.length > BUDGET && parts.length) break;
    parts.unshift(text);
    used += text.length;
  }
  const dropped = missed.length - parts.length;
  const lastMissed = missed[missed.length - 1] as Turn;
  const others = [...new Set(missed.filter((t) => t.agent !== agent).map(name))].join(', ') || `${name(lastMissed)}, signed in to another account`;
  const places = [...new Set(missed.map((t) => t.moved).filter(Boolean))].join(', ');
  return [
    '## Earlier in this task',
    introOf(session, missed, others, places, !resumeId),
    keepNote(session, doneWhen),
    dropped ? `_${dropped} earlier turn${dropped > 1 ? 's' : ''} left out for length._` : '',
    ...parts,
    '---',
    '## Follow-up',
  ]
    .filter(Boolean)
    .join('\n\n');
}
