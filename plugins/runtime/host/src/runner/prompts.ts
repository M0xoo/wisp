// What a run is told (v1 runner.js #systemPrompt, workspaceNote, #mcpServers): the wisp protocol,
// the team for a lead, the side discussion's rules, the task's folders, and whatever plugins add
// through `runtime.prompt` (learned preferences, a crew job's note, a goal, spells) and
// `runtime.run` (connectors and wisp's own MCP server, extra folders, env).

import type { Json } from '@wisp/kernel';
import type { Harness, Session as ApiSession, Turn as ApiTurn } from '@wisp-plugin/runtime-api';
import { systemPrompt } from '../blocks/prompt.ts';
import type { ExtraBlock } from '../blocks/prompt.ts';
import type { Member, Mode, Session, Turn } from '../model.ts';
import { workdir } from '../model.ts';
import { setting } from '../rt.ts';
import type { Rt } from '../rt.ts';
import { sideNote } from '../side/prompt.ts';
import { AWAY_SUBAGENT, SUBAGENT_ASK, copies, teamNote } from '../subagents.ts';
import type { Engine } from './engine.ts';

const ASK = 'mcp__wisp__ask_user';
/** The delegate tool lives on the same injected server, so harnesses name it like ask_user. */
export const toolName = (askTool: string | null | undefined, name: string): string => (askTool ?? ASK).replace(/ask_user$/, name);

const api = (s: Session): ApiSession => s as unknown as ApiSession;

/** The mode a side discussion runs in: Edits behind the gate where wisp can ask before a write, else Plan. */
export const sideModeOf = (rt: Rt, agent: string): Mode => (rt.points.harness(agent)?.sideGate && rt.bridge ? 'edits' : 'plan');

/** A task with other folders gets their paths: that's where the work in them goes. */
export function workspaceNote(s: Session): string {
  const dirs = s.dirs ?? [];
  if (!dirs.length) return '';
  const lines = dirs.map((d) => `- \`${d}\``).join('\n');
  return `\n\n## Workspace\n\nThis task spans ${dirs.length + 1} folders. Besides your working directory (${workdir(s)}), you work in:\n${lines}\n\nRead and change files in all of them as the task needs, using absolute paths outside your working directory. Run each folder's commands (tests, builds) from inside that folder.`;
}

/** Block types plugins add, as the protocol lists them. */
function extraBlocks(rt: Rt): ExtraBlock[] {
  return rt.points
    .block()
    .filter((b) => typeof b.doc === 'string' && b.doc.trim())
    .map((b) => ({ type: b.type, doc: b.doc ?? '', spell: b.from ?? 'a plugin' }));
}

async function parts(rt: Rt, s: Session): Promise<string> {
  let out = '';
  for (const p of rt.points.prompt()) {
    try {
      out += await p.part(api(s));
    } catch (err) {
      rt.log.warn(`prompt part ${p.id} threw`, { error: (err as Error).message });
    }
  }
  return out;
}

/** The wisp protocol for this run: a lead hears about its team, a subagent that it can't ask. */
export async function systemPromptFor(e: Engine, s: Session, h: Harness, team: readonly Member[], plain: boolean): Promise<string> {
  const rt = e.rt;
  const sub = !!(s.parentId || s.delegated); // a delegate here, or one for a lead on another wisp
  const base = sub
    ? systemPrompt({ ask: SUBAGENT_ASK + (s.delegated ? AWAY_SUBAGENT : '') })
    : systemPrompt({ askTool: h.askTool, extraBlocks: extraBlocks(rt), apps: setting(rt, 'apps') !== 'off', watch: setting(rt, 'watch') !== 'off', blocks: !plain }) + teamNote(team, (id) => rt.points.harness(id), toolName(h.askTool, 'delegate'));
  const side = s.sideOf ? sideNote(s, h.askTool === null || !rt.bridge ? '' : toolName(h.askTool, 'wisp_session'), { edits: sideModeOf(rt, s.agent) === 'edits', name: h.name }) : '';
  return base + side + workspaceNote(s) + (await parts(rt, s));
}

/** Text plugins put ahead of this turn's prompt (a scheduled follow-up's note). */
export function prefixes(rt: Rt, s: Session, turn: Turn): string[] {
  const out: string[] = [];
  for (const p of rt.points.prompt()) {
    try {
      const t = p.prefix?.(api(s), turn as unknown as ApiTurn);
      if (t) out.push(t);
    } catch (err) {
      rt.log.warn(`prompt prefix ${p.id} threw`, { error: (err as Error).message });
    }
  }
  return out;
}

/** Text plugins put after the prompt (an @-mention of My Stuff). */
export function expansions(rt: Rt, s: Session, prompt: string, tools: boolean): string {
  let out = '';
  for (const p of rt.points.prompt()) {
    try {
      out += p.expand?.(prompt, api(s), { tools }) ?? '';
    } catch (err) {
      rt.log.warn(`prompt expand ${p.id} threw`, { error: (err as Error).message });
    }
  }
  return out;
}

/** How a lead's roster is handed to wisp's MCP server (v1 WISP_TEAM). */
export function teamJson(rt: Rt, team: readonly Member[]): Json[] {
  return team.map((m) => ({
    name: m.name,
    agent: m.crew ? `${m.label || m.name} of the user's crew${m.role ? `, ${m.role}` : ''}` : (rt.points.harness(m.agent)?.name ?? m.agent),
    model: m.crew ? 'own folder and memory' : m.model,
    effort: m.effort,
    use: m.use ?? '',
    count: m.count ?? 1,
    copies: copies(m),
    ...(m.machine && { place: m.place || 'another machine' }),
  }));
}

/** MCP servers, folders and env from `runtime.run` contributions (connectors, wisp's tools, a crew job's skills). */
export function runParts(e: Engine, s: Session, h: Harness, team: readonly Member[], mode: Mode, turnId: string): { mcpServers: Record<string, Json>; dirs: string[]; env: Record<string, string> } {
  const rt = e.rt;
  const sub = !!(s.parentId || s.delegated);
  const out = { mcpServers: {} as Record<string, Json>, dirs: [] as string[], env: {} as Record<string, string> };
  for (const p of rt.points.run()) {
    try {
      if (h.askTool !== null && p.mcpServers) Object.assign(out.mcpServers, p.mcpServers(api(s), { mode: s.sideOf ? 'plan' : mode, harness: h.id, team: teamJson(rt, team), turnId, sub }));
      if (p.dirs) out.dirs.push(...p.dirs(api(s)));
      if (p.env) Object.assign(out.env, p.env(api(s)));
    } catch (err) {
      rt.log.warn(`run part ${p.id} threw`, { error: (err as Error).message });
    }
  }
  return out;
}
