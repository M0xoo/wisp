// Presentation → plain markdown, for places that can't run the web UI: the CLI, MCP clients,
// webhooks, chat apps. Lossy by design (no animation, no syntax colours), never throws.

import { diffLines, hunks } from '../web/js/diff.js';

const STATUS = { done: '✅ Done', partial: '🟡 Partly done', blocked: '⛔ Blocked', info: 'ℹ️ Report' };
const CHANGE = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
const fence = (text, lang = '') => {
  const s = String(text ?? '');
  const ticks = '`'.repeat(Math.max(3, ...[...s.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${ticks}${lang}\n${s.replace(/\n$/, '')}\n${ticks}`;
};
const list = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (v === undefined || v === null ? '' : String(v));

function findChange(turn, file) {
  if (!file || !turn?.changes) return null;
  return turn.changes.find((c) => c.file === file) || turn.changes.find((c) => c.file.endsWith('/' + file) || file.endsWith('/' + c.file));
}

function unified(edits) {
  return edits
    .map((e) =>
      hunks(diffLines(str(e.before), str(e.after)), 3)
        .map((o) => (o.op === '…' ? `@@ ${o.count} unchanged line${o.count > 1 ? 's' : ''} @@` : `${o.op}${o.text}`))
        .join('\n'),
    )
    .join('\n@@ … @@\n');
}

const R = {
  hero: (b) => `## ${str(b.title) || 'Done'}\n\n**${STATUS[b.status] || STATUS.done}**${b.summary ? ` — ${b.summary}` : ''}`,
  markdown: (b) => str(b.text),
  steps: (b) =>
    `${b.title ? `**${b.title}**\n\n` : ''}${list(b.items)
      .map((s, i) => `${i + 1}. ${s.status === 'failed' ? '❌' : s.status === 'skipped' ? '⏭️' : '✔︎'} **${str(s.title)}**${s.detail ? ` — ${s.detail}` : ''}`)
      .join('\n')}`,
  stats: (b) => list(b.items).map((s) => `- **${str(s.label)}:** ${str(s.value)}${str(s.unit)}${s.delta ? ` (${s.delta})` : ''}`).join('\n'),
  files: (b) => list(b.items).map((f) => `- \`${CHANGE[f.change] || 'M'}\` \`${str(f.path)}\`${f.note ? ` — ${f.note}` : ''}`).join('\n'),
  tree: (b) => `${b.title ? `**${b.title}**\n\n` : ''}${list(b.items).map((f) => `- \`${str(f.path)}\`${f.change ? ` (${f.change})` : ''}${f.note ? ` — ${f.note}` : ''}`).join('\n')}`,
  diff: (b, turn) => {
    const file = str(b.file || b.path);
    const edits = b.before !== undefined || b.after !== undefined ? [{ before: b.before, after: b.after }] : findChange(turn, file)?.edits;
    const head = `**\`${file}\`**${b.caption ? ` — ${b.caption}` : ''}`;
    return edits?.length ? `${head}\n\n${fence(unified(edits), 'diff')}` : `${head} _(no captured edits)_`;
  },
  code: (b) => `${b.file ? `**\`${b.file}${b.line ? `:${b.line}` : ''}\`**${b.caption ? ` — ${b.caption}` : ''}\n\n` : b.caption ? `${b.caption}\n\n` : ''}${fence(b.code, str(b.language))}`,
  tests: (b) => {
    const n = (k) => Number(b[k]) || 0;
    const head = `**Tests** \`${str(b.command)}\` — ${n('passed')} passed, ${n('failed')} failed${n('skipped') ? `, ${n('skipped')} skipped` : ''}${b.durationMs ? ` (${(n('durationMs') / 1000).toFixed(1)}s)` : ''}`;
    const fails = list(b.failures).map((f) => `- ❌ ${str(f.name)}${f.message ? `: ${f.message}` : ''}${f.file ? ` (\`${f.file}\`)` : ''}`);
    return [head, ...fails].join('\n');
  },
  commits: (b) =>
    `${b.branch ? `**Branch** \`${b.branch}\`\n\n` : ''}${list(b.items)
      .map((c) => `- \`${str(c.hash).slice(0, 7)}\` ${str(c.message)}${c.additions !== undefined ? ` (+${c.additions}/−${c.deletions ?? 0})` : ''}`)
      .join('\n')}`,
  graph: (b) => {
    const head = `**${str(b.title) || 'Branches'}**${b.ref ? ` ${b.ref}` : ''}${b.state ? ` · ${b.state}` : ''}${b.into ? ` → \`${b.into}\`${b.merge ? ` (${b.merge})` : ''}` : ''}`;
    const commits = list(b.commits).map((c) => `- ${c.conflict ? '⚠️ ' : ''}\`${str(c.hash).slice(0, 7)}\` ${str(c.message)}${c.branch ? ` [${c.branch}]` : ''}${c.author ? ` — ${c.author}${c.when ? `, ${c.when}` : ''}` : ''}`);
    const conflicts = list(b.conflicts).map((c, i) => {
      const o = typeof c === 'string' ? { file: c } : c || {};
      return `${i + 1}. \`${str(o.file)}${o.line || o.lines ? `:${o.line || o.lines}` : ''}\`${o.detail ? ` — ${o.detail}` : ''}${o.ours ? `\n   - ours: \`${o.ours}\`` : ''}${o.theirs ? `\n   - theirs: \`${o.theirs}\`` : ''}${o.resolution ? `\n   - ✔︎ ${o.resolution}` : ''}`;
    });
    const checks = list(b.checks).map((c) => `${c.status === 'fail' ? '❌' : c.status === 'pending' ? '⏳' : '✅'} ${str(c.label || c)}${c.value ? ` ${c.value}` : ''}`);
    return [head, commits.join('\n'), conflicts.length ? `**Conflicts**\n${conflicts.join('\n')}` : '', checks.join(' · '), b.summary ? str(b.summary) : '']
      .filter(Boolean)
      .join('\n\n');
  },
  terminal: (b) => fence(`$ ${str(b.command)}\n${str(b.output)}${b.exitCode !== undefined && b.exitCode !== 0 ? `\n[exit ${b.exitCode}]` : ''}`, 'console'),
  compare: (b) => ['before', 'after'].map((k) => `**${str(b[k]?.label) || (k === 'before' ? 'Before' : 'After')}**\n${list(b[k]?.items).map((i) => `- ${str(i)}`).join('\n')}`).join('\n\n'),
  flow: (b) => {
    const nodes = list(b.nodes);
    const label = (id) => nodes.find((n) => n.id === id)?.label || id;
    const edges = list(b.edges).length ? list(b.edges) : nodes.slice(1).map((n, i) => [nodes[i].id, n.id]);
    return `${b.title ? `**${b.title}**\n\n` : ''}${edges.map(([a, z, l]) => `- ${label(a)} → ${label(z)}${l ? ` _(${l})_` : ''}`).join('\n')}`;
  },
  chart: (b) => `${b.title ? `**${b.title}**\n\n` : ''}${list(b.items).map((i) => `- ${str(i.label)}: ${str(i.value)}${str(b.unit)}`).join('\n')}`,
  checklist: (b) => `${b.title ? `**${b.title}**\n\n` : ''}${list(b.items).map((i) => `- [${i.done ? 'x' : ' '}] ${str(i.text)}`).join('\n')}`,
  callout: (b) => `> **${b.tone === 'danger' ? '⛔' : b.tone === 'warn' ? '⚠️' : b.tone === 'success' ? '✅' : 'ℹ️'} ${str(b.title)}**\n> ${str(b.text).replace(/\n/g, '\n> ')}`,
  image: (b) => `🖼️ \`${str(b.path || b.src)}\`${b.caption ? ` — ${b.caption}` : ''}`,
  question: (b) => `**❓ ${str(b.question)}**\n${list(b.options).map((o, i) => `${i + 1}. ${str(o.label || o)}`).join('\n')}`,
  actions: (b) =>
    `${b.title ? `**${b.title}**\n` : '**Actions**\n'}${list(b.items)
      .map((a) => (typeof a === 'string' ? `- ${a}` : `- **${str(a.label || a.command)}**${a.command ? ` — \`$ ${str(a.command)}\`` : a.reply ? ` — _${str(a.reply)}_` : ''}${a.detail ? ` (${str(a.detail)})` : ''}`))
      .join('\n')}`,
  next: (b) => `**Next**\n${list(b.items).map((i) => `- ${str(i)}`).join('\n')}`,
};

