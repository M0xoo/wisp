// What Ask to fix and Send to agent put in the task's reply box (v1 panel.js askToFix /
// sendToAgent). They fill the box and don't send: you look first. Pure.

import type { T } from '../i18n.ts';
import type { Finding, Note, Thread } from '../types.ts';

const quote = (body: string): string =>
  String(body || '')
    .trim()
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');

const where = (file: string | undefined, line: number | null | undefined): string => (file ? `${file}${line ? `:${line}` : ''}` : '');

/** The failing check and the end of its log. */
export function askToFixText(t: T, o: { name: string; pr: number; url?: string; log?: string }): string {
  const head = t('wisp.ship.ask.fix', { name: o.name, n: o.pr, url: o.url ? ` (${o.url})` : '' });
  return o.log ? `${head}\n\n\`\`\`\n${o.log}\n\`\`\`` : head;
}

const SEV = { high: 'wisp.ship.sev.high', medium: 'wisp.ship.sev.medium', low: 'wisp.ship.sev.low' } as const;
export const severityLabel = (t: T, s: Finding['severity']): string => t(SEV[s]);

export function findingsText(t: T, o: { by: string; pr: number; findings: readonly Finding[] }): string {
  const lines = o.findings.map((f) => {
    const at = where(f.file, f.line);
    const rule = f.rule ? t('wisp.ship.ask.rule', { rule: f.rule }) : '';
    return `- **${severityLabel(t, f.severity)}**${at ? ` \`${at}\`` : ''}: ${f.text}${rule}`;
  });
  return t('wisp.ship.ask.findings', { by: o.by, n: o.pr, list: lines.join('\n'), count: o.findings.length });
}

export function threadText(t: T, th: Thread, pr: number): string {
  const first = th.notes[0];
  const body = th.notes.map((x) => quote(`**${x.author}:** ${x.body}`)).join('\n>\n');
  return t('wisp.ship.ask.thread', { who: first?.author ?? '', at: where(th.path, th.line), n: pr, body });
}

export function noteText(t: T, n: Note, pr: number): string {
  return t(n.kind === 'review' ? 'wisp.ship.ask.review' : 'wisp.ship.ask.note', { who: n.author, n: pr, body: quote(n.body) });
}
