// Task mentions: a prompt can point at another wisp task. The web app stores one as
// `@[Title](wisp:<id>)` (pasting a copied task id in a prompt box makes one); the agent gets
// `@Title (wisp task <id>)` plus a note on how to read it: the wisp_session tool, or the task's
// report inline for runs that can't take wisp's MCP tools.

import { sessionToMarkdown } from './render.js';
import { truncate } from './util.js';

export const MENTION = /@\[([^\]\n]{1,200})\]\(wisp:([a-z0-9]{6,40})\)/g;
const INLINE_MAX = 8_000; // characters of a mentioned task's report, when it goes in the prompt

export const mentionsIn = (text = '') => [...new Map([...String(text).matchAll(MENTION)].map((m) => [m[2], { id: m[2], title: m[1] }])).values()];

// What a person reads: titles, no ids (session titles, notifications).
export const plainMentions = (text = '') => String(text).replace(MENTION, '@$1');

// What an agent reads in place of each mention.
export const textMentions = (text = '') => String(text).replace(MENTION, '@$1 (wisp task $2)');

// The prompt for an agent run. tool: how this harness names the wisp_session tool, or null when
// it has none (then each mentioned task's latest report goes in the prompt).
export function agentPrompt(prompt, store, { tool = 'wisp_session', self } = {}) {
  const found = mentionsIn(prompt).filter((m) => m.id !== self);
  if (!found.length) return textMentions(prompt);
  const line = (m) => {
    const s = store.get(m.id);
    if (!s) return `- \`${m.id}\` (${m.title}): not on this computer; it may have been deleted or run on another machine.`;
    return `- \`${s.id}\` **${s.title}**: ${s.state}, ${s.agent}, ${s.turns.length} turn${s.turns.length === 1 ? '' : 's'}, in \`${s.worktree?.path || s.cwd}\``;
  };
  const note = tool
    ? `The user mentions other wisp tasks. Read one with \`wisp_session\` (${tool}) before relying on it; \`wisp_sessions\` lists the rest.\n${found.map(line).join('\n')}`
    : `The user mentions other wisp tasks. Their latest reports:\n\n${found
        .map((m) => {
          const s = store.get(m.id);
          return s ? `### ${s.title} (\`${s.id}\`)\n\n${truncate(sessionToMarkdown(s), INLINE_MAX)}` : line(m);
        })
        .join('\n\n')}`;
  return `${textMentions(prompt)}\n\n<wisp-tasks>\n${note}\n</wisp-tasks>`;
}
