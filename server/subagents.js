// Subagents (Delegate in the page): a team the user picks at launch (any harness, model and
// thinking level each) that the lead agent can hand work to through wisp's injected `delegate`
// tool. Each member is a hidden child session working in the lead's folder; delegating to it
// again resumes it. A member on another machine (machine) runs there on a copy of the lead's
// work, and its changes come back as a patch (services/relay.js).

import { blocksToMarkdown } from './render.js';
import { bad } from './util.js';

export const MAX_SUBAGENTS = 6; // rows in the team
export const MAX_COPIES = 5; // parallel copies of one row
export const MAX_INSTANCES = 12; // copies across the whole team
const EFFORT = /^[\w-]{1,20}$/;
const MAX_USE = 300;
const PLACE = /^[\w-]{1,40}$/; // 'here' (this computer) or a machine id
const CREW_ID = /^[a-z0-9]{6,40}$/;
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);

// [{ name?, agent, model?, effort?, use?, count? }] → a clean roster with unique names (codex, codex-2, …).
// use: the user's note on when to pick this one ("image work", "research"), shown to the lead.
// count: how many parallel copies of this member the lead gets (codex#1, codex#2, …).
// machine: where it runs, as the wisp you launched from names places: '' with the lead, 'here'
// (that wisp's computer) or a machine id. place: that place's name, for the lead and the cards.
// upstream: the wisp that sent this task runs the member, not this one (it's a machine).
export function normalizeTeam(list, adapters) {
  if (!Array.isArray(list)) return [];
  const taken = new Set();
  const team = list.slice(0, MAX_SUBAGENTS).map((m) => {
    // A member of the user's crew (server/crew.js): it runs as its own job, in its own folder, on
    // the harness it's set up with. label/role: how the lead hears of it. upstream: the crew is the
    // wisp's that sent this task (this one is a machine), so that wisp starts its jobs.
    if (CREW_ID.test(m?.crew || '')) {
      let name = slug(m.name) || 'crew';
      for (let i = 2; taken.has(name); i++) name = `${slug(m.name) || 'crew'}-${i}`;
      taken.add(name);
      const agent = adapters[m.agent] && m.agent !== 'wisp' ? m.agent : 'auto';
      const text = (k, n) => String(m[k] || '').replace(/\s+/g, ' ').trim().slice(0, n);
      return { name, crew: m.crew, label: text('label', 24) || name, role: text('role', 60), agent, model: '', effort: '', use: text('use', MAX_USE), count: 1, ...(m.upstream === true && { upstream: true }) };
    }
    const agent = String(m?.agent || '');
    // auto: wisp picks the harness and model when this member gets its first task.
    if ((!adapters[agent] && agent !== 'auto') || agent === 'wisp') throw bad(`unknown subagent harness: ${agent}`);
    let base = slug(m.name) || agent;
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
    taken.add(name);
    const use = String(m.use || '').replace(/\s+/g, ' ').trim().slice(0, MAX_USE);
    const count = Math.min(MAX_COPIES, Math.max(1, Math.floor(Number(m.count)) || 1));
    const machine = PLACE.test(m.machine || '') ? m.machine : '';
    const where = machine && { machine, place: String(m.place || '').replace(/\s+/g, ' ').trim().slice(0, 40), ...(m.upstream === true && { upstream: true }) };
    return { name, agent, model: typeof m.model === 'string' ? m.model.slice(0, 120) : '', effort: EFFORT.test(m.effort || '') ? m.effort : '', use, count, ...where };
  });
  const total = team.reduce((n, m) => n + m.count, 0);
  if (total > MAX_INSTANCES) throw bad(`At most ${MAX_INSTANCES} subagents in all (this team has ${total}).`);
  return team;
}

// The sessions a member runs as: itself, or one per copy (`#` can't appear in a name, so no clashes).
export const copies = (m) => ((m.count || 1) > 1 ? Array.from({ length: m.count }, (_, i) => `${m.name}#${i + 1}`) : [m.name]);

// Saved teams the user can reuse from the launcher: { id, name, members }.
export function normalizePreset(body, adapters, prev = {}) {
  const name = String(body?.name ?? prev.name ?? '').trim().slice(0, 60);
  if (!name) throw bad('A preset needs a name.');
  const members = body?.members !== undefined ? normalizeTeam(body.members, adapters) : prev.members || [];
  if (!members.length) throw bad('A preset needs at least one subagent.');
  return { id: prev.id || slug(name) + '-' + Math.random().toString(36).slice(2, 6), name, members, updatedAt: Date.now() };
}

