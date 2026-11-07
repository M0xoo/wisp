// Presentation → plain markdown (v1 server/render.js), for places that can't run the web UI: the CLI,
// MCP clients, webhooks, chat apps, a lead reading its delegates' reports. Lossy by design (no
// animation, no syntax colours), never throws: a block that can't be rendered renders as nothing.
// Output is byte for byte v1's (test/goldens/blocks-real.md pins it).

import type { Change, Edit, Session, Turn } from '../model.ts';
import { diffLines, hunks } from './diff.ts';
import { mapPlaces, openUrl, routeUrl } from './map-spec.ts';

type Obj = Record<string, unknown>;
/** a contributed block type's text stand-in: its `summary` template ("{title}: {count} rows") */
export type ExtraBlock = (type: string) => { summary?: string } | null | undefined;
type Render = (b: Obj, turn: Turn | null, extra: ExtraBlock | undefined) => string;

const STATUS: Record<string, string> = { done: '✅ Done', partial: '🟡 Partly done', blocked: '⛔ Blocked', info: 'ℹ️ Report' };
const CHANGE: Record<string, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
const own = (rec: Record<string, string>, k: unknown): string | undefined => (typeof k === 'string' && Object.hasOwn(rec, k) ? rec[k] : undefined);

const fence = (text: unknown, lang = ''): string => {
  const s = String(text ?? '');
  const ticks = '`'.repeat(Math.max(3, ...[...s.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${ticks}${lang}\n${s.replace(/\n$/, '')}\n${ticks}`;
};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));
/** an item read the way v1 read it: null or undefined throws (the block renders as nothing), a primitive has no fields */
const o = (v: unknown): Obj => {
  if (v === null || v === undefined) throw new TypeError(`Cannot read properties of ${String(v)}`);
  return typeof v === 'object' ? (v as Obj) : {};
};
/** v1's `v?.k` */
const prop = (v: unknown, k: string): unknown => (typeof v === 'object' && v !== null ? (v as Obj)[k] : undefined);
/** v1's array destructuring: strings and arrays spread, anything else throws */
const spread = (v: unknown): unknown[] => [...(v as Iterable<unknown>)];

function findChange(turn: Turn | null, file: string): Change | null | undefined {
  if (!file || !turn?.changes) return null;
  return turn.changes.find((c) => c.file === file) || turn.changes.find((c) => c.file.endsWith('/' + file) || file.endsWith('/' + c.file));
}

function unified(edits: readonly Edit[]): string {
  return edits
    .map((e) =>
      hunks(diffLines(str(e.before), str(e.after)), 3)
        .map((h) => (h.op === '…' ? `@@ ${h.count} unchanged line${h.count > 1 ? 's' : ''} @@` : `${h.op}${h.text}`))
        .join('\n'),
    )
    .join('\n@@ … @@\n');
}

const titled = (b: Obj): string => (b['title'] ? `**${str(b['title'])}**\n\n` : '');

const R: Record<string, Render> = {
  hero: (b) => `## ${str(b['title']) || 'Done'}\n\n**${own(STATUS, b['status']) || STATUS['done']}**${b['summary'] ? ` — ${str(b['summary'])}` : ''}`,
  markdown: (b) => str(b['text']),
  steps: (b) =>
    `${titled(b)}${list(b['items'])
      .map((s, i) => {
        const x = o(s);
        return `${i + 1}. ${x['status'] === 'failed' ? '❌' : x['status'] === 'skipped' ? '⏭️' : '✔︎'} **${str(x['title'])}**${x['detail'] ? ` — ${str(x['detail'])}` : ''}`;
      })
      .join('\n')}`,
  stats: (b) =>
    list(b['items'])
      .map((s) => {
        const x = o(s);
        return `- **${str(x['label'])}:** ${str(x['value'])}${str(x['unit'])}${x['delta'] ? ` (${str(x['delta'])})` : ''}`;
      })
      .join('\n'),
  files: (b) =>
    list(b['items'])
      .map((f) => {
        const x = o(f);
        return `- \`${own(CHANGE, x['change']) || 'M'}\` \`${str(x['path'])}\`${x['note'] ? ` — ${str(x['note'])}` : ''}`;
      })
      .join('\n'),
  tree: (b) =>
    `${titled(b)}${list(b['items'])
      .map((f) => {
        const x = o(f);
        return `- \`${str(x['path'])}\`${x['change'] ? ` (${str(x['change'])})` : ''}${x['note'] ? ` — ${str(x['note'])}` : ''}`;
      })
      .join('\n')}`,
  diff: (b, turn) => {
    const file = str(b['file'] || b['path']);
    const edits: Edit[] | undefined = b['before'] !== undefined || b['after'] !== undefined ? [{ before: b['before'] as string, after: b['after'] as string }] : findChange(turn, file)?.edits;
    const head = `**\`${file}\`**${b['caption'] ? ` — ${str(b['caption'])}` : ''}`;
    return edits?.length ? `${head}\n\n${fence(unified(edits), 'diff')}` : `${head} _(no captured edits)_`;
  },
  code: (b) =>
    `${b['file'] ? `**\`${str(b['file'])}${b['line'] ? `:${str(b['line'])}` : ''}\`**${b['caption'] ? ` — ${str(b['caption'])}` : ''}\n\n` : b['caption'] ? `${str(b['caption'])}\n\n` : ''}${fence(b['code'], str(b['language']))}`,
  tests: (b) => {
    const n = (k: string): number => Number(b[k]) || 0;
    const head = `**Tests** \`${str(b['command'])}\` — ${n('passed')} passed, ${n('failed')} failed${n('skipped') ? `, ${n('skipped')} skipped` : ''}${b['durationMs'] ? ` (${(n('durationMs') / 1000).toFixed(1)}s)` : ''}`;
    const fails = list(b['failures']).map((f) => {
      const x = o(f);
      return `- ❌ ${str(x['name'])}${x['message'] ? `: ${str(x['message'])}` : ''}${x['file'] ? ` (\`${str(x['file'])}\`)` : ''}`;
    });
    return [head, ...fails].join('\n');
  },
  commits: (b) =>
    `${b['branch'] ? `**Branch** \`${str(b['branch'])}\`\n\n` : ''}${list(b['items'])
      .map((c) => {
        const x = o(c);
        return `- \`${str(x['hash']).slice(0, 7)}\` ${str(x['message'])}${x['additions'] !== undefined ? ` (+${String(x['additions'])}/−${str(x['deletions'] ?? 0)})` : ''}`;
      })
      .join('\n')}`,
  graph: (b) => graph(b),
  terminal: (b) => fence(`${b['command'] ? `$ ${str(b['command'])}\n` : ''}${str(b['output'])}${b['exitCode'] !== undefined && b['exitCode'] !== 0 ? `\n[exit ${String(b['exitCode'])}]` : ''}`, 'console'),
  compare: (b) =>
    ['before', 'after']
      .map((k) => `**${str(prop(b[k], 'label')) || (k === 'before' ? 'Before' : 'After')}**\n${list(prop(b[k], 'items')).map((i) => `- ${str(i)}`).join('\n')}`)
      .join('\n\n'),
  flow: (b) => {
    const nodes = list(b['nodes']);
    const label = (id: unknown): unknown => prop(nodes.find((n) => o(n)['id'] === id), 'label') || id;
    const edges = list(b['edges']).length ? list(b['edges']) : nodes.slice(1).map((n, i) => [o(nodes[i])['id'], o(n)['id']]);
    return `${titled(b)}${edges
      .map((e) => {
        const [a, z, l] = spread(e);
        return `- ${String(label(a))} → ${String(label(z))}${l ? ` _(${str(l)})_` : ''}`;
      })
      .join('\n')}`;
  },
  chart: (b) =>
    `${titled(b)}${list(b['items'])
      .map((i) => {
        const x = o(i);
        return `- ${str(x['label'])}: ${str(x['value'])}${str(b['unit'])}`;
      })
      .join('\n')}`,
  checklist: (b) => `${titled(b)}${list(b['items']).map((i) => `- [${o(i)['done'] ? 'x' : ' '}] ${str(o(i)['text'])}`).join('\n')}`,
  callout: (b) =>
    `> **${b['tone'] === 'danger' ? '⛔' : b['tone'] === 'warn' ? '⚠️' : b['tone'] === 'success' ? '✅' : 'ℹ️'} ${str(b['title'])}**\n> ${str(b['text']).replace(/\n/g, '\n> ')}`,
  image: (b) => `🖼️ \`${str(b['path'] || b['src'])}\`${b['caption'] ? ` — ${str(b['caption'])}` : ''}`,
  preview: (b) => `🌐 ${str(b['url'])}${b['device'] ? ` (${str(b['device'])})` : ''}${b['caption'] || b['title'] ? ` — ${str(b['caption'] || b['title'])}` : ''}`,
  video: (b) => `🎬 \`${str(b['path'] || b['src'])}\`${b['caption'] ? ` — ${str(b['caption'])}` : ''}`,
  map: (b) => {
    const ps = mapPlaces(b);
    const route = b['route'] && routeUrl(ps);
    return `**📍 ${str(b['title']) || 'Places'}**${route ? ` · [Route](${route})` : ''}\n${ps
      .map((p, i) => `${i + 1}. ${p.name ? `**${p.name}** — ` : ''}[${p.address || p.q}](${openUrl(p)})${p.note ? ` — ${p.note}` : ''}`)
      .join('\n')}${b['caption'] ? `\n\n${str(b['caption'])}` : ''}`;
  },
  doc: (b) =>
    `📄 **${str(b['title']) || `\`${str(b['path'])}\``}**${b['title'] && b['path'] ? ` \`${str(b['path'])}\`` : ''}${b['caption'] ? ` — ${str(b['caption'])}` : ''}${b['text'] ? `\n\n<details><summary>Show the file</summary>\n\n${str(b['text'])}\n\n</details>` : ''}`,
  stuff: (b) => `📦 **${str(b['title']) || 'Something in My Stuff'}** (My Stuff \`${str(b['id'])}\`)${b['note'] ? ` — ${str(b['note'])}` : ''}`,
  task: (b) => `🔗 **${str(b['title']) || 'A wisp task'}** (wisp task \`${str(b['id'])}\`)${b['note'] ? ` — ${str(b['note'])}` : ''}`,
  question: (b) => `**❓ ${str(b['question'])}**\n${list(b['options']).map((x, i) => `${i + 1}. ${str(o(x)['label'] || x)}`).join('\n')}`,
  blocked: (b, turn) =>
    `**🔒 Blocked by permissions**${turn?.approval ? ` _(${turn.approval})_` : ''}\n${list(b['items'])
      .map((i) => {
        const x = o(i);
        return `- ${str(x['tool'])}${x['detail'] ? `: \`${str(x['detail'])}\`` : ''}${x['why'] ? ` — ${str(x['why'])}` : ''}`;
      })
      .join('\n')}`,
  actions: (b) =>
    `${b['title'] ? `**${str(b['title'])}**\n` : '**Actions**\n'}${list(b['items'])
      .map((a) => {
        if (typeof a === 'string') return `- ${a}`;
        const x = o(a);
        return `- **${str(x['label'] || x['command'])}**${x['command'] ? ` — \`$ ${str(x['command'])}\`` : x['reply'] ? ` — _${str(x['reply'])}_` : ''}${x['detail'] ? ` (${str(x['detail'])})` : ''}`;
      })
      .join('\n')}`,
  next: (b) => `**Next**\n${list(b['items']).map((i) => `- ${str(i)}`).join('\n')}`,
  // An interactive page only runs in wisp's page: its fallback blocks stand in for it here.
  app: (b, turn, extra) => {
    const fb = list(b['fallback']).filter((x) => prop(x, 'type') && prop(x, 'type') !== 'app');
    return `**🧩 ${str(b['title']) || 'Interactive'}** _(interactive: open it in wisp)_${fb.length ? `\n\n${blocksToMarkdown(fb, turn, extra)}` : ''}`;
  },
  spell: (b) => {
    const spell = b['spell'];
    const remove = b['remove'] || (!prop(spell, 'wispSpell') && prop(spell, 'remove'));
    if (remove) return `**🧙 Spell:** remove \`${str(remove)}\``;
    const s = o(spell || {});
    return `**🧙 Spell: ${str(s['name']) || str(s['id'])}**${s['description'] ? ` — ${str(s['description'])}` : ''}\n\n_Keep it in wisp to turn it on._`;
  },
};

function graph(b: Obj): string {
  const head = `**${str(b['title']) || 'Branches'}**${b['ref'] ? ` ${str(b['ref'])}` : ''}${b['state'] ? ` · ${str(b['state'])}` : ''}${b['into'] ? ` → \`${str(b['into'])}\`${b['merge'] ? ` (${str(b['merge'])})` : ''}` : ''}`;
  const commits = list(b['commits']).map((c) => {
    const x = o(c);
    return `- ${x['conflict'] ? '⚠️ ' : ''}\`${str(x['hash']).slice(0, 7)}\` ${str(x['message'])}${x['branch'] ? ` [${str(x['branch'])}]` : ''}${x['author'] ? ` — ${str(x['author'])}${x['when'] ? `, ${str(x['when'])}` : ''}` : ''}`;
  });
  const conflicts = list(b['conflicts']).map((c, i) => {
    const x: Obj = typeof c === 'string' ? { file: c } : (c as Obj) || {};
    const at = x['line'] || x['lines'];
    return `${i + 1}. \`${str(x['file'])}${at ? `:${str(at)}` : ''}\`${x['detail'] ? ` — ${str(x['detail'])}` : ''}${x['ours'] ? `\n   - ours: \`${str(x['ours'])}\`` : ''}${x['theirs'] ? `\n   - theirs: \`${str(x['theirs'])}\`` : ''}${x['resolution'] ? `\n   - ✔︎ ${str(x['resolution'])}` : ''}`;
  });
  const checks = list(b['checks']).map((c) => {
    const x = o(c);
    return `${x['status'] === 'fail' ? '❌' : x['status'] === 'pending' ? '⏳' : '✅'} ${str(x['label'] || c)}${x['value'] ? ` ${str(x['value'])}` : ''}`;
  });
  return [head, commits.join('\n'), conflicts.length ? `**Conflicts**\n${conflicts.join('\n')}` : '', checks.join(' · '), b['summary'] ? str(b['summary']) : ''].filter(Boolean).join('\n\n');
}

// A contributed block's summary template: "{title}" and "{a.b}" read the block's fields.
const fillFields = (tpl: unknown, b: unknown): string => String(tpl).replace(/\{([a-zA-Z_][\w.]*)\}/g, (_, k: string) => str(k.split('.').reduce<unknown>((x, y) => prop(x, y), b)));

/** blocks: presentation blocks; turn (optional) supplies captured edits for diff blocks. */
export function blocksToMarkdown(blocks: unknown = [], turn: Turn | null = null, extra?: ExtraBlock): string {
  return list(blocks)
    .map((b) => {
      try {
        const type = prop(b, 'type');
        const render = typeof type === 'string' && Object.hasOwn(R, type) ? R[type] : undefined;
        if (render) return render(b as Obj, turn, extra);
        const def = typeof type === 'string' ? extra?.(type) : undefined;
        if (def?.summary) return `${fillFields(def.summary, b)}`;
        return fence(JSON.stringify(b, null, 2), 'json');
      } catch {
        return '';
      }
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * A whole session's latest state as markdown: the newest turn's presentation, plus a pending
 * ask_user question if the agent is blocked on one. notes: lines other plugins add once the turn is
 * done (wisp.worktrees: where the changes are, the PR).
 */
export function sessionToMarkdown(session: Session, notes: readonly string[] = []): string {
  const turn = session.turns?.at(-1);
  const out: string[] = [];
  if (turn?.status === 'running') out.push(`_Working… (${turn.activity?.findLast?.((a) => a.kind !== 'text')?.label || 'starting up'})_`);
  else if (turn?.presentation) out.push(blocksToMarkdown(turn.presentation.blocks, turn));
  const ask = session.ask;
  if (ask) {
    out.push(`**${ask.permission ? '🔒 The agent needs your approval' : '❓ The agent is waiting for your answer'}:** ${ask.question}${ask.context ? `\n\n${ask.context}` : ''}`);
    if (ask.options?.length) out.push(ask.options.map((x, i) => `${i + 1}. ${x}`).join('\n'));
  }
  if (turn?.status !== 'running') out.push(...notes.filter(Boolean));
  return out.join('\n\n');
}
