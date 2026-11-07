// What a spell does, in plain words, with the riskiest kind it reaches (v1 describeSpell): the
// review dialog's lines and badge, the Make a plugin agent's check, Settings → Plugins' summary.

import type { Risk, Section } from '@wisp-plugin/plugins-api';
import { ACTIONS, clip } from './schema.ts';
import type { Action, Spell } from './types.ts';

const RANK: Readonly<Record<Risk, number>> = { safe: 0, acts: 1, reads: 2, runs: 3 };
const ON_WORDS: Readonly<Record<string, string>> = { finished: 'when a task finishes', done: 'when a task is marked done', ci: 'when CI fails' };
const MODE_WORDS: Readonly<Record<string, string>> = { plan: 'Plan', edits: 'Edits', auto: 'Full auto' };
const WHERE: Readonly<Record<string, string>> = {
  topbar: 'A top bar button', float: 'A floating button', palette: 'A ⌘K item', 'launcher.bar': 'A prompt box button', 'launcher.chips': 'A chip under the prompt box',
  'composer.bar': 'A follow-up box button', 'composer.chips': 'A quick reply above the follow-up box', 'card.head': "A chip in each card's head", 'card.hover': 'A card button (on hover)',
  'card.menu': "An item in each card's menu", 'term.head': "A button in a task's terminal", 'panel.head': "A button in the side panel's head", 'crew.page': "A button on each crew member's page",
  'org.head': 'A button on the Org page', 'plan.head': "A button on a scheduled task's page", 'stuff.head': 'A button on My Stuff', 'machine.head': 'A button on This Mac',
};

type Words = (v: unknown, s: Spell) => string;
const o = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const on = (v: unknown): string => (o(v)['agent'] ? ` on ${String(o(v)['agent'])}` : '');
const ACT_WORDS: Readonly<Record<string, Words>> = {
  open: (v) => `opens ${String(v)}`,
  openAll: (v) => (o(v)['data'] ? `opens every link in ${String(o(v)['data'])}` : `opens the links ${String(o(v)['fn'])}() returns`),
  panel: (v, s) => `opens the “${(s.panels ?? []).find((x) => x.id === v)?.title || String(v)}” panel`,
  insert: (v) => `types “${clip(v, 50)}” into the box`,
  copy: (v) => `copies “${clip(v, 40)}”`,
  toast: () => 'shows a message',
  setLaunch: (v) => `sets the prompt box to ${Object.values(o(v)).filter(Boolean).join(' · ')}`,
  send: (v) => `sends “${clip(v, 50)}” to the task`,
  reply: (v) => `replies “${clip(v, 50)}” to the task`,
  launchWith: (v) => `launches with ${Object.entries(o(v)).filter(([k, x]) => x && k !== 'text').map(([, x]) => String(x)).join(' · ')}`,
  launch: (v) => `starts a task: “${clip(o(v)['prompt'], 50)}”`,
  fork: (v) => `forks the task to “${clip(o(v)['prompt'], 50)}”${on(v)}`,
  side: (v) => `starts a side discussion: “${clip(o(v)['prompt'], 50)}”${on(v)}`,
  rerun: (v) => `reruns the task on ${[o(v)['agent'], o(v)['model'], o(v)['mode']].filter(Boolean).join(' · ') || 'another harness'}`,
  recipe: (v) => `runs the recipe ${String(v)}`,
  ship: () => 'opens Ship it',
  done: () => 'marks the task done',
  archive: () => 'archives the task',
  forLater: () => 'saves the task for later',
  compact: () => 'compacts the task',
  notify: () => 'notifies you',
  webhook: (v) => `POSTs the task to ${String(v)}`,
  exec: (v) => `runs \`${clip(v, 60)}\``,
};

const cards = (w: Record<string, unknown> | undefined): string => (w ? ` (cards ${Object.entries(w).map(([k, v]) => `${k}: ${String(v)}`).join(', ')})` : '');

