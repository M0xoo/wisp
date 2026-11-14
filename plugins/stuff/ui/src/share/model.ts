// What Share… and the pasted link's card say, in words (v1 features/share.js), DOM-free: the dialog's
// chips for what goes with the share, the card's facts, and the import body New task sends.

import type { IconName } from '@wisp/ui';
import { withoutLink } from './link.ts';
import type { ImportArgs, RunHere, ShareCardInfo, SharePreview, ShareWork } from './types.ts';

export type T = (key: string, vars?: Readonly<Record<string, string | number>>) => string;

export interface Chip {
  readonly icon: IconName;
  readonly text: string;
}

/** What goes with the share, as chips: turns, branch, delegates, crew, connectors, skills. */
export function carryChips(t: T, p: SharePreview, turns: number): Chip[] {
  const out: Chip[] = [];
  if (turns) out.push({ icon: 'comment', text: t('stuff.share.turns', { count: turns }) });
  if (p.work?.kind === 'git' && p.work.branch) out.push({ icon: 'branch', text: p.work.branch });
  if (p.delegates) out.push({ icon: 'agent', text: t('stuff.share.delegated', { count: p.delegates }) });
  if (p.crew?.length) out.push({ icon: 'crew', text: p.crew.join(', ') });
  if (p.connectors?.length) out.push({ icon: 'plug', text: t('stuff.share.connectors', { count: p.connectors.length }) });
  if (p.skills?.length) out.push({ icon: 'read', text: t('stuff.share.skills', { count: p.skills.length }) });
  return out.length ? out : [{ icon: 'comment', text: t('stuff.share.conversation') }];
}

/** The chips' tooltip: the connectors' and skills' names (connectors never with their keys). */
export function carryTip(t: T, p: SharePreview): string {
  const lines: string[] = [];
  if (p.connectors?.length) lines.push(t('stuff.share.connectorsTip', { names: p.connectors.join(', ') }));
  if (p.skills?.length) lines.push(t('stuff.share.skillsTip', { names: p.skills.join(', ') }));
  return lines.join('\n');
}

/** The "Its work" checkbox: whether it can go, and the line under it. */
export function workOption(t: T, work: ShareWork | null): { readonly can: boolean; readonly hint: string } {
  if (!work) return { can: false, hint: t('stuff.share.work.none') };
  if (work.kind === 'files') return { can: true, hint: t('stuff.share.work.files') };
  const branch = work.branch ? t('stuff.share.work.branch', { branch: work.branch }) : t('stuff.share.work.itsBranch');
  return { can: true, hint: work.repo ? t('stuff.share.work.git', { branch }) : t('stuff.share.work.gitNoRemote', { branch }) };
}

/** The card's one line of facts: "3 turns · 1 delegated task · branch fix-add · 2 connectors". */
export function cardFacts(t: T, c: ShareCardInfo): string {
  const work = c.work?.kind === 'git' && c.work.branch ? t('stuff.share.work.branch', { branch: c.work.branch }) : c.work?.kind === 'files' ? t('stuff.share.card.itsFiles') : !c.work ? t('stuff.share.card.noWork') : '';
  return [
    t('stuff.share.turns', { count: c.turns ?? 0 }),
    c.delegates ? t('stuff.share.delegated', { count: c.delegates }) : '',
    work,
    c.connectors?.length ? t('stuff.share.connectors', { count: c.connectors.length }) : '',
    c.skills?.length ? t('stuff.share.skills', { count: c.skills.length }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Who shared it, by name, then handle. */
export const whoOf = (t: T, c: Pick<ShareCardInfo, 'from'> | undefined): string => c?.from?.name || c?.from?.handle || t('stuff.share.card.someone');

export interface CardChoice {
  readonly passkey: string;
  /** a harness or model picked on the card, over the one the card suggests */
  readonly run: RunHere | null;
  readonly connectors: boolean;
  readonly crew: boolean;
}

/** Why the import can't go yet, as a key, or the body to send. */
export type Take = { readonly why: string; readonly tone: 'info' | 'bad'; readonly focus?: 'passkey' } | { readonly body: ImportArgs };

/** What Enter in New task sends for the box's text with a share link in it (v1 shareCard.take). */
export function takeImport(state: 'loading' | 'open' | 'locked' | 'error', card: ShareCardInfo | undefined, error: string, link: string, text: string, choice: CardChoice): Take {
  if (state === 'loading') return { why: 'stuff.share.card.stillReading', tone: 'info' };
  if (state === 'locked') return { why: '', tone: 'info', focus: 'passkey' };
  if (state === 'error' || !card) return { why: error, tone: 'bad' };
  const r = choice.run ?? card.run;
  if (!r) return { why: 'stuff.share.card.noAgent', tone: 'bad' };
  return {
    body: {
      url: link,
      ...(choice.passkey && { passkey: choice.passkey }),
      prompt: withoutLink(text, link),
      agent: r.agent,
      model: r.model,
      effort: r.effort,
      connectors: choice.connectors,
      crew: choice.crew,
      ...(card.title !== undefined && { title: card.title }),
      from: card.from,
    },
  };
}
