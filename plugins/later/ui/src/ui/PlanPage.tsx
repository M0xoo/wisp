// `later.plan`: a scheduled task or reminder that hasn't started, or a /draft, opened from its row in Scheduled
// or Drafts (v1 features/plan-view.js). The task page's shape: its head (its title, Close), the box where you
// change what it will say (saved when you leave it: Save, ⌘Enter, clicking away, Start now, closing the page),
// and the details column: when it starts (a time, a task it waits for, or a draft), what it runs on, its mode and
// folder, then Start now, Change time… and Delete by the row menu's names. When it starts its task takes the page.
import { Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from 'solid-js';
import { entityKey, ownerOf, type EntityKey, type PluginClient, type SessionId } from '@wisp/client';
import { Stack, TaskBody, TaskDetails, TaskHead, Text, TextArea, Button, Inline, useSignal, type TaskAction } from '@wisp/ui';
import { cancelPlan, editPlan, startPlan } from '../commands.ts';
import { useShell } from '@wisp/shell';
import { aheadLabel, planTimeLabel, runLine, timeChoices, whenTip } from '../format.ts';
import { nowOf } from '../host.ts';
import { t } from '../i18n.ts';
import type { Plan } from '../types.ts';
import { plans } from './data.ts';
import { planPage } from './plan-page.ts';

export default function PlanPage(props: { readonly client: PluginClient; readonly params: { readonly id?: string } }): JSX.Element {
  const c = props.client;
  const harnesses = useSignal(useShell().harnesses());
  const nameOf = (id: string): string => harnesses().find((h) => h.id === id)?.name ?? id;
  const logoOf = (id: string | undefined): string | undefined => harnesses().find((h) => h.id === (id ?? 'claude'))?.logo;
  // its rows are wisp.later's own topic (the list watches it too)
  c.watch(c.home, 'plugin:wisp.later:later' as never);
  const all = useSignal(plans(c));
  const found = createMemo(() => all().find((x) => x.key === props.params.id || x.plan.id === props.params.id));
  const [draft, setDraft] = createSignal<string | undefined>();
  const [starting, setStarting] = createSignal(false);
  const quiet = (p: Promise<unknown>): void => void p.catch(() => {}); // the shell's toast says why
  const home = (): void => c.navigate({ t: 'home' });
  // what the box holds now, against what the plan says: the page's whole state
  const page = createMemo(() => {
    const f = found();
    return f ? planPage(f.plan, draft(), nowOf(c)) : undefined;
  });
  const save = (): void => {
    const f = found();
    const p = page();
    if (!f || !p?.dirty || p.empty) return;
    quiet(c.run(editPlan, f.plan.kind === 'task' ? { id: f.key, prompt: p.text } : { id: f.key, text: p.text }));
    setDraft(undefined);
  };
  // closing the page (another task, Back) saves what's in the box
  onCleanup(save);
  // it started or was deleted elsewhere: back to the list (Start now here opens its task itself)
  let seen = false;
  createEffect(() => {
    if (found()) seen = true;
    else if (seen && !starting()) home();
  });
  const startNow = (f: { key: string; plan: Plan }): void => {
    save();
    setStarting(true);
    c.run(startPlan, { id: f.key, now: true }).then(
      (r) => (r.session?.id ? c.navigate({ t: 'openTask', id: entityKey(ownerOf(f.key as EntityKey), r.session.id) as unknown as SessionId }) : home()),
      () => setStarting(false),
    );
  };
  const actions = (f: { key: string; plan: Plan }): TaskAction[] => {
    const task = f.plan.kind === 'task';
    return [
      { id: 'now', icon: task ? 'play' : 'bell', label: t(task ? 'wisp.later.plan.startNow' : 'wisp.later.plan.remindNow'), title: t(task ? 'wisp.later.plan.startNow' : 'wisp.later.plan.remindNow'), part: 'plan.now', act: { onClick: () => startNow(f), pending: starting() } },
      {
        id: 'time',
        icon: 'clock',
        label: planTimeLabel(f.plan),
        title: planTimeLabel(f.plan),
        part: 'plan.time',
        act: { menu: { items: timeChoices(nowOf(c)).map(([label, at]) => ({ value: String(at), label, hint: aheadLabel(at, nowOf(c)) })), onSelect: (v) => quiet(c.run(editPlan, { id: f.key, at: Number(v) })) } },
      },
      { id: 'delete', icon: 'trash', label: t(task ? 'wisp.later.plan.delete' : 'wisp.later.plan.deleteReminder'), title: t(task ? 'wisp.later.plan.delete' : 'wisp.later.plan.deleteReminder'), part: 'plan.delete', act: { onClick: () => (quiet(c.run(cancelPlan, { id: f.key })), home()) } },
    ];
  };
  return (
    <Show when={found()}>
      {(f) => (
        <Stack gap="0" grow part="plan.page">
          <TaskHead title={page()?.title ?? ''} color="slate" renameLabel="" panelLabel="" closeLabel={t('wisp.later.plan.close')} backLabel={t('wisp.later.plan.back')} onBack={home} onClose={home} />
          <TaskBody
            details={
              <TaskDetails
                harness={f().plan.kind === 'task' ? runLine(f().plan, nameOf) : (page()?.runsOn ?? '')}
                {...(logoOf(f().plan.body?.agent) && { logo: logoOf(f().plan.body?.agent) as string })}
                project={page()?.project ?? ''}
                color="slate"
                when={{ icon: f().plan.draft ? 'pen' : f().plan.after ? 'queue' : f().plan.kind === 'task' ? 'clock' : 'bell', label: page()?.when ?? '', ...(f().plan.at && !f().plan.draft && { title: whenTip(f().plan.at ?? 0, nowOf(c)) }) }}
                actions={actions(f())}
              />
            }
            turns={
              <Stack gap="2" part="plan.box">
                <TextArea
                  aria-label={t('wisp.later.plan.prompt')}
                  value={page()?.text ?? ''}
                  autosize
                  minRows={3}
                  maxRows={20}
                  onInput={setDraft}
                  onBlur={save}
                  onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      save();
                    }
                  }}
                />
                <Inline gap="2" justify="between" part="plan.bar">
                  <Text size="sm" tone="muted" {...(f().plan.at && { title: whenTip(f().plan.at ?? 0, nowOf(c)) })}>
                    {t(page()?.hint ?? 'wisp.later.plan.hint.task', { mod: /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '') ? '⌘' : 'Ctrl+' })}
                  </Text>
                  <Show when={page()?.dirty}>
                    <Inline gap="1">
                      <Button size="xs" variant="ghost" onClick={() => setDraft(undefined)}>
                        {t('wisp.later.plan.revert')}
                      </Button>
                      <Button size="xs" variant="ghost" disabled={page()?.empty === true} onClick={save}>
                        {t('wisp.later.plan.save')}
                      </Button>
                    </Inline>
                  </Show>
                </Inline>
              </Stack>
            }
            dock={null}
          />
        </Stack>
      )}
    </Show>
  );
}

