// @wisp-plugin/crew-ui: wisp.crew's UI (docs/v2-ui-brief.md). Each extension's component loads with
// import() on first show, so the plugin costs nothing until it's on screen.

import { lazy } from 'solid-js';
import { defineExtension, defineView } from '@wisp/shell';
import { askedOf, askAll } from './answers.ts';
import { askCrew } from './commands.ts';
import { parseEditor } from './editor.ts';
import { t } from './i18n.ts';
import { VIEW } from './views.ts';
import { definePluginUi } from './define.ts';
import { catalogue } from './i18n.ts';

export default definePluginUi({
  id: 'wisp.crew',
  // a member's page: the main pane when a face on the rail is picked (v1 crew.js buildView)
  extensions: [
    defineExtension({ id: 'wisp.crew.page', attachTo: { id: 'shell.screen:crew' }, component: lazy(() => import('./CrewPage.tsx')) }),
    // under a turn: the members asked on it and their answers, with Reply (v1 btw.js crew entries)
    defineExtension({ id: 'wisp.crew.answers', attachTo: { id: 'shell.turn:foot' }, component: lazy(() => import('./Answers.tsx')) }),
  ],
  // a reply that starts with @a member is for them: their job, their answer under the turn (v1 crew.js replyIn)
  prompt: [
    {
      id: 'wisp.crew.ask',
      trigger: '@',
      where: ['reply'],
      order: 90,
      items: () => [],
      send: (text, ctx) => {
        const asked = askedOf(text);
        if (!asked) return false;
        askAll(asked, (id, question) => void ctx.client.run(askCrew, { task: ctx.task as never, id, question }).catch(() => undefined));
        return true;
      },
    },
  ],
  // add or edit a member (v1 crewEditor): the rail's +, a member page's Edit…
  views: [
    defineView({
      kind: VIEW.editor,
      slot: 'overlay',
      overlay: 'dialog',
      size: 'v1',
      parse: parseEditor,
      title: (p) => t(p.id ? 'wisp.crew.editor.edit' : 'wisp.crew.editor.add'),
      component: lazy(() => import('./CrewEditor.tsx')),
    }),
  ],
  commands: [],
  catalogue,
});