/** A crew member's line when wisp.crew isn't on to say it (v1 had cronWords; the raw cron here). */
function crewLine(b: Record<string, unknown>): { line: string; risk: Risk } {
  const onList = Array.isArray(b['on']) ? b['on'].map(String) : [];
  const kit = Array.isArray(b['kit']) ? b['kit'].length : 0;
  const mode = String(b['mode'] ?? 'plan');
  const when = [b['cron'] ? `on \`${String(b['cron'])}\`` : '', ...onList.map((k) => ON_WORDS[k] ?? k)].filter(Boolean).join(', ') || 'only when asked';
  const role = b['role'] ? ` · ${String(b['role'])}` : '';
  const kits = kit ? `, with ${kit} skill${kit > 1 ? 's and instructions files' : ' or instructions file'}` : '';
  // A member that starts jobs on its own (a schedule, events) or works in Full auto can run commands.
  return { line: `A crew member, ${String(b['name'])}${role}: works ${when}, in ${MODE_WORDS[mode] ?? mode} mode${kits}. Joins paused`, risk: b['cron'] || onList.length || mode === 'auto' ? 'runs' : 'acts' };
}

function uiLines(s: Spell, act: (a: Action | null | undefined) => string, lines: string[]): void {
  for (const b of s.buttons ?? []) lines.push(`${WHERE[b.slot] ?? b.slot} “${b.label || b.icon}”${cards(b.when)} that ${act(b.do)}`);
  for (const c of s.chips ?? []) lines.push(`${WHERE[c.slot] ?? c.slot}${c.text ? ` showing “${c.text}”` : ''}${cards(c.when)}${c.do ? ` that ${act(c.do)}` : ''}`);
  for (const x of s.panels ?? []) lines.push(`A ${x.as === 'card' ? `panel in each card (${String(x.slot)})` : x.as === 'feed' ? 'panel on home' : x.as} “${x.title || x.id}”`);
  for (const b of s.blocks ?? []) lines.push(`A “${b.type}” block agents can use in their reports`);
  for (const [name, v] of Object.entries(s.parts ?? {})) {
    const style = v.style ? ` (${Object.keys(v.style).join(', ')})` : '';
    const props = v.props ? ` (${Object.entries(v.props).map(([k, x]) => `${k}: ${String(x)}`).join(', ')})` : '';
    lines.push(`Changes ${name}${style}${props}${v.order ? ` (order: ${v.order.join(', ')})` : ''}`);
  }
  if (s.ui?.hide?.length) lines.push(`Hides ${s.ui.hide.join(', ')}`);
  if (s.ui?.tokens || s.ui?.dark) lines.push(`Recolours wisp (${Object.keys({ ...s.ui.tokens, ...s.ui.dark }).join(', ')})`);
}

export function describeSpell(s: Spell, crew?: Section): { lines: string[]; kind: Risk } {
  const lines: string[] = [];
  let kind: Risk = 'safe';
  const bump = (k: Risk): void => void (RANK[k] > RANK[kind] && (kind = k));
  const act = (a: Action | null | undefined): string => {
    const first = a ? Object.entries(a)[0] : undefined;
    if (!first) return '';
    const [k, v] = first;
    bump(ACTIONS[k]?.kind ?? 'safe');
    const words = ACT_WORDS[k];
    return words ? words(v, s) : k;
  };
  uiLines(s, act, lines);
  for (const r of s.prompt ?? []) lines.push(`Tells ${r.when?.agent ? r.when.agent.join('/') : 'every'} agent${r.when?.project ? ` in ${r.when.project.join(', ')}` : ''}: “${clip(r.text, 90)}”`);
  if (s.settings) lines.push(`Sets ${Object.entries(s.settings).map(([k, v]) => `${k} = ${String(v)}`).join(', ')} while it's on`);
  for (const x of s.slash ?? []) lines.push(`/${x.name} ${x.args ? `<${x.args}> ` : ''}that ${act(x.do)}`);
  for (const x of s.commands ?? []) lines.push(`⌘K “${x.label}” that ${act(x.do)}`);
  for (const h of s.hooks ?? []) {
    bump('acts');
    const cond = Object.keys(h.if).length ? ` (${Object.entries(h.if).map(([k, v]) => `${k}: ${String(v)}`).join(', ')})` : '';
    lines.push(`On its own, when ${h.on.replace('.', ' ')}${cond}: ${act(h.do)}, at most ${h.max}× per task`);
  }
  for (const r of s.recipes ?? []) lines.push(`A recipe “${r.name}”`);
  for (const b of s.crew ?? []) {
    const d = crew?.describe?.(b as never) ?? crewLine(b as Record<string, unknown>);
    bump(d.risk);
    lines.push(d.line);
  }
  for (const d of Object.values(s.data ?? {})) {
    if ('gh' in d) bump('reads');
    lines.push('gh' in d ? `Reads GitHub: \`gh ${d.gh.join(' ')}\`` : `Reads wisp's ${d.wisp}`);
  }
  return { lines, kind };
}
