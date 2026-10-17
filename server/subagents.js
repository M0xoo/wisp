// Subagents: a team the user picks at launch (any harness, model and thinking level each) that
// the lead agent can hand work to through wisp's injected `delegate` tool. Each member is a
// hidden child session working in the lead's folder; delegating to it again resumes it.

import { blocksToMarkdown } from './render.js';

export const MAX_SUBAGENTS = 6; // rows in the team
export const MAX_COPIES = 5; // parallel copies of one row
export const MAX_INSTANCES = 12; // copies across the whole team
const EFFORT = /^[\w-]{1,20}$/;
const MAX_USE = 300;
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);

// [{ name?, agent, model?, effort?, use?, count? }] → a clean roster with unique names (codex, codex-2, …).
// use: the user's note on when to pick this one ("image work", "research"), shown to the lead.
// count: how many parallel copies of this member the lead gets (codex#1, codex#2, …).
export function normalizeTeam(list, adapters) {
  if (!Array.isArray(list)) return [];
  const taken = new Set();
  const team = list.slice(0, MAX_SUBAGENTS).map((m) => {
    const agent = String(m?.agent || '');
    if (!adapters[agent] || agent === 'wisp') throw Object.assign(new Error(`unknown subagent harness: ${agent}`), { status: 400 });
    let base = slug(m.name) || agent;
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
    taken.add(name);
    const use = String(m.use || '').replace(/\s+/g, ' ').trim().slice(0, MAX_USE);
    const count = Math.min(MAX_COPIES, Math.max(1, Math.floor(Number(m.count)) || 1));
    return { name, agent, model: typeof m.model === 'string' ? m.model.slice(0, 120) : '', effort: EFFORT.test(m.effort || '') ? m.effort : '', use, count };
  });
  const total = team.reduce((n, m) => n + m.count, 0);
  if (total > MAX_INSTANCES) throw Object.assign(new Error(`At most ${MAX_INSTANCES} subagents in all (this team has ${total}).`), { status: 400 });
  return team;
}

// The sessions a member runs as: itself, or one per copy (`#` can't appear in a name, so no clashes).
export const copies = (m) => ((m.count || 1) > 1 ? Array.from({ length: m.count }, (_, i) => `${m.name}#${i + 1}`) : [m.name]);

// Saved teams the user can reuse from the launcher: { id, name, members }.
export function normalizePreset(body, adapters, prev = {}) {
  const name = String(body?.name ?? prev.name ?? '').trim().slice(0, 60);
  if (!name) throw Object.assign(new Error('A preset needs a name.'), { status: 400 });
  const members = body?.members !== undefined ? normalizeTeam(body.members, adapters) : prev.members || [];
  if (!members.length) throw Object.assign(new Error('A preset needs at least one subagent.'), { status: 400 });
  return { id: prev.id || slug(name) + '-' + Math.random().toString(36).slice(2, 6), name, members, updatedAt: Date.now() };
}

const who = (m, adapters) => [adapters[m.agent]?.name || m.agent, m.model || 'default model', m.effort && `${m.effort} thinking`].filter(Boolean).join(' · ');

// Appended to the lead's system prompt. `tool` is how its harness names the delegate tool.
export function teamNote(team, adapters, tool) {
  if (!team?.length || !tool) return '';
  const rows = team
    .map((m) => `- \`${m.name}\`${m.count > 1 ? ` ×${m.count} (copies ${copies(m).map((c) => `\`${c}\``).join(', ')})` : ''}: ${who(m, adapters)}${m.use ? `. Use it for: ${m.use}` : ''}`)
    .join('\n');
  const multi = team.find((m) => m.count > 1);
  return `\n\n## Subagents

The user gave you a team of subagents, each a separate coding agent running on its own harness and model:

${rows}

Hand them work with the \`delegate\` tool (${tool}): pass one or more tasks, \`{ "subagent": "<name>", "prompt": "…" }\`. Tasks in one call run in parallel and the call returns when all of them finish, with each subagent's report and the files it changed. With \`wait: false\` it returns at once; collect the reports later with \`subagent_results\`. Delegating to the same subagent again continues its conversation, so it remembers earlier tasks.

${multi ? `- A subagent with ×N has N identical copies that run at once. Put several tasks for \`${multi.name}\` in one delegate call and each goes to a free copy; name a copy (\`${copies(multi)[1]}\`) to continue that copy's conversation.\n` : ''}- Subagents work in your folder and see each other's edits. Give parallel subagents separate files or concerns.
- Brief them like a colleague: goal, files, constraints, how to verify. They cannot see your conversation or ask the user.
- Follow the user's "use it for" notes when you pick a subagent: send each kind of work to the one meant for it.
- These are your subagents for this session. Whenever you would spawn a subagent, sub-task or helper agent (your harness's built-in Task/Agent tool included), use \`delegate\` instead: don't use built-in subagents.
- Delegate when the user's request calls for it or when the work splits cleanly; you stay responsible for the result. Review what they changed before you report.
- Your presentation covers the whole task; wisp shows each subagent's report next to it, so don't repeat them in full.`;
}

// Replaces the ask_user guidance for a subagent's own system prompt.
export const SUBAGENT_ASK = `- You are a subagent: a lead agent delegated this task to you and will read your presentation.
  You cannot ask the user anything. Make the call yourself, note the assumption in a "callout"
  block, and finish. Don't commit unless the task says to.`;

// What the lead gets back for one delegation.
export function delegationReport(d, child, adapters) {
  const turn = child?.turns.find((t) => t.id === d.turnId);
  const head = `### ${d.name} (${who(d, adapters)}) — ${turn?.status || 'gone'}`;
  if (!turn) return `${head}\n\nThe subagent session is gone.`;
  if (turn.status === 'running') return `${head}\n\nStill working. Call subagent_results to wait for it.`;
  const files = turn.changes.length ? `\n\nFiles it changed: ${turn.changes.map((c) => `\`${c.file}\``).join(', ')}` : '';
  return `${head}\n\n${blocksToMarkdown(turn.presentation?.blocks || [], turn).trim() || '_No report._'}${files}`;
}
