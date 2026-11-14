// What a pane's frame gets (v1 pane-bridge.js): light shapes, never turns, folders, emails or a
// secret a title happens to quote. These are wire shapes apps read; goldens in test/goldens/.

import type { CrewRow, PrRow, TaskRow } from '../types.ts';

const PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----/],
  ['a GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['an Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['an OpenAI API key', /\bsk-(proj-|svcacct-)?[A-Za-z0-9_-]{32,}/],
  ['an AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['a Discord bot token', /\b[MNO][A-Za-z0-9]{23,}\.[\w-]{6}\.[\w-]{27,}/],
  ['a Stripe key', /\b[sr]k_live_[A-Za-z0-9]{20,}/],
  ['an npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['a JSON Web Token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['a password in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]{4,}@/i],
  ['a secret value', /\b[\w-]*(api[_-]?key|secret|token|passw(or)?d|private[_-]?key)\b["']?\s*[:=]\s*["']?(?!<|\$\{|\$[A-Z_]|xxx|\*\*\*|your[_-]|example|placeholder|changeme)[A-Za-z0-9/+_.=-]{16,}/i],
];
// What's too short for the shared scanner to be sure of, but plainly a secret in a task's title.
const MORE_SECRETS = [/\bBearer\s+[\w.~+/=-]{8,}/gi, /\bsk-[A-Za-z0-9_-]{12,}/g, /\b[\w.-]*(?:KEY|TOKEN|SECRET|PASSWORD)[\w.-]*\s*=(?!=)\s*\S+/gi];

export function scrubSecrets(text: unknown): string {
  let out = String(text ?? '');
  for (const [what, re] of PATTERNS) out = out.replace(new RegExp(re.source, `${re.flags.replace('g', '')}g`), `[redacted: ${what}]`);
  return MORE_SECRETS.reduce((s, re) => s.replace(re, '[redacted]'), out);
}

export interface LightPr {
  number: number | undefined;
  url: string;
  state: string | undefined;
  draft: boolean;
  checks: unknown;
  review: unknown;
  conflict: boolean;
}

const prOf = (p: PrRow | null | undefined): LightPr | null =>
  p ? { number: p.number, url: p.url, state: p.state, draft: !!p.draft, checks: p.checks ?? null, review: p.review ?? null, conflict: !!p.conflict } : null;

/** An account by its label, never its address. */
const accountWords = (label: string | undefined, n = 1): string => {
  const t = scrubSecrets(label ?? '');
  return t.includes('@') ? `Account ${n}` : t;
};

/** `names`: what only the page knows (the harness's name, the account's label). */
export function lightTask(s: TaskRow | null | undefined, names: { harness?: string; account?: string } = {}): Record<string, unknown> | null {
  if (!s) return null;
  return {
    id: s.id,
    title: scrubSecrets(s.title ?? ''),
    state: s.state,
    status: s.status ?? '',
    project: s.project ?? '',
    agent: s.agent ?? '',
    harness: names.harness || s.agent || '',
    account: accountWords(names.account),
    machine: s.machine?.name ?? '',
    model: s.model ?? '',
    mode: s.mode ?? '',
    branch: s.branch ?? '',
    summary: scrubSecrets(s.preview ?? ''),
    live: scrubSecrets(s.live ?? ''),
    unread: !!s.unread,
    archived: !!s.archived,
    asks: !!s.asks,
    ...(s.crew && { crew: { id: s.crew.id, name: s.crew.name } }),
    pr: prOf(s.pr),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** Tasks you'd see in the list: not the tour, not spells being cast, not deleted copies. */
export const listedTasks = (sessions: Iterable<TaskRow | undefined>): TaskRow[] =>
  [...sessions].filter((s): s is TaskRow => !!s && !s.pending && s.agent !== 'wisp' && s.kind !== 'spell');

export function lightPrs(sessions: Iterable<TaskRow | undefined>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const s of listedTasks(sessions)) {
    const all = [...(s.pr ? [{ repo: s.project, pr: s.pr }] : []), ...(s.prs ?? [])];
    for (const x of all) if (x.pr && !out.some((o) => o['url'] === x.pr.url)) out.push({ ...prOf(x.pr), repo: x.repo ?? s.project ?? '', task: s.id, title: scrubSecrets(s.title ?? '') });
  }
  return out;
}

export const lightMember = (m: CrewRow | null | undefined): Record<string, unknown> | null =>
  m ? { id: m.id, name: m.name, role: m.role ?? '', busy: !!(m.running || m.busy), nextAt: m.nextAt ?? null } : null;

export interface UsageWindow {
  id: string;
  label?: string;
  used?: number;
  resetsAt?: number | null;
  ms?: number;
}

const H = 3_600_000;
/** How fast a window goes: its share per hour since it started, on the shortest window that can say. */
export function burnOf(windows: readonly UsageWindow[] = [], now = Date.now()): { burnPerHour: number | null; burnWindow: string } {
  for (const w of [...windows].filter((x) => x.ms).sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0))) {
    const ms = w.ms ?? 0;
    const spent = now - ((w.resetsAt ?? 0) - ms);
    if (!w.resetsAt || w.resetsAt <= now || !((w.used ?? 0) >= 0.05) || spent < Math.min(ms / 10, H / 2)) continue;
    return { burnPerHour: Math.round(((w.used ?? 0) / (spent / H)) * 10_000) / 10_000, burnWindow: w.label ?? '' };
  }
  return { burnPerHour: null, burnWindow: '' };
}
