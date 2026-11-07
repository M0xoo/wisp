// The Make a plugin agent's tools (v1 routes/internal.js: wisp_spells, wisp_spell_schema,
// wisp_spell_data, wisp_spell_check), at their v1 paths and under new names. The edge resolves the
// task's token before these run: `caller.session` is the task it speaks for, and only that task, a
// Make a plugin one, may use them. Not public API (doc: false).

import type { HttpRequestContext, HttpService } from '@wisp/kernel';
import type { Session } from '@wisp-plugin/runtime-api';
import { EXT } from '@wisp-plugin/plugins-api';
import type { Manager } from './manager.ts';
import { answer } from './routes.ts';
import { ghProblem, wispPathProblem } from './schema.ts';
import { spellReference } from './guide.ts';
import { messageOf } from './errors.ts';

export interface InternalDeps {
  m: Manager;
  session(id: string): Promise<Session | undefined>;
}

type Json200 = { status: number; json: unknown };
type Tool = (req: HttpRequestContext, s: Session) => Promise<Json200> | Json200;

const asObj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const text = (t: string): Json200 => ({ status: 200, json: { text: t } });
export const isMake = (s: Pick<Session, 'ext'>): boolean => asObj(s.ext?.[EXT])['make'] === true;

function guard(d: InternalDeps, fn: Tool): (req: HttpRequestContext) => Promise<Json200> {
  return async (req) => {
    const id = req.params['id'] ?? '';
    if (req.caller.session !== id) return { status: 403, json: { error: 'bad token' } };
    const s = await d.session(id);
    if (!s) return { status: 404, json: { error: 'no such session' } };
    if (!isMake(s)) return { status: 403, json: { error: 'only a Make a plugin task can use this' } };
    return fn(req, s);
  };
}

function mine(m: Manager): Json200 {
  const { spells } = m.spells.list();
  const one = (x: (typeof spells)[number]): string => [`### ${x.name} (\`${x.id}\` v${x.version}, ${x.enabled ? 'on' : 'off'})`, ...x.summary.map((l) => `- ${l}`), '', '```json', JSON.stringify(m.spells.exported(x.id), null, 2), '```'].join('\n');
  return text(spells.length ? spells.map(one).join('\n\n') : 'The user has no spells yet.');
}

async function sample(m: Manager, req: HttpRequestContext): Promise<Json200> {
  const { source, task } = asObj(await req.body());
  const src = asObj(source);
  const problem = src['wisp'] !== undefined ? wispPathProblem(src['wisp']) : src['gh'] !== undefined ? ghProblem(src['gh']) : 'source is { "wisp": "/path" } or { "gh": [args] }';
  if (problem) return text(`Not allowed: ${problem}`);
  try {
    const spell = { id: `check-${req.params['id'] ?? ''}`, name: 'sample', data: { sample: { ...src, refresh: 10 } } };
    const value = await m.data(spell as never, 'sample', { session: task, fresh: true });
    const json = JSON.stringify(value, null, 1);
    return text(json.length > 12_000 ? `${json.slice(0, 12_000)}\n… (cut; ${json.length} characters in all)` : json);
  } catch (err) {
    return text(`The source failed: ${messageOf(err)}`);
  }
}

async function check(m: Manager, req: HttpRequestContext): Promise<Json200> {
  const { spell } = asObj(await req.body());
  try {
    const { spell: n, warnings } = m.check(spell);
    const d = m.describe(n);
    const was = m.spells.get(n.id);
    return text(
      [
        `ok — “${n.name}” (${d.kind}) would:`,
        ...d.lines.map((l) => `- ${l}`),
        ...(warnings.length ? ['', 'Warnings:', ...warnings.map((w) => `- ${w}`)] : []),
        ...(was ? ['', `The user already has \`${n.id}\` v${was.version}; yours replaces it${n.version === was.version ? ' (bump version)' : ''}.`] : []),
        '',
        'End your report with {"type":"spell","spell":{…}} holding exactly this spell.',
      ].join('\n'),
    );
  } catch (err) {
    const problems = (err as { problems?: readonly string[] }).problems;
    return text(problems ? `Not ok. Fix:\n${problems.map((p) => `- ${p}`).join('\n')}` : `Not ok: ${messageOf(err)}`);
  }
}

export function registerInternal(http: Pick<HttpService, 'route'>, d: InternalDeps): void {
  const opts = (summary: string) => ({ permission: 'plugins:read', summary, doc: false });
  const tools: [string, string, string, Tool][] = [
    ['GET', 'spells', 'The user’s plugins, for the Make a plugin agent', () => mine(d.m)],
    ['GET', 'spell-schema', 'The plugin reference, for the Make a plugin agent', () => text(JSON.stringify(spellReference(d.m.vocab()), null, 1))],
    ['POST', 'spell-data', 'A data source’s real shape, for the Make a plugin agent', (req) => sample(d.m, req)],
    ['POST', 'spell-check', 'Check a plugin, for the Make a plugin agent', (req) => check(d.m, req)],
  ];
  const aliases: Readonly<Record<string, string>> = { spells: 'plugins', 'spell-schema': 'plugin-schema', 'spell-data': 'plugin-data', 'spell-check': 'plugin-check' };
  for (const [method, name, summary, fn] of tools) {
    const h = answer(guard(d, fn));
    http.route(method, `/internal/${name}/:id`, h, opts(summary));
    http.route(method, `/internal/${aliases[name] ?? name}/:id`, h, opts(summary));
  }
}
