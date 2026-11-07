// /btw (v1 server/btw.js): a side question about a task ("/btw did you also update the docs?"),
// answered while its run carries on, by a read-only run of its own: a fork of the agent's
// conversation where the harness can fork one, else a fresh run that gets wisp's record of the task.
// Nothing goes back into the task's conversation. These are the texts; runner/btw.ts runs it.

import { parsePresentation } from './blocks/parse.ts';
import { blocksToMarkdown } from './blocks/render.ts';
import { turnText } from './handoff.ts';
import type { NameOf } from './handoff.ts';
import { textMentions } from './mentions.ts';
import type { Session } from './model.ts';
import { clip, truncate } from './util.ts';

export const BTW_CMD = /^\/btw(?:\s+|$)/i;
export const MAX_BTW = 3; // side questions running at once, per task
export const BTW_TIMEOUT_MS = 5 * 60_000;
const DIGEST_TURNS = 4; // earlier turns written out for a run that can't fork
const LIVE_ACTS = 40; // the running turn's latest actions it gets to see

/** The question in "/btw did you …", or null when the text isn't a /btw. */
export function btwQuestion(text: unknown): string | null {
  const t = String(text ?? '').trim();
  return BTW_CMD.test(t) ? t.replace(BTW_CMD, '').trim() : null;
}

/** Marks the run as a side question (the system prompt, where the harness takes one). */
export const BTW_SYSTEM = '# wisp btw\n\nYou answer a side question about a coding task. You only read; you change nothing.';

const rules = (forked: boolean): string => `# wisp btw

The user has a quick side question (/btw) about this task. ${forked ? 'This is a copy of the conversation so far: the original keeps working on the task in parallel, and it' : 'Another agent run is working on this task, and it'} does the work. This reply only answers the user.

- Answer just the question, briefly: a few sentences or a short list, in plain markdown.
- Change nothing: no edits, no file writes, no commits, no commands with side effects. Reading files, \`git diff\` and \`git status\` is fine when you need to check.
- No wisp presentation block and no wisp tools (ask_user, delegate): this isn't a task result.
- If you can't tell from what's here, say so instead of guessing.`;

/** What the task has been doing, for a run that can't fork: earlier turns, and the latest one's actions so far. */
export function btwDigest(session: Session, name: NameOf = (t) => t.agent || session.agent, now = Date.now()): string {
  const turns = session.turns ?? [];
  const parts: string[] = [];
  const from = Math.max(0, turns.length - DIGEST_TURNS);
  if (from) parts.push(`_${from} earlier turn${from > 1 ? 's' : ''} left out._`);
  turns.slice(from).forEach((t, i) => {
    const n = from + i + 1;
    if (t.status !== 'running') return void parts.push(turnText(t, n, name));
    const acts = (t.activity ?? []).filter((a) => a.kind !== 'text').slice(-LIVE_ACTS);
    const said = (t.activity ?? []).findLast((a) => a.kind === 'text')?.label;
    const files = (t.changes ?? []).map((c) => `\`${c.file}\``);
    parts.push(
      [
        `### Turn ${n} · ${name(t)} · still running (started ${Math.max(1, Math.round((now - t.startedAt) / 60_000))} min ago)`,
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

export function btwPrompt(session: Session, question: string, { forked = false, name }: { forked?: boolean; name?: NameOf } = {}): string {
  const head = rules(forked);
  if (forked) return `${head}\n\n## Side question\n\n${question}`;
  return `${head}\n\n## The task so far\n\n${btwDigest(session, name)}\n\n---\n\n## Side question\n\n${question}`;
}

/** The reply as markdown. An agent that ended with a wisp block anyway gets it rendered. */
export function btwAnswer(text: unknown): string {
  const p = parsePresentation(String(text ?? ''));
  const md = p.fallback ? String(text ?? '').trim() : [p.notes, blocksToMarkdown(p.blocks)].filter(Boolean).join('\n\n');
  return md || '_No answer._';
}