const who = (m, adapters) =>
  m.crew
    ? `${m.label || m.name}${m.role ? `, ${m.role}` : ''}, a member of the user's crew: a long-lived agent with its own folder, harness and memory. It works in its own folder, not yours (its edits stay there), and remembers past jobs`
    : (m.agent === 'auto'
    ? 'Auto (wisp picks the harness and model for the first task you give it)'
    : [adapters[m.agent]?.name || m.agent, m.model || 'default model', m.effort && `${m.effort} thinking`].filter(Boolean).join(' · ')) + (m.machine ? ` · on ${m.place || 'another machine'}` : '');

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

${multi ? `- A subagent with ×N has N identical copies that run at once. Put several tasks for \`${multi.name}\` in one delegate call and each goes to a free copy; name a copy (\`${copies(multi)[1]}\`) to continue that copy's conversation.\n` : ''}- Subagents work in your folder and see each other's edits. Give parallel subagents separate files or concerns.${team.some((m) => m.machine) ? `\n${AWAY_LEAD}` : ''}
- Brief them like a colleague: goal, files, constraints, how to verify. They cannot see your conversation or ask the user.
- Follow the user's "use it for" notes when you pick a subagent: send each kind of work to the one meant for it.
- These are your subagents for this session. Whenever you would spawn a subagent, sub-task or helper agent (your harness's built-in Task/Agent tool included), use \`delegate\` instead: don't use built-in subagents.
- Delegate when the user's request calls for it or when the work splits cleanly; you stay responsible for the result. Review what they changed before you report.
- Your presentation covers the whole task; wisp shows each subagent's report next to it, so don't repeat them in full.`;
}

// For a lead with delegates on other machines: what reaches them and what doesn't.
export const AWAY_LEAD = `- A subagent "on" another machine works there, on a copy of your folder as it is when you delegate. Its changes are applied to your folder when it finishes (the report says if they didn't apply cleanly). It doesn't see edits made meanwhile, so give it work that doesn't overlap.
- wisp carries your folder over itself: its commits, uncommitted edits and new files. Don't commit or push to hand it work. What stays behind: git-ignored files (\`.env\`, \`node_modules\`, build output), anything outside your folder, attachments and your local servers. If your folder isn't a git repo, none of it goes.
- Its folder has another path there. Name files by their path inside your folder (\`src/app.ts\`), never by absolute paths of this computer, and paste in the prompt anything it needs that stays behind (a config value, a log excerpt, a file from elsewhere).`;

// Added for a delegate running on another computer than its lead (services/relay.js).
export const AWAY_SUBAGENT = `
- You run on another computer than the lead, in a copy of its folder. An absolute path from the
  lead's computer may not exist here: find the file by its path inside the folder. Your changes
  go back to the lead as a patch when you finish, so don't commit or push them.`;

// Replaces the ask_user guidance for a subagent's own system prompt.
export const SUBAGENT_ASK = `- You are a subagent: a lead agent delegated this task to you and will read your presentation.
  You cannot ask the user anything. Make the call yourself, note the assumption in a "callout"
  block, and finish. Don't commit unless the task says to.`;

// Told to a lead whose follow-up arrived while delegates were still on its earlier tasks.
export const stillWorkingNote = (list) =>
  `Subagents you delegated to before this message are still on it, or done and not yet read: ${list.map((d) => `${d.name} (id ${d.id})`).join(', ')}. Their edits land in your folder. Collect their reports with \`subagent_results\` (no ids needed) when you need them; don't delegate that work again.`;

// Heads the follow-up wisp sends a lead whose turn ended before its delegates finished.
export const REPORTS_BACK = 'Subagents you delegated to earlier have finished. Review their work below and carry on with the task.';

// What the lead gets back for one delegation.
export function delegationReport(d, child, adapters) {
  const turn = child?.turns.find((t) => t.id === d.turnId);
  const head = `### ${d.name} (${who(d, adapters)}) — ${turn?.status || 'gone'}`;
  if (!turn) return `${head}\n\nThe subagent session is gone.`;
  if (turn.status === 'running') return `${head}\n\nStill working. Call subagent_results to wait for it.`;
  const files = turn.changes.length ? `\n\nFiles it changed: ${turn.changes.map((c) => `\`${c.file}\``).join(', ')}` : '';
  return `${head}\n\n${blocksToMarkdown(turn.presentation?.blocks || [], turn).trim() || '_No report._'}${files}`;
}
