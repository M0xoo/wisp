// `wisp spell …`: list, cast, install, turn on/off, remove and export spells (v1 routes/spells.js; in v2
// spells are plugins, and the edge keeps v1's /api/spells routes for this and older clients).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Ctx } from './context.ts';
import { runFlags, type Api } from './scripted.ts';

interface Spell {
  id: string;
  name: string;
  version: string;
  kind: string;
  enabled: boolean;
  description?: string;
}
interface SpellList {
  safe?: boolean;
  spells: Spell[];
  broken: Array<{ id: string; error: string }>;
}
interface SpellCheck {
  ok: boolean;
  problems: string[];
  summary: string[];
}

const line = (s: Spell): string => `${s.enabled ? '●' : '○'} ${s.id.padEnd(24)} ${`v${s.version}`.padEnd(8)} ${s.kind.padEnd(5)}  ${s.name}${s.description ? ` — ${s.description}` : ''}`;

export async function spellCommand(ctx: Ctx, api: Api, [sub = 'ls', ...rest]: string[]): Promise<void> {
  const req = <T>(method: string, p: string, body?: object): Promise<T> => api.wisp.request<T>(method, p, body);
  const id = (): string => encodeURIComponent(ctx.need(rest[0], 'spell id'));
  switch (sub) {
    case 'ls':
    case 'list': {
      const r = await req<SpellList>('GET', '/spells');
      const text = [r.safe ? '! safe mode: every spell is off' : '', ...r.spells.map(line), ...r.broken.map((b) => `! ${b.id}: ${b.error}`)].filter(Boolean).join('\n');
      return ctx.out(r, text || 'No spells yet. Cast one: wisp spell cast "a floating button that opens my PRs"');
    }
    case 'cast':
      return cast(ctx, api, rest);
    case 'install':
    case 'add':
      return install(ctx, api, rest);
    case 'on':
    case 'off': {
      if (sub === 'off' && ctx.flags.all) return ctx.out(await req('POST', '/spells/off', {}), '  ✓ every spell is off');
      const r = await req<Spell>('PATCH', `/spells/${id()}`, { enabled: sub === 'on' });
      return ctx.out(r, `  ✓ ${r.name} is ${r.enabled ? 'on' : 'off'}`);
    }
    case 'rm':
    case 'remove':
      return ctx.out(await req('DELETE', `/spells/${id()}`, {}), '  ✓ removed');
    case 'export':
      return console.log(JSON.stringify(await req('GET', `/spells/${id()}/export`), null, 2));
    default:
      ctx.die(`unknown: wisp spell ${sub} (ls, cast, install, on, off, rm, export)`);
  }
}

async function cast(ctx: Ctx, api: Api, rest: string[]): Promise<void> {
  const { agent, model, effort } = runFlags(ctx);
  const s = await api.wisp.launch({ prompt: ctx.need(rest.join(' ').trim(), 'what to change'), kind: 'spell', agent, model, effort });
  if (!ctx.flags.wait) return ctx.out(s, `  🧙 casting: ${s.title}  (${s.id})\n  Try it and keep it from its card in wisp.`);
  if (!ctx.flags.json) console.error(`  🧙 casting: ${s.title}  (${s.id}) — waiting…`);
  return api.show(s.id, await api.wisp.wait(s.id));
}

async function install(ctx: Ctx, api: Api, rest: string[]): Promise<void> {
  const src = ctx.need(rest[0], 'a .spell.json file or a link');
  const body = /^(https:\/\/|gist:)/i.test(src) ? { url: src } : { text: await readFile(path.resolve(src), 'utf8'), name: path.basename(src) };
  const check = await api.wisp.request<SpellCheck>('POST', '/spells/check', body);
  if (!check.ok) ctx.die(`That spell has problems:\n- ${check.problems.join('\n- ')}`);
  const r = await api.wisp.request<{ updated?: boolean; spell: Spell }>('POST', '/spells', { ...body, enable: ctx.flags.on });
  const head = `  ✓ ${r.updated ? 'updated' : 'added'} ${r.spell.name} (${r.spell.id} v${r.spell.version}, ${r.spell.kind})${r.spell.enabled ? ', on' : ' — off; turn it on with: wisp spell on ' + r.spell.id}`;
  return ctx.out(r, [head, ...check.summary.map((l) => `    · ${l}`)].join('\n'));
}
