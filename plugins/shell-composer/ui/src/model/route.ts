// What Send does with the text in the box (v1 composer.js sendReply, launcher.js go). Pure: the box
// turns the text into one of these, then runs it. The peer reads slash commands the same way (the
// CLI and the phone send them as text), so most go as an ordinary reply; only what must happen
// here (a hint, a dialog, sign-in) or has its own write (/btw, /side, /draft, /after) is split off.

import { afterAsk, btwQuestion, draftAsk, goalAsk, isGoalDrop, isLogin, sandboxAsk, sideAsk, slashArg, spellAsk, terminalAsk } from '../text/slash.ts';
import type { Mention } from '../text/mentions.ts';

export type Route =
  | { readonly t: 'nothing' }
  /** say how to use it; send nothing */
  | { readonly t: 'hint'; readonly key: string; readonly vars?: Readonly<Record<string, string>> }
  /** a view another plugin owns: the goal's popover, the feedback dialog, sign-in */
  | { readonly t: 'open'; readonly view: 'goal' | 'feedback' | 'bug' | 'login' }
  | { readonly t: 'btw'; readonly question: string }
  | { readonly t: 'side'; readonly text: string }
  | { readonly t: 'draft'; readonly prompt: string }
  | { readonly t: 'after'; readonly id: string; readonly prompt: string }
  /** everything else: the text as it is (with /goal, /spell, @crew… for the peer to read) */
  | { readonly t: 'send' };

const H = 'shell-composer.hint';

export interface RouteContext {
  /** the reply box of a task, or New task */
  readonly where: 'reply' | 'launch';
  /** the mentions still in the text */
  readonly mentions: readonly Mention[];
  /** whether there are files or comments to send without words */
  readonly extras: boolean;
}

function slashRoute(text: string, where: RouteContext['where']): Route | undefined {
  const btw = where === 'reply' ? btwQuestion(text) : null;
  if (btw !== null) return btw ? { t: 'btw', question: btw } : { t: 'hint', key: `${H}.btw` };
  const side = where === 'reply' ? sideAsk(text) : null;
  if (side !== null) return side ? { t: 'side', text: side } : { t: 'hint', key: `${H}.side` };
  const spell = spellAsk(text);
  if (spell === '') return { t: 'hint', key: `${H}.spell` };
  const goal = goalAsk(text);
  if (goal === '') return { t: 'open', view: 'goal' };
  if (goal !== null && isGoalDrop(goal) && where === 'launch') return { t: 'hint', key: `${H}.goal-drop` };
  if (slashArg('feedback', text) === '') return { t: 'open', view: 'feedback' };
  if (slashArg('bug', text) === '') return { t: 'open', view: 'bug' };
  if (where === 'reply' && isLogin(text)) return { t: 'open', view: 'login' };
  if (where === 'launch' && terminalAsk(text) === '') return { t: 'hint', key: `${H}.terminal` };
  if (where === 'launch' && sandboxAsk(text) === '') return { t: 'hint', key: `${H}.sandbox` };
  const draft = draftAsk(text);
  if (draft !== null) return draft ? { t: 'draft', prompt: draft } : { t: 'hint', key: `${H}.draft` };
  const after = afterAsk(text);
  if (after !== null) return after.id && after.prompt ? { t: 'after', ...after } : { t: 'hint', key: `${H}.after` };
  return undefined;
}

/** `text` is the stored form (mentions encoded); `shown` what the box shows. */
export function route(text: string, shown: string, ctx: RouteContext): Route {
  const t = text.trim();
  if (!t) return ctx.extras ? { t: 'send' } : { t: 'nothing' };
  const slash = t.startsWith('/') ? slashRoute(t, ctx.where) : undefined;
  if (slash) return slash;
  // "@Ana" alone: say what to tell them (v1 C:655)
  const crew = ctx.mentions.filter((m) => m.kind === 'crew');
  if (crew.length > 0) {
    const rest = crew.reduce((s, m) => s.replace(`@${m.title}`, ''), shown).trim();
    if (!rest) return { t: 'hint', key: `${H}.crew`, vars: { names: crew.map((m) => m.title).join(' & ') } };
  }
  return { t: 'send' };
}
