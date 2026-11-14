// `wisp.usage.accounts()` (v1 pane-bridge.js lightAccounts): a row per account with its usage
// windows and what each period cost, and nothing else an account carries (no email, plan or
// sign-in state). The budget plugin's data in, the frame's wire shape out.

import { burnOf, scrubSecrets, type UsageWindow } from './light.ts';

export interface BudgetAgent {
  id: string;
  name?: string;
  available?: boolean;
  accounts?: readonly { id: string; label?: string }[];
  budget?: readonly { account: string; windows?: readonly UsageWindow[] }[];
}
export interface UsageHistory {
  agent: string;
  account: string;
  windows?: readonly { id: string; periods?: readonly Record<string, unknown>[]; shrink?: Record<string, unknown> | null }[];
}

type Rec = Record<string, unknown>;
const numOr = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const unitOf = (u: unknown): 'usd' | 'mtok' => (u === 'usd' ? 'usd' : 'mtok');

function lightCli(c: unknown): { cli: Rec } | null {
  const v = c as { version?: unknown; tools?: unknown; catalog?: unknown } | null | undefined;
  const out: Rec = {
    ...(Array.isArray(v?.version) && { version: (v.version as unknown[]).slice(0, 2).map((x) => scrubSecrets(String(x))) }),
    ...(v?.tools ? { tools: true } : {}),
    ...(v?.catalog ? { catalog: true } : {}),
  };
  return Object.keys(out).length ? { cli: out } : null;
}

const lightPeriod = (p: Rec): Rec => ({
  end: numOr(p['end']),
  ms: numOr(p['ms']),
  used: numOr(p['used']),
  inWisp: numOr(p['inWisp']),
  outside: numOr(p['outside']),
  work: numOr(p['work']),
  unit: unitOf(p['unit']),
  per1: numOr(p['per1']),
  ...(p['rough'] ? { rough: true } : {}),
  ...(p['open'] ? { open: true } : {}),
  ...(p['full'] ? { full: true } : {}),
  ...(p['cut'] ? { cut: true } : {}),
  ...lightCli(p['cli']),
});

const SHRINK = ['less', 'same', 'more'];
const lightShrink = (r: Rec | null | undefined): Rec | null =>
  r && SHRINK.includes(String(r['state']))
    ? { state: r['state'], change: numOr(r['change']), recent: numOr(r['recent']), before: numOr(r['before']), unit: unitOf(r['unit']), from: numOr(r['from']), ...(r['rough'] ? { rough: true } : {}), ...lightCli(r['cli']) }
    : null;

const accountWords = (label: string | undefined, n: number): string => {
  const t = scrubSecrets(label ?? '');
  return t.includes('@') ? `Account ${n}` : t;
};

export function lightAccounts(agents: readonly BudgetAgent[] = [], now = Date.now(), history: readonly UsageHistory[] = []): Rec[] {
  const out: Rec[] = [];
  for (const a of agents) {
    if (!a.available || a.id === 'auto') continue;
    const past = (id: string, w: UsageWindow) => history.find((h) => h.agent === a.id && h.account === id)?.windows?.find((x) => x.id === w.id);
    const row = (label: string, list: readonly UsageWindow[] = [], id = ''): Rec => ({
      agent: a.id,
      agentName: scrubSecrets(a.name ?? a.id),
      account: label,
      windows: list.map((w) => {
        const h = past(id, w);
        return { id: w.id, label: scrubSecrets(w.label ?? ''), used: Math.min(1, Math.max(0, Number(w.used) || 0)), resetsAt: w.resetsAt || null, periods: (h?.periods ?? []).map(lightPeriod), shrink: lightShrink(h?.shrink) };
      }),
      ...burnOf(list, now),
    });
    const accounts = a.accounts ?? [];
    const named = (id: string): string => (accounts.length > 1 ? accountWords(accounts.find((x) => x.id === id)?.label, accounts.findIndex((x) => x.id === id) + 1) : '');
    const seen = new Set<string>();
    for (const b of a.budget ?? []) {
      seen.add(b.account);
      out.push(row(named(b.account), b.windows, b.account));
    }
    for (const x of accounts) {
      if (seen.has(x.id) || !(accounts.length > 1 || !seen.size)) continue;
      seen.add(x.id);
      out.push(row(named(x.id)));
    }
    if (!seen.size) out.push(row(''));
  }
  return out;
}
