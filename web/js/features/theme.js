// Light or dark: the `theme` setting (yours, or a spell's while it's on). System leaves it to the
// OS (tokens.css's prefers-color-scheme); light and dark set data-theme on <html>. The last one
// seen is kept so index.html paints it before app.js runs.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { icon } from '../core/dom.js';
import { load, S, save } from '../core/state.js';
import { THEMES } from '../spell-schema.js';
import { toast, tryApi } from '../ui/toast.js';

export const themePref = () => {
  const t = S.config.defaults?.theme || ('home' in S.config ? 'system' : load('wisp.theme', 'system'));
  return THEMES.includes(t) ? t : 'system';
};

export function applyTheme() {
  const t = themePref();
  save('wisp.theme', t);
  const root = document.documentElement;
  if (t === 'system') delete root.dataset.theme;
  else root.dataset.theme = t;
}

export async function setTheme(t) {
  if (t === themePref()) return;
  const by = S.config.lockedBy?.theme;
  if (by) return toast(`${icon('wizard')} The theme is set by the spell <b>${esc(by.name)}</b>. Turn it off in Settings → Spells to change it.`);
  const was = S.config.defaults.theme;
  S.config.defaults.theme = t;
  applyTheme();
  bus.emit('theme');
  const ok = await tryApi(() => api('/config', { method: 'PATCH', body: { defaults: { theme: t } } }));
  if (!ok) {
    if (was) S.config.defaults.theme = was;
    else delete S.config.defaults.theme;
    applyTheme();
    bus.emit('theme');
  }
}
