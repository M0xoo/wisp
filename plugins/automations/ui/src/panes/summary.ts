// The Recipes / Triggers line of Settings → Automations, a plain module so its test needn't compile the pane.
import { t } from '../i18n.ts';

/** "None yet · save a prompt you run often", or the names (the first three, then how many more). */
export function summary(names: readonly string[], none: string): string {
  if (names.length === 0) return `${t('automations.none')} · ${none}`;
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? t('automations.summary.more', { names: shown, n: names.length - 3 }) : shown;
}
