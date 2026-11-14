// wisp.channels' UI: Settings → Phone (v1 web/js/features/phone.js), one pane that sets up ntfy, Telegram, Slack,
// Discord, GitHub and email.
import { lazy } from 'solid-js';
import type { PluginUiDef } from '@wisp/shell';
import { channelExtra, phoneStatus, rotateChannel, setupChannel, testChannel } from './commands.ts';
import { catalogue } from './i18n.ts';

const ui: PluginUiDef = {
  id: 'wisp.channels',
  settings: [{ id: 'phone', group: 'integrations', title: 'channels.pane', icon: 'phone', order: 10, component: lazy(() => import('./panes/Phone.tsx')) }],
  commands: [phoneStatus, setupChannel, testChannel, channelExtra, rotateChannel],
  catalogue,
};
export default ui;
