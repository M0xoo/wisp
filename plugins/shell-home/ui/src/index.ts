// wisp.shell-home's UI: the finish / ask notifier (v1 notify.js), started by apps/web with the shell's
// platform, toaster and nav (a plugin UI's setup gets only its client); its strings; and Home's pure rules
// (what needs you, overlapping tasks, the tips) for the screens that show them.
import type { PluginUiDef } from '@wisp/shell';
import catalogue from './i18n/en.json' with { type: 'json' };

export { startNotifier, noticeFor, flatRow, notifyOn, NOTIFY_KEY, type NotifierDeps } from './notify.ts';

const ui: PluginUiDef = { id: 'wisp.shell-home', catalogue };
export default ui;
