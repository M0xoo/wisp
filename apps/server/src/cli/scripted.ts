// `wisp ls | show | wait | reply | btw | stop | ship | merge | run | recipes | usage`, and a launch with
// --json, --wait or --try: commands that only talk to the API (and start a headless wisp if none runs).
import { LS_STATES } from './args.ts';
import type { Ctx } from './context.ts';
import { WispClient } from '../client.ts';
import type { Btw, Launched, TryChange, Usage, UsageRow, WaitResult } from '../client.ts';

export type Scripted = 'launch' | 'ls' | 'list' | 'show' | 'wait' | 'reply' | 'btw' | 'stop' | 'ship' | 'merge' | 'recipes' | 'run' | 'usage' | 'spell' | 'spells' | 'crew' | 'computer';

/** What a subcommand needs besides the context: the client, and how to print a session. */
export interface Api {
  wisp: WispClient;
  show(id: string, summary?: WaitResult): Promise<void>;
}

export async function scripted(ctx: Ctx, cmd: Scripted, args: string[], tried: TryChange | null): Promise<void> {
  const wisp = await WispClient.connect({ port: ctx.flags.portGiven ? ctx.flags.port : undefined });
  const api: Api = { wisp, show: (id, summary) => show(ctx, wisp, id, summary) };
  switch (cmd) {
    case 'spell':
    case 'spells':
      return (await import('./spell.ts')).spellCommand(ctx, api, args);
    case 'crew':
      return (await import('./crew.ts')).crewCommand(ctx, api, args);
    case 'computer':
      return (await import('./computer.ts')).computerCommand(ctx, api, args);
    default:
      return session(ctx, api, cmd, args, tried);
  }
}

async function show(ctx: Ctx, wisp: WispClient, id: string, summary?: WaitResult): Promise<void> {
  const p = await wisp.presentation(id);
  const s = summary ?? (await wisp.sessions()).find((x) => x.id === id);
  ctx.out({ ...s, presentation: p }, `◌ ${s?.title}  [${s?.state}${summary?.timedOut ? ', still running' : ''}]  ${id}\n\n${p.markdown}`);
}

function btwLine(ctx: Ctx, b: Btw): void {
  ctx.out(b, b.status === 'done' ? (b.answer ?? '') : b.status === 'running' ? '  … still answering; it will show on the card' : `  ! ${b.error}`);
}

/** The harness, mode, model and effort flags, as the API takes them (unset stays unset). */
export function runFlags(ctx: Ctx): { agent?: string | undefined; mode?: string | undefined; model?: string | undefined; effort?: string | undefined } {
  const f = ctx.flags;
  return { agent: f.agent || undefined, mode: f.mode || undefined, model: f.model ?? undefined, effort: f.effort ?? undefined };
}

/** After a launch: its id, or with --wait the session once it needs you. */
export async function launched(ctx: Ctx, api: Api, s: Launched): Promise<void> {
  if (!ctx.flags.wait) return ctx.out(s, `  ◌ launched: ${s.title}  (${s.id})`);
  if (!ctx.flags.json) console.error(`  ◌ launched: ${s.title}  (${s.id}) — waiting…`);
  return api.show(s.id, await api.wisp.wait(s.id));
}

async function launch(ctx: Ctx, api: Api, args: string[], tried: TryChange | null): Promise<void> {
  const f = ctx.flags;
  const run = runFlags(ctx);
  const compare = tried ? [{ agent: f.agent, model: run.model, effort: run.effort, ...tried }] : f.compare || undefined;
  const s = await api.wisp.launch({ prompt: args.join(' '), cwd: ctx.cwd, also: f.also, ...run, worktree: f.worktree, compare, trial: tried ? true : undefined, confirmLimit: f.yes || undefined });
  if (s.group && !f.wait) return ctx.out(s, s.group.map((x) => `  ◌ launched on ${x.agent}: ${x.title}  (${x.id})`).join('\n'));
  return launched(ctx, api, s);
}

async function list(ctx: Ctx, api: Api): Promise<void> {
  const f = ctx.flags;
  // The page's Needs you is review + waiting; an unknown state would just print nothing.
  const states = f.state ? [...new Set(f.state.split(',').flatMap((x) => (x === 'needs' ? ['review', 'waiting'] : [x.trim()])).filter(Boolean))] : null;
  const bad = states?.filter((x) => !(LS_STATES as readonly string[]).includes(x)) ?? [];
  if (bad.length) ctx.die(`unknown state ${bad.join(', ')}: use ${LS_STATES.join(', ')} or needs (review + waiting)`);
  // Like the page, archived tasks are hidden unless --all (an archived review isn't waiting on you).
  const rows = await api.wisp.sessions({ state: states?.join(','), limit: f.limit, cwd: f.cwd || undefined, archived: f.all ? undefined : false });
  const line = (s: (typeof rows)[number]): string => `${s.id}  ${s.state.padEnd(7)}  ${s.agent.padEnd(8)}  ${s.project.padEnd(16).slice(0, 16)}  ${s.title}${s.question ? `  — asks: ${s.question}` : ''}`;
  ctx.out(rows, rows.map(line).join('\n') || 'No sessions.');
}

