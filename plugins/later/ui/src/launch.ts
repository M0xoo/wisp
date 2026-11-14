// New task's ways to start later (v1 launcher.js go → planAsk, when.js; F-comp-19, F-comp-20, F-comp-22): a time picked
// on the clock, a time the prompt starts with ("in 5 min run the e2e suite", or "remind me … in 1 hour": a reminder),
// "/draft …" (kept in Drafts until you start it) and "/after <task> …" (starts once that task is done). DOM-free.
import { parseWhen } from './when.ts';

export type LaunchPlan =
  | { readonly kind: 'task' | 'reminder'; readonly at: number; readonly rest: string }
  | { readonly kind: 'task'; readonly draft: true; readonly rest: string }
  | { readonly kind: 'task'; readonly after: { readonly id: string; readonly title: string }; readonly rest: string };

const DRAFT = /^\/draft(?:\s+|$)/i;
const AFTER = /^\/after(?:\s+|$)/i;
// the task as a mention (`@[Title](wisp:<id>)`, what the @ menu puts in), `wisp:<id>`, a bare id or a `#/s/<id>` link
const AFTER_TASK = /^(?:@\[([^\]\n]{1,200})\]\(wisp:([\w:-]{6,80})\)|wisp:([\w:-]{6,80})|([a-f0-9][a-f0-9-]{11,40})|\S*#\/s\/([\w:-]{6,80})\/?)(?=\s|$)/i;

/**
 * What Send does instead of starting the task now, or null (start it now). `at`: a time picked on the clock;
 * `title(id)`: a task's title, undefined when there's no such task here.
 */
export function launchPlan(text: string, o: { readonly now: Date; readonly at?: number | undefined; readonly title: (id: string) => string | undefined }): LaunchPlan | null {
  const t = text.trim();
  if (!t) return null;
  if (DRAFT.test(t)) {
    const rest = t.replace(DRAFT, '').trim();
    return rest ? { kind: 'task', draft: true, rest } : null;
  }
  if (AFTER.test(t)) {
    const rest = t.replace(AFTER, '');
    const m = AFTER_TASK.exec(rest);
    const id = m ? (m[2] ?? m[3] ?? m[4] ?? m[5] ?? '') : '';
    const prompt = m ? rest.slice(m[0].length).trim() : '';
    const title = id ? o.title(id) : undefined;
    return id && prompt && title !== undefined ? { kind: 'task', after: { id, title: m?.[1] ?? title }, rest: prompt } : null;
  }
  if (o.at !== undefined && o.at > o.now.getTime()) return { kind: 'task', at: o.at, rest: t };
  const w = parseWhen(t, o.now);
  return w ? { kind: w.reminder ? 'reminder' : 'task', at: w.at, rest: w.rest } : null;
}
