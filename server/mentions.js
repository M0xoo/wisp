// Task mentions: a prompt can point at another wisp task. The web app stores one as
// `@[Title](wisp:<id>)` (pasting a copied task id in a prompt box makes one); the agent gets
// `@Title (wisp task <id>)` plus a note on how to read it: the wisp_session tool, or the task's
// report inline for runs that can't take wisp's MCP tools.

import { sessionToMarkdown } from './render.js';
import { truncate } from './util.js';
import { stuffDetail } from './services/stuff.js';

export const MENTION = /@\[([^\]\n]{1,200})\]\(wisp:([a-z0-9]{6,40})\)/g;
const INLINE_MAX = 8_000; // characters of a mentioned task's report, when it goes in the prompt

// A crew member mentioned in a prompt (server/crew.js): `@[Ada](crew:<id>)`, read as `@Ada`.
const CREW = /@\[([^\]\n]{1,200})\]\(crew:[a-z0-9]{6,40}\)/g;
// Something in My Stuff (services/stuff.js): `@[Logo](stuff:<id>)`. The agent gets where its file is.
export const STUFF = /@\[([^\]\n]{1,200})\]\(stuff:([a-z0-9]{6,40})\)/g;
export const stuffIn = (text = '') => [...new Map([...String(text).matchAll(STUFF)].map((m) => [m[2], { id: m[2], title: m[1] }])).values()];

export const mentionsIn = (text = '') => [...new Map([...String(text).matchAll(MENTION)].map((m) => [m[2], { id: m[2], title: m[1] }])).values()];

// What a person reads: titles, no ids (session titles, notifications).
export const plainMentions = (text = '') => String(text).replace(MENTION, '@$1').replace(CREW, '@$1').replace(STUFF, '@$1');

// What an agent reads in place of each mention.
export const textMentions = (text = '') => String(text).replace(MENTION, '@$1 (wisp task $2)').replace(CREW, '@$1').replace(STUFF, '@$1 (My Stuff item $2)');

// The prompt for an agent run. tool: how this harness names the wisp_session tool, or null when
// it has none (then each mentioned task's latest report goes in the prompt).
export function agentPrompt(prompt, store, { tool = 'wisp_session', self, stuff } = {}) {
  const found = mentionsIn(prompt).filter((m) => m.id !== self);
  const kept = stuffNote(prompt, stuff, !!tool);
  if (!found.length) return textMentions(prompt) + kept;
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
  return `${textMentions(prompt)}\n\n<wisp-tasks>\n${note}\n</wisp-tasks>${kept}`;
}

// The things from My Stuff the prompt points at: each with its file (or folder, or url), and a
// doc's or snippet's text, so the agent can use it, or update it with wisp_save when it has the tool.
function stuffNote(prompt, stuff, tools) {
  const found = stuffIn(prompt);
  if (!found.length || !stuff) return '';
  const lines = found.map((m) => {
    const it = stuff.get(m.id);
    return it ? stuffDetail(it) : `- \`${m.id}\` (${m.title}): no longer in My Stuff.`;
  });
  const how = tools ? 'Use them from these paths. To change one for the user, save the new version with wisp_save and its id.' : 'Use them from these paths; leave the copies there as they are.';
  return `\n\n<wisp-stuff>\nThe user points at things they kept in My Stuff. ${how}\n${lines.join('\n')}\n</wisp-stuff>`;
}
