// A crew member's page (v1 crew.js buildView): the area `shell.screen:crew` fills when a face on the rail is
// picked. The head (face, name, role, what it's doing, Pause or Resume, More, Close), the thread of its jobs
// (oldest first, quiet check-ins folded), what it is and how it works beside it (or folded above on a narrow
// pane), and the box that gives it a job. Every write shows at once (crew.update, crew.assign) and rolls back
// with the shell's toast when refused.
import { createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import { uuidv7 } from '@wisp/client';
import { useShell, type ExtensionProps } from '@wisp/shell';
import {
  Button,
  CrewEmpty,
  CrewFacts,
  CrewJob,
  CrewQuiet,
  CrewSection,
  CrewSideActions,
  CrewText,
  CrewView,
  Dialog,
  EmptyState,
  englishT,
  Face,
  IconButton,
  Menu,
  TextArea,
  timeLabel,
  useSignal,
} from '@wisp/ui';
import { assignJob, checkIn, removeMember, updateMember, type MemberPatch } from './commands.ts';
import { crewData, emptyState } from './data.ts';
import { t } from './i18n.ts';
import { cadenceLabel, JOB_ICON, originLabel, statusLine } from './model.ts';
import { facts, pillOf, quietLabel, thread } from './page.ts';
import type { SessionRow } from './types.ts';
import { VIEW } from './views.ts';

const SHOW = 30;

// size-ok: one screen whose parts share the member, its state and the box's draft
export default function CrewPage(props: ExtensionProps): JSX.Element {
  const c = props.client;
  const shell = useShell();
  const data = crewData(c);
  const members = useSignal(data.members);
  const states = useSignal(data.states);
  const harnesses = useSignal(shell.harnesses());
  const nav = useSignal(shell.nav);
  const member = createMemo(() => (members(), data.byId(props.id)));
  const [draft, setDraft] = createSignal('');
  const [show, setShow] = createSignal(SHOW);
  const [removing, setRemoving] = createSignal(false);
  const [editing, setEditing] = createSignal<'notebook' | 'brief' | undefined>(undefined);
  const [text, setText] = createSignal('');
  const say = t as (k: string, v?: Readonly<Record<string, string | number>>) => string;
  const now = (): number => c.scope.timers.now();
  const ago = (at: number): string => timeLabel(at, now(), englishT);
  // a member with no harness of its own runs on the default one (the first the harness plugins list)
  const harness = (id: string): { name: string; logo?: string | undefined } => {
    if (id === 'auto') return { name: t('wisp.crew.editor.auto') };
    const h = harnesses().find((x) => x.id === id) ?? (id ? undefined : harnesses()[0]);
    return { name: h?.name ?? id, logo: h?.logo };
  };
  const close = (): void => shell.navigate({ t: 'home' });
  const open = (s: SessionRow): void => {
    const key = data.sessionKey(s.id);
    if (key) shell.navigate({ t: 'openTask', id: key as never });
  };
  return (
    <Show when={member()} fallback={<EmptyState icon="crew" title={t('wisp.crew.page.missing')} compact />}>
      {(m) => {
        const st = (): ReturnType<typeof emptyState> => states().get(m().id) ?? emptyState(m().paused);
        const face = (size: 'sm' | 'md' | 'xl', mood?: 'idle' | 'live' | 'asks' | 'sleep'): JSX.Element => (
          <Face avatar={m().avatar} name={m().name} color={m().color} size={size} mood={mood ?? st().mood} dim={m().paused} />
        );
        const line = () => statusLine(m(), st(), { t: say as never, now: now(), when: ago });
        const items = createMemo(() => thread(st().jobs, show()));
        const update = (patch: MemberPatch): void => {
          void c.run(updateMember, { key: m().key, id: m().id, ...patch }).catch(() => undefined);
        };
        const send = (): void => {
          const prompt = draft().trim();
          if (!prompt) return;
          setDraft('');
          c.run(assignJob, { key: m().key, crewId: m().id, job: uuidv7(), prompt, title: prompt.split('\n')[0]?.slice(0, 80) ?? prompt }).catch(() => setDraft(prompt));
        };
        // Edit… (v1 crewEditor): the editor dialog over the page
        const editMember = (): void => c.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: VIEW.editor as never, params: { id: m().id } } });
        const checkin = (): void => void c.run(checkIn, { key: m().key, crewId: m().id }).catch(() => undefined);
        const remove = (): void => {
          setRemoving(false);
          close();
          void c.run(removeMember, { key: m().key, id: m().id }).catch(() => undefined);
        };
        const edit = (which: 'notebook' | 'brief'): void => {
          setText(m()[which] ?? '');
          setEditing(which);
        };
        const save = (): void => {
          const which = editing();
          if (which) update({ [which]: text() });
          setEditing(undefined);
        };
        const editor = (): JSX.Element => (
          <>
            <TextArea value={text()} onInput={setText} minRows={3} maxRows={12} aria-label={t(editing() === 'brief' ? 'wisp.crew.page.brief' : 'wisp.crew.page.notebook')} />
            <span>
              <Button size="xs" variant="primary" onClick={save}>
                {t('wisp.crew.page.save')}
              </Button>{' '}
              <Button size="xs" variant="ghost" onClick={() => setEditing(undefined)}>
                {t('wisp.crew.page.cancel')}
              </Button>
            </span>
          </>
        );
        const empty = (): JSX.Element => (
          <CrewEmpty
            face={face('xl', 'idle')}
            name={m().name}
            first={t('wisp.crew.page.empty.first')}
            second={[
              m().cron ? t('wisp.crew.page.empty.giveCron', { when: cadenceLabel(m().cron, say as never).toLowerCase() }) : t('wisp.crew.page.empty.give'),
              `@${m().name}`,
              t('wisp.crew.page.empty.brings'),
            ]}
          />
        );
        return (
          <>
            <CrewView
              face={face('md')}
              name={m().name}
              role={m().role || undefined}
              state={{ text: line().text, tone: line().tone }}
              back={nav().layout === 'stack' ? { label: t('wisp.crew.page.back'), onClick: close } : undefined}
              actions={
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={m().paused ? 'play' : 'pause'}
                    title={t(m().paused ? 'wisp.crew.page.resume.title' : 'wisp.crew.page.pause.title')}
                    onClick={() => update({ paused: !m().paused })}
                  >
                    {t(m().paused ? 'wisp.crew.page.resume' : 'wisp.crew.page.pause')}
                  </Button>
                  <Menu
                    part="crew.page.more"
                    trigger={{ icon: 'dots', 'aria-label': t('wisp.crew.page.more'), variant: 'ghost', size: 'sm' }}
                    items={[
                      { value: 'edit', label: t('wisp.crew.page.editMember'), icon: 'pen' },
                      { value: 'checkin', label: t('wisp.crew.page.checkin'), icon: 'clock' },
                      { kind: 'separator' },
                      { value: 'remove', label: t('wisp.crew.page.remove'), icon: 'trash', danger: true },
                    ]}
                    onSelect={(v) => (v === 'edit' ? editMember() : v === 'checkin' ? checkin() : setRemoving(true))}
                  />
                  <Show when={nav().layout !== 'stack'}>
                    <IconButton icon="x" label={t('wisp.crew.page.close')} variant="ghost" onClick={close} />
                  </Show>
                </>
              }
              thread={
                <Show when={items().items.length > 0} fallback={empty()}>
                  <For each={items().items}>
                    {(it) =>
                      it.kind === 'quiet' ? (
                        <CrewQuiet label={quietLabel(it.jobs, say as never)} time={ago(it.jobs.at(-1)?.updatedAt ?? 0)} />
                      ) : (
                        <CrewJob
                          id={it.job.id}
                          state={it.job.state}
                          kind={{ icon: JOB_ICON[it.job.crew?.job ?? 'task'], label: originLabel(it.job, say as never), you: it.job.crew?.job === 'task' }}
                          time={ago(it.job.createdAt)}
                          prompt={it.job.crew?.job !== 'checkin' ? it.job.crew?.prompt : undefined}
                          face={face('sm', it.job.state === 'waiting' ? 'asks' : it.job.state === 'running' ? 'live' : 'idle')}
                          pill={pillOf(it.job, say as never)}
                          live={it.job.state === 'running' ? it.job.live || t('wisp.crew.page.starting') : undefined}
                          title={it.job.title}
                          summary={it.job.preview}
                          question={it.job.state === 'waiting' ? it.job.question || it.job.live || it.job.title : undefined}
                          unread={!!it.job.unread && it.job.state === 'review'}
                          actions={[{ icon: 'expand', label: t('wisp.crew.page.open'), onClick: () => open(it.job) }]}
                        />
                      )
                    }
                  </For>
                </Show>
              }
              earlier={items().earlier ? { label: t('wisp.crew.page.earlier', { n: items().earlier }), onClick: () => setShow(show() + SHOW) } : undefined}
              about={{ label: t('wisp.crew.page.about', { name: m().name }), hint: line().text }}
              side={
                <>
                  <CrewFacts items={facts(m(), { t: say as never, harness, place: (id) => id, onTeam: () => c.navigate({ t: 'openView', id: VIEW.org as never, params: null }) })} />
                  <CrewSideActions
                    items={[
                      { icon: 'clock', label: t('wisp.crew.page.checkin'), act: { onClick: checkin } },
                      { icon: 'pen', label: t('wisp.crew.page.editMember'), act: { onClick: editMember } },
                      { icon: 'trash', label: t('wisp.crew.page.remove'), danger: true, act: { onClick: () => setRemoving(true) } },
                    ]}
                  />
                  <CrewSection
                    part="crew.notebook"
                    title={t('wisp.crew.page.notebook')}
                    link={editing() === 'notebook' ? undefined : { label: t('wisp.crew.page.edit'), onClick: () => edit('notebook') }}
                  >
                    <Show
                      when={editing() === 'notebook'}
                      fallback={<CrewText text={m().notebook || t('wisp.crew.page.notebook.empty')} empty={!m().notebook} dashed={!m().notebook} onClick={() => edit('notebook')} />}
                    >
                      {editor()}
                    </Show>
                  </CrewSection>
                  <CrewSection part="crew.brief" title={t('wisp.crew.page.brief')} link={editing() === 'brief' ? undefined : { label: t('wisp.crew.page.edit'), onClick: () => edit('brief') }}>
                    <Show when={editing() === 'brief'} fallback={<CrewText text={m().brief || t('wisp.crew.page.brief.empty')} empty={!m().brief} />}>
                      {editor()}
                    </Show>
                  </CrewSection>
                  <CrewSection part="crew.kit" title={t('wisp.crew.page.kit')}>
                    <CrewText text={m().kit?.length ? t('wisp.crew.page.kit', { count: m().kit.length }) : t('wisp.crew.page.kit.empty')} empty={!m().kit?.length} />
                  </CrewSection>
                </>
              }
              dock={{
                placeholder: t('wisp.crew.page.placeholder', { name: m().name }),
                value: draft(),
                onInput: setDraft,
                onSend: send,
                send: t('wisp.crew.page.send'),
                checkIn: { label: t('wisp.crew.page.checkin'), title: t('wisp.crew.page.checkin.title'), act: { onClick: checkin } },
              }}
            />
            <Dialog
              open={removing()}
              onOpenChange={setRemoving}
              size="sm"
              role="alertdialog"
              title={t('wisp.crew.page.remove.confirm', { name: m().name })}
              description={t('wisp.crew.page.remove.why')}
              footer={
                <>
                  <Button variant="secondary" size="sm" onClick={() => setRemoving(false)}>
                    {t('wisp.crew.page.cancel')}
                  </Button>
                  <Button variant="danger" size="sm" onClick={remove}>
                    {t('wisp.crew.page.remove.ok', { name: m().name })}
                  </Button>
                </>
              }
            />
          </>
        );
      }}
    </Show>
  );
}
