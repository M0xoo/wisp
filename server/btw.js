// /btw: a side question about a task ("/btw did you also update the docs?"), answered while its
// run carries on. The answer comes from a read-only run of its own: a fork of the agent's
// conversation where the harness can fork one, so it knows everything the run did and why; else a
// fresh run that gets wisp's record of the task. Nothing goes back into the task's conversation.

import { turnText } from './handoff.js';
import { textMentions } from './mentions.js';
import { blocksToMarkdown } from './render.js';
import { parsePresentation } from './protocol.js';
import { clip, truncate } from './util.js';

export const BTW_CMD = /^\/btw(?:\s+|$)/i;
export const MAX_BTW = 3; // side questions running at once, per task
export const BTW_TIMEOUT_MS = 5 * 60_000;
const DIGEST_TURNS = 4; // earlier turns written out for a run that can't fork
const LIVE_ACTS = 40; // the running turn's latest actions it gets to see

// The question in "/btw did you …", or null when the text isn't a /btw.
export function btwQuestion(text) {
  const t = String(text || '').trim();
  return BTW_CMD.test(t) ? t.replace(BTW_CMD, '').trim() : null;
}

// Marks the run as a side question (the system prompt, where the harness takes one).
export const BTW_SYSTEM = '# wisp btw\n\nYou answer a side question about a coding task. You only read; you change nothing.';

const rules = (forked) => `# wisp btw

The user has a quick side question (/btw) about this task. ${forked ? 'This is a copy of the conversation so far: the original keeps working on the task in parallel, and it' : 'Another agent run is working on this task, and it'} does the work. This reply only answers the user.

- Answer just the question, briefly: a few sentences or a short list, in plain markdown.
- Change nothing: no edits, no file writes, no commits, no commands with side effects. Reading files, \`git diff\` and \`git status\` is fine when you need to check.
- No wisp presentation block and no wisp tools (ask_user, delegate): this isn't a task result.
- If you can't tell from what's here, say so instead of guessing.`;

// What the task has been doing, for a run that can't fork the conversation: the earlier turns'
// requests and reports, and the latest turn's actions so far.
export function btwDigest(session, name = (t) => t.agent || session.agent) {
  const turns = session.turns || [];
  const parts = [];
  const from = Math.max(0, turns.length - DIGEST_TURNS);
  if (from) parts.push(`_${from} earlier turn${from > 1 ? 's' : ''} left out._`);
  turns.slice(from).forEach((t, i) => {
    const n = from + i + 1;
    if (t.status !== 'running') return parts.push(turnText(t, n, name));
    const acts = (t.activity || []).filter((a) => a.kind !== 'text').slice(-LIVE_ACTS);
    const said = (t.activity || []).findLast((a) => a.kind === 'text')?.label;
    const files = (t.changes || []).map((c) => `\`${c.file}\``);
    parts.push(
      [
        `### Turn ${n} · ${name(t)} · still running (started ${Math.max(1, Math.round((Date.now() - t.startedAt) / 60_000))} min ago)`,
        `**User:** ${textMentions(t.prompt)}`,
        acts.length && `**What it has done so far (oldest first):**\n${acts.map((a) => `- ${clip(a.label, 160)}`).join('\n')}`,
        files.length && `**Files it edited so far:** ${files.join(', ')}`,
        said && `**Its latest message:** ${truncate(said, 1200)}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
  });
  return parts.join('\n\n');
}

// forked: the run resumes a copy of the conversation, so it already knows the task.
export function btwPrompt(session, question, { forked, name } = {}) {
  const head = rules(forked);
  if (forked) return `${head}\n\n## Side question\n\n${question}`;
  return `${head}\n\n## The task so far\n\n${btwDigest(session, name)}\n\n---\n\n## Side question\n\n${question}`;
}

// The reply as markdown. An agent that ended with a wisp block anyway gets it rendered.
export function btwAnswer(text) {
  const p = parsePresentation(String(text || ''));
  const md = p.fallback ? String(text || '').trim() : [p.notes, blocksToMarkdown(p.blocks)].filter(Boolean).join('\n\n');
  return md || '_No answer._';
}