async function reply(ctx: Ctx, api: Api, args: string[]): Promise<void> {
  const id = ctx.need(args[0], 'session id');
  const r = await api.wisp.reply(id, ctx.need(args.slice(1).join(' ').trim(), 'text'), { queue: ctx.flags.queue, ...runFlags(ctx), confirmLimit: ctx.flags.yes || undefined });
  if (r.btw) return btwLine(ctx, await api.wisp.btwAnswer(id, r.btw.id)); // "/btw …": a side question
  if (!ctx.flags.wait) return ctx.out(r, r.answered ? '  ✓ answered' : r.interrupted ? '  ✓ interrupted; resuming with your message' : r.queued ? '  ✓ queued' : '  ✓ sent');
  return api.show(id, await api.wisp.wait(id));
}

async function runRecipe(ctx: Ctx, api: Api, args: string[]): Promise<void> {
  const key = ctx.need(args[0], 'recipe name');
  const pair = /^[a-zA-Z][\w-]*=/;
  const params = Object.fromEntries(args.slice(1).filter((a) => pair.test(a)).map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
  const words = args.slice(1).filter((a) => !pair.test(a));
  const s = await api.wisp.runRecipe(key, { params, words, cwd: ctx.cwd, ...runFlags(ctx) }).catch((err: unknown) => {
    if (!(err && typeof err === 'object' && 'status' in err && err.status === 404)) throw err;
    // No recipe by that name: `wisp run the tests` is a task.
    return api.wisp.launch({ prompt: ['run', ...args].join(' '), cwd: ctx.cwd, ...runFlags(ctx), worktree: ctx.flags.worktree });
  });
  return launched(ctx, api, s);
}

const money = (v: number): string => `$${v.toFixed(2)}`;
const pct = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`);

export function usageText(u: Usage): string {
  const rows = <T extends UsageRow>(list: T[], label: (x: T) => string): string =>
    list.map((x) => `  ${label(x).padEnd(32).slice(0, 32)}  ${money(x.cost).padStart(8)}  ${String(x.turns).padStart(5)} turns  ${pct(x.successRate).padStart(4)} ok`).join('\n');
  return `Last ${u.days} days: ${money(u.total.cost)} · ${u.total.turns} turns in ${u.total.sessions} sessions · ${pct(u.total.successRate)} worked · ${u.total.questions} questions\n\nBy project\n${rows(u.projects, (x) => x.name)}\n\nBy harness · model\n${rows(u.runners, (x) => `${x.agent} · ${x.model || 'default'}`)}`;
}

async function session(ctx: Ctx, api: Api, cmd: Scripted, args: string[], tried: TryChange | null): Promise<void> {
  const { wisp } = api;
  const id = (): string => ctx.need(args[0], 'session id');
  switch (cmd) {
    case 'launch':
      return launch(ctx, api, args, tried);
    case 'ls':
    case 'list':
      return list(ctx, api);
    case 'show':
      return api.show(id());
    case 'wait':
      return api.show(id(), await wisp.wait(id()));
    case 'reply':
      return reply(ctx, api, args);
    case 'btw':
      return btwLine(ctx, await wisp.btw(id(), ctx.need(args.slice(1).join(' ').trim(), 'question')));
    case 'stop':
      return ctx.out(await wisp.stop(id()), '  ✓ stopped');
    case 'ship': {
      const pr = await wisp.ship(id(), { draft: ctx.flags.draft });
      return ctx.out(pr, `  ✓ PR #${pr.number}${pr.draft ? ' (draft)' : ''}: ${pr.url}`);
    }
    case 'merge': {
      const r = await wisp.merge(id());
      return ctx.out(r, `  ✓ merged PR #${r.pr.number}\n  ${r.sync.ok ? '✓' : '!'} ${r.sync.text}`);
    }
    case 'recipes': {
      const rows = await wisp.recipes();
      return ctx.out(rows, rows.map((r) => `${r.name.padEnd(24)}  ${r.params.map((p) => `{${p}}`).join(' ').padEnd(20)}  ${r.prompt.replace(/\s+/g, ' ').slice(0, 60)}`).join('\n') || 'No recipes yet. Save one from wisp (⌘K → Recipes).');
    }
    case 'run':
      return runRecipe(ctx, api, args);
    case 'usage': {
      const u = await wisp.usage({ days: ctx.flags.days || 30 });
      return ctx.out(u, usageText(u));
    }
  }
}
