// Drain watch's card and the window-change lines (v1 features/budget.js drainHtml / drainReport, window-notice.js
// noticeWords), DOM-free: what each says, in v1's words.

export interface Drain {
  readonly id: string;
  readonly label: string;
  readonly ratio: number;
  readonly since: number;
  readonly runs: number;
  readonly units: number;
  readonly du: number;
  readonly usual: number;
  readonly failed?: { readonly runs: number; readonly du: number };
}

export interface Notice {
  readonly window: string;
  readonly kind: 'new' | 'gone' | 'length' | 'reset';
  readonly at: number;
  readonly resetsAt?: number | null;
  readonly wasResetsAt?: number | null;
  readonly label?: string;
  readonly wasLabel?: string;
}

/** "<1%", "3%": a share of a window (0–1) in words. */
export const pct = (x: number): string => (x > 0 && x < 0.005 ? '<1%' : `${Math.round(x * 100)}%`);
const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/** The card's two lines (v1 drainHtml). */
export function drainLines(d: Drain, when: (at: number) => string): { title: string; text: string } {
  const failed = d.failed?.runs ? ` ${d.failed.runs} of them ended in an error and still took ${pct(d.failed.du)}.` : '';
  return {
    title: `Using your plan ${d.ratio.toFixed(1)}× faster than usual`,
    text: `Since ${when(d.since)}, ${d.runs} runs took ${pct(d.du)} of the ${lower(d.label)} window for ${Math.round(d.units * 10) / 10} units of work. That much work usually takes ${pct(d.usual * d.units)}.${failed}`,
  };
}

/** What Copy report puts on the clipboard: the numbers in words, for a support ticket (v1 drainReport). */
export function drainReport(name: string, account: string, d: Drain, when: (at: number) => string): string {
  return [
    `${name}${account && account !== 'default' ? ` (${account})` : ''}: ${lower(d.label)} window`,
    `Since ${when(d.since)}, ${d.runs} runs took ${pct(d.du)} of it for ${Math.round(d.units * 10) / 10} units of work.`,
    `Over the 14 days before, the same amount of work took ${pct(d.usual * d.units)}: these runs used the window ${d.ratio.toFixed(1)}× faster per unit of work.`,
    ...(d.failed?.runs ? [`${d.failed.runs} of them ended in an error and still took ${pct(d.failed.du)}.`] : []),
  ].join('\n');
}

/** A window change in words (v1 noticeWords). */
export function noticeWords(n: Notice, who: string, when: (at: number) => string): string {
  const label = n.label || 'Usage';
  const whose = `${who}’s ${lower(label)} window`;
  const at = (t: number | null | undefined): string => (t ? `, resets ${when(t)}` : '');
  if (n.kind === 'reset') return `${whose} now resets ${n.resetsAt ? when(n.resetsAt) : ''}${n.wasResetsAt ? ` (was ${when(n.wasResetsAt)})` : ''}`;
  if (n.kind === 'length') return n.wasLabel ? `${who}’s ${lower(n.wasLabel)} window is now ${lower(label)}${at(n.resetsAt)}` : `${whose} changed its length${at(n.resetsAt)}`;
  if (n.kind === 'new') return `${who} has a new ${lower(label)} window${at(n.resetsAt)}`;
  if (n.kind === 'gone') return `${whose} is gone: it no longer reports one`;
  return `${whose} changed`;
}