// blocks: presentation blocks; turn (optional) supplies captured edits for diff blocks.
export function blocksToMarkdown(blocks = [], turn = null) {
  return list(blocks)
    .map((b) => {
      try {
        return R[b?.type] ? R[b.type](b, turn) : fence(JSON.stringify(b, null, 2), 'json');
      } catch {
        return '';
      }
    })
    .filter(Boolean)
    .join('\n\n');
}

// A whole session's latest state as markdown: the newest turn's presentation, plus a pending
// ask_user question if the agent is blocked on one.
export function sessionToMarkdown(session) {
  const turn = session.turns?.at(-1);
  const out = [];
  if (turn?.status === 'running') out.push(`_Working… (${turn.activity?.findLast?.((a) => a.kind !== 'text')?.label || 'starting up'})_`);
  else if (turn?.presentation) out.push(blocksToMarkdown(turn.presentation.blocks, turn));
  if (session.ask) {
    out.push(`**❓ The agent is waiting for your answer:** ${session.ask.question}${session.ask.context ? `\n\n${session.ask.context}` : ''}`);
    if (session.ask.options?.length) out.push(session.ask.options.map((o, i) => `${i + 1}. ${o}`).join('\n'));
  }
  // Worktree sessions: say where the changes are, since they aren't in the caller's checkout.
  if (session.worktree && turn?.status !== 'running') out.push(`_Changes are on branch \`${session.worktree.branch}\` in the worktree \`${session.worktree.path}\`${session.pr ? ` · PR #${session.pr.number} (${String(session.pr.state).toLowerCase()}): ${session.pr.url}` : ''}._`);
  return out.join('\n\n');
}
