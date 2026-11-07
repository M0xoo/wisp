// The Agents pane's rules, DOM-free so tests read them: what a harness row says, what Re-check turned
// up, the changed-harness line, and which step of a sign-in shows (v1 settings.js paintAgents,
// recheckSummary; agent-login.js control/loginPanel; harness-watch.js changeText).

import { t } from './i18n.ts';
import type { AccountRow, HarnessChange, HarnessRow, KeyRow, LoginRow, Pin } from './types.ts';

type Tone = 'good' | 'warn' | 'bad';

const modelCount = (h: Pick<HarnessRow, 'models'> | undefined): number => (h?.models ?? []).filter((m) => m.id).length;

/** Installed but signed out: hidden from the picker, and its row offers Sign in. */
export const signedOut = (h: Pick<HarnessRow, 'available' | 'signedIn'>): boolean => !h.available && h.signedIn === false;
/** Found, or found and signed out: its row has a version and a sign-in. */
export const present = (h: Pick<HarnessRow, 'available' | 'signedIn'>): boolean => h.available || signedOut(h);

/** "Ready", "Signed out", "Not found" and its tone (v1 sx-state). */
export function harnessState(h: Pick<HarnessRow, 'available' | 'signedIn'>): { tone: Tone; label: string } {
  if (h.available) return { tone: 'good', label: t('accounts.state.ready') };
  if (signedOut(h)) return { tone: 'warn', label: t('accounts.state.signedOut') };
  return { tone: 'bad', label: t('accounts.state.notFound') };
}

/** The harness's small line: "2.1.30 · 3 models · 2 accounts", or how to get it while it isn't found. */
export function harnessLine(h: HarnessRow, accounts: number): string {
  if (!present(h)) return h.installing ? t('accounts.installing') : (h.setup?.tip ?? t('accounts.setup.tip', { name: h.name }));
  const n = modelCount(h);
  const parts = [
    h.version ?? '',
    signedOut(h) ? t('accounts.line.signIn') : n ? t('accounts.line.models', { count: n }) : '',
    h.hasKey === false ? t('accounts.line.freeOnly') : '',
    accounts > 1 ? t('accounts.line.accounts', { count: accounts }) : '',
  ];
  return parts.filter(Boolean).join(' · ');
}

/** "a@corp.com · Max · Work" (v1 accountsHtml). */
export const accountLine = (a: Pick<AccountRow, 'email' | 'plan' | 'kind'>): string => [a.email, a.plan, t(a.kind === 'work' ? 'accounts.kind.work' : 'accounts.kind.personal')].filter(Boolean).join(' · ');

/** What a Re-check turned up: harnesses found or gone, model lists that grew or shrank, new versions. */
export function recheckSummary(before: ReadonlyMap<string, Pick<HarnessRow, 'available' | 'models' | 'version'>>, after: readonly HarnessRow[]): string {
  const notes: string[] = [];
  for (const a of after) {
    const was = before.get(a.id);
    if (a.available && !was?.available) notes.push(t('accounts.recheck.found', { name: a.name }));
    else if (!a.available && was?.available) notes.push(t('accounts.recheck.gone', { name: a.name }));
    else if (a.available && modelCount(a) !== modelCount(was)) {
      const d = modelCount(a) - modelCount(was);
      notes.push(t(d > 0 ? 'accounts.recheck.more' : 'accounts.recheck.fewer', { name: a.name, count: Math.abs(d) }));
    } else if (a.available && a.version !== was?.version) notes.push(t('accounts.recheck.updated', { name: a.name }));
  }
  return notes.length ? notes.join(' · ') : t('accounts.recheck.none');
}

const label = (p: Pin): string => p.version ?? p.path;

/** "Claude Code changed since 2 Nov: 2.0.1 → 2.0.2" (v1 harness-watch changeText). */
export function changeText(name: string, c: HarnessChange, locale?: string): string {
  const day = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(c.from.at);
  const from = label(c.from);
  const moved = c.kind !== 'update' && c.from.real !== c.to.real && c.from.path !== c.to.path;
  const to = moved ? t('accounts.change.at', { what: label(c.to), path: c.to.path }) : label(c.to);
  const what = from === to ? t('accounts.change.bytes', { what: from }) : `${from} → ${to}`;
  return t('accounts.change', { name, day, what });
}

/** The tooltip: both programs' paths and hashes. */
export function changeTip(c: HarnessChange): string {
  const one = (p: Pin): string => `${p.path}${p.real !== p.path ? ` (${p.real})` : ''}, sha256 ${p.sha256}`;
  return t('accounts.change.tip', { was: one(c.from), now: one(c.to) });
}

/** Still open: not hashing, and not trusted since this change was seen. */
export const stillChanged = (h: Pick<HarnessRow, 'changed' | 'pinnedAt'>): boolean => !!h.changed && !h.changed.checking && !((h.pinnedAt ?? 0) >= h.changed.at);

export const busy = (l: Pick<LoginRow, 'state'> | undefined): boolean => l?.state === 'running' || l?.state === 'waiting';

/** The control in a harness's row (one account) or an account's row (v1 agent-login control). */
export type LoginControl = 'cancel' | 'signIn' | 'signedIn' | 'none';
export function loginControl(l: LoginRow | undefined, opts: { account: boolean; out: boolean }): LoginControl {
  if (busy(l)) return 'cancel';
  // An account row says "Signed out" itself and keeps Sign out in its ⋯ menu
  if (opts.account) return l?.signedIn === false || (l?.signedIn !== true && opts.out) ? 'signIn' : 'none';
  if (l?.signedIn === true) return 'signedIn';
  if (l?.signedIn === false || opts.out) return 'signIn';
  return 'none';
}

/** What a sign-in's panel shows (v1 loginPanel): nothing, the failure, or the steps so far. */
export type LoginStep =
  | { kind: 'none' }
  | { kind: 'failed'; error: string }
  | { kind: 'steps'; url: string; code: string; paste: boolean; checking: boolean };
export function loginStep(agent: string, l: LoginRow | undefined): LoginStep {
  if (!l || (!busy(l) && l.state !== 'failed')) return { kind: 'none' };
  if (l.state === 'failed') return { kind: 'failed', error: l.error || t('accounts.login.failed') };
  // Claude shows a code on its page to paste back here; Codex and GitHub show one to type there
  const paste = (agent === 'claude' && !l.checking) || l.needsInput === true;
  return { kind: 'steps', url: l.url ?? '', code: l.code ?? '', paste: paste && !l.code, checking: l.checking === true && l.needsInput !== true };
}

/** "…a3f9" for a saved key; the key itself never reaches the page. */
export const masked = (k: Pick<KeyRow, 'set' | 'hint'>): string => (k.set ? (k.hint ? `…${k.hint}` : '…') : '');

/** "opencode.ai/auth" from its URL, for the line saying where keys come from. */
export const site = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/$/, '');
