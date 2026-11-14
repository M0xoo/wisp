// A row model's text (an i18n key and its vars) as the words on screen. Time vars are numbers in the
// model, so it stays pure: `at` fills {time} with the future's clock label (14:32, Mon 9:00), and
// `updated` / `saved` the past's (28m ago), through the kit's own formatters.

import { futureLabel, timeLabel, type Translate } from '@wisp/ui';
import { RAW, type Txt } from '../model/row.ts';

export type T = (key: string, vars?: Readonly<Record<string, string | number>>) => string;

/** The kit's own words (time.minutes…), as the shell registered them under `kit.` */
export const kitT = (t: T): Translate => (key, vars) => t(`kit.${key}`, vars);

export function say(t: T, txt: Txt, now: number): string {
  if (txt.key === RAW) return String(txt.vars?.['text'] ?? '');
  if (!txt.vars) return t(txt.key);
  const vars: Record<string, string | number> = { ...txt.vars };
  const at = vars['at'];
  if (typeof at === 'number') vars['time'] = futureLabel(at, now);
  for (const k of ['updated', 'saved'] as const) {
    const v = vars[k];
    if (typeof v === 'number') vars[k] = timeLabel(v, now, kitT(t));
  }
  if (typeof at === 'number' && vars['saved'] === undefined) vars['saved'] = timeLabel(at, now, kitT(t));
  return t(txt.key, vars);
}
