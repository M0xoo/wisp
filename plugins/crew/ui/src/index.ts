// @wisp-plugin/crew-ui: wisp.crew's UI (docs/v2-ui-brief.md). Each extension's component loads with
// import() on first show, so the plugin costs nothing until it's on screen.

import { lazy } from 'solid-js';
import { defineExtension, defineView } from '@wisp/shell';
import { askedOf, askAll } from './answers.ts';
import { askCrew } from './commands.ts';
import { parseEditor } from './editor.ts';
import { t } from './i18n.ts';
import { VIEW } from './views.ts';
import { crewData } from './data.ts';

interface RowLike {
  readonly id: string;
  readonly agent?: string;
  readonly parentId?: string;
  readonly pending?: boolean;
  readonly crew?: { readonly id: string };
}
import { definePluginUi } from './define.ts';
import { catalogue } from './i18n.ts';

export default definePluginUi({
  id: 'wisp.crew',
  // a member's page: the main pane when a face on the rail is picked (v1 crew.js buildView)
  extensions: [
    // a task's row menu (v1 actions.js crewItem): a member's job opens them; a task of yours can become a member's
    defineExtension({
      id: 'wisp.crew.rowCrew',
      attachTo: { id: 'shell.row:menu' },
      component: () => null,
      order: 100,
      if: (p) => {
        const s = p.session?.() as RowLike | undefined;
        return !!s && (!!s.crew?.id || !(s.parentId || s.agent === 'wisp' || s.pending));
      },
      bar: {
        icon: 'crew',
        label: 'wisp.crew.row.add',
        priority: 100,
        section: 'look',
        text: (p) => {
          const s = p.session?.() as RowLike | undefined;
          const m = s?.crew?.id ? crewData(p.client).byId(s.crew.id) : undefined;
          return m ? (t as (k: string, v?: Readonly<Record<string, string>>) => string)('wisp.crew.row.open', { name: m.name }) : t('wisp.crew.row.add');
        },
        select: (p) => {
          const s = p.session?.() as RowLike | undefined;
          if (!s) return;
          if (s.crew?.id) return p.client.navigate({ t: 'openCrew', id: s.crew.id as never });
          p.client.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: VIEW.editor as never, params: { task: s.id } } });
        },
      },
    }),
    // the phone's Crew section at the top of the list (v1 #secCrew); it shows only in the stacked layout
    defineExtension({ id: 'wisp.crew.list', attachTo: { id: 'shell.list:crew' }, component: lazy(() => import('./CrewListTop.tsx')) }),
    // a face's card beside the rail (v1 .cl-card): its jobs, each a click away
    defineExtension({ id: 'wisp.crew.railCard', attachTo: { id: 'shell.rail:card' }, component: lazy(() => import('./RailCard.tsx')) }),
    defineExtension({ id: 'wisp.crew.page', attachTo: { id: 'shell.screen:crew' }, component: lazy(() => import('./CrewPage.tsx')) }),
    // under a turn: the members asked on it and their answers, with Reply (v1 btw.js crew entries)
    defineExtension({ id: 'wisp.crew.answers', attachTo: { id: 'shell.turn:foot' }, component: lazy(() => import('./Answers.tsx')) }),
    // Settings → Usage: Crew track record (v1 #openRecord)
    defineExtension({ id: 'wisp.crew.usage', attachTo: { id: 'shell.settings:usage' }, component: lazy(() => import('./UsageRow.tsx')) }),
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
    // Import crew members: a shared .crew.json, its JSON or a link (v1 crew-share.js importCrew)
    defineView({ kind: VIEW.import, slot: 'overlay', overlay: 'dialog', parse: (p) => p, title: () => t('wisp.crew.import.title'), component: lazy(() => import('./ImportCrew.tsx')) }),
    // the crew's track record (v1 crew-record.js): Settings → Usage's Crew track record
    defineView({ kind: VIEW.record, slot: 'overlay', overlay: 'dialog', parse: () => null, title: () => t('wisp.crew.record.title'), component: lazy(() => import('./Record.tsx')) }),
    // Org: who hands work to whom (v1 org.js, F-crew-14), in the main pane
    defineView({ kind: VIEW.org, slot: 'main', parse: () => null, title: () => t('wisp.crew.org.title'), component: lazy(() => import('./OrgPage.tsx')) }),
    defineView({
      kind: VIEW.editor,
      slot: 'overlay',
      overlay: 'dialog',
      size: 'v1',
      parse: parseEditor,
      title: (p) => t(p.id ? 'wisp.crew.editor.edit' : p.task ? 'wisp.crew.editor.addTask' : 'wisp.crew.editor.add'),
      component: lazy(() => import('./CrewEditor.tsx')),
    }),
  ],
  commands: [],
  catalogue,
});
