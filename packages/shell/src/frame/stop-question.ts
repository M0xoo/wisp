// What Stop asks before it stops a run (v1 stop-question.js, #781), for a lead and a subagent alike. It says what else a
// Stop does: the lead's running subagents (`live`) stop with it, a stopped subagent sends its lead no report, and
// queued follow-ups stay, held. DOM-free.
import type { ShellContext } from '../contract.ts';

export interface StopQuestion {
  readonly title: string;
  readonly body: string;
  readonly ok: string;
}

export function stopQuestion(o: { readonly sub: boolean; readonly name: string; readonly live: number; readonly queued: number }, t: ShellContext['t']): StopQuestion {
  const more = [
    o.sub ? t('shell.stop.subNoReport') : '',
    o.live > 0 ? t(o.live === 1 ? 'shell.stop.subsOne' : 'shell.stop.subsMany', { count: o.live }) : '',
    o.queued > 0 ? t(o.queued === 1 ? 'shell.stop.queuedOne' : 'shell.stop.queuedMany') : '',
  ].filter(Boolean);
  return {
    title: o.sub ? t('shell.stop.titleSub') : t('shell.stop.title', { name: o.name }),
    body: more.length > 0 ? more.join(' ') : t('shell.stop.plain'),
    ok: o.sub ? t('shell.stop.okSub') : t('shell.stop.ok'),
  };
}
