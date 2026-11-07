// `wisp crew …`: list the crew, and share members as .crew.json files (the crew plugin's /api/crew routes).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CrewMember } from '../client.ts';
import type { Ctx } from './context.ts';
import type { Api } from './scripted.ts';

interface ImportReview {
  spell?: unknown;
  members: Array<{ key: string; notes: string[] }>;
}
interface Imported {
  members: Array<{ name: string; role?: string }>;
}
interface Exported {
  notes: string[];
  gist?: { url: string; ref: string };
  bundle?: unknown;
}

const memberLine = (m: CrewMember): string => `${m.paused ? '○' : '●'} ${m.name.padEnd(24)} ${(m.role || '').padEnd(20)} ${m.cron || 'on call'}${m.spell ? `  (spell: ${m.spell.name})` : ''}`;

export async function crewCommand(ctx: Ctx, api: Api, [sub = 'ls', ...rest]: string[]): Promise<void> {
  switch (sub) {
    case 'ls':
    case 'list': {
      const list = await api.wisp.crew();
      return ctx.out(list, list.map(memberLine).join('\n') || 'No crew yet. Add someone in wisp, or import a shared one: wisp crew import scout.crew.json');
    }
    case 'import':
      return importCrew(ctx, api, rest);
    case 'export': {
      const f = ctx.flags;
      const r = await api.wisp.exportCrew<Exported>({ ids: rest, kit: f.kit, notebook: f.notebook, team: f.team, gist: f.gist });
      for (const n of r.notes) console.error(`  · ${n}`);
      if (r.gist) return ctx.out(r, `  ✓ secret gist: ${r.gist.url}\n  Share it as ${r.gist.ref}: they run  wisp crew import ${r.gist.ref}`);
      return console.log(JSON.stringify(r.bundle, null, 2));
    }
    default:
      ctx.die(`unknown: wisp crew ${sub} (ls, import, export)`);
  }
}

async function importCrew(ctx: Ctx, api: Api, rest: string[]): Promise<void> {
  const src = ctx.need(rest[0], 'a .crew.json file or a link');
  const body = /^(https:\/\/|gist:)/i.test(src) ? { url: src } : { text: await readFile(path.resolve(src), 'utf8') };
  const review = await api.wisp.importCrew<ImportReview>({ ...body, dryRun: true });
  if (review.spell) ctx.die('That is a spell: wisp spell install ' + src);
  // Every member lands in this folder (--cwd), paused.
  const r = await api.wisp.importCrew<Imported>({ ...body, choices: Object.fromEntries(review.members.map((m) => [m.key, { cwd: ctx.cwd }])) });
  const notes = review.members.flatMap((m) => m.notes);
  return ctx.out(r, [...r.members.map((m) => `  ✓ added ${m.name}${m.role ? ` · ${m.role}` : ''}, paused`), ...notes.map((n) => `    · ${n}`), `  Resume them in wisp to start.`].join('\n'));
}
