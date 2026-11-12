// Preview's element picker, the panel's side (v1 features/run.js pickLine/pickedText, panel.js addToReply): what the
// picked element becomes in the reply box. The page in the frame is the app's, so what it says is cut here too, each
// part to one line: one pick stays well under 2,000 characters whatever the page sends. DOM-free.

const part = (v: unknown, n: number): string => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

export interface Picked {
  readonly tag: string;
  readonly text?: unknown;
  readonly selector: string;
  readonly path?: unknown;
  readonly html?: unknown;
  readonly styles?: unknown;
}

/** The picked element, for the agent: what it is, where to find it, its markup and how it looks. */
export function pickLine(d: Picked): string {
  const at = part(d.path, 120);
  const said = part(d.text, 80);
  return [`In the preview${at && at !== '/' ? ` at ${at}` : ''}, ${part(d.tag, 200)}${said ? ` "${said}"` : ''} (selector: ${part(d.selector, 300)}):`, d.html ? `HTML: ${part(d.html, 800)}` : '', d.styles ? `Styles: ${part(d.styles, 400)}` : '']
    .filter(Boolean)
    .join('\n');
}

/** A pick counts only while you're picking: the page can post what it likes at any time. */
export function pickedText(picking: boolean, d: unknown): string | undefined {
  const m = d as Partial<Picked> & { type?: unknown } | null | undefined;
  return picking && m?.type === 'picked' && typeof m.tag === 'string' && typeof m.selector === 'string' ? pickLine(m as Picked) : undefined;
}

/** Under what's in the reply box, the caret on a line of its own for what to change (v1 addToReply). */
export const withPicked = (current: string, line: string): string => (current.trim() ? `${current.replace(/\s*$/, '')}\n${line}\n` : `${line}\n`);
