// Home as v1 shows it (web/js/features/split.js renderHome, launcher.js, tips.js): the greeting, the
// prompt box, what needs you (up to five), the tips. Every control answers at once
// (design/feedback.md): a pick changes its label, a toggle flips, a menu opens, and sending shows the
// new task's row and page straight away (Starting…), the box cleared; a refusal puts the text back
// and the client toasts why.

import { useProjects } from './projects.ts';
import { usePromptMenu } from './prompt-menu.ts';
import { RunnerPicker } from './RunnerPicker.tsx';
import { useAttachments } from './attach.ts';
import { createEffect, createMemo, createSignal, onCleanup, type JSX } from 'solid-js';
import { entityKey, uuidv7, type EntityKey, type Json } from '@wisp/client';
import { KeysHint, Launcher, NextList, SplitHome, Tips, useSignal, type LauncherChip, type LauncherTool, type PlainTip } from '@wisp/ui';
import { useShell } from '../context.tsx';
import { Slot, usePluginClient } from '../slot.tsx';
import { useNow } from '../clock.ts';
import { SESSION, type SessionRow } from '../rows.ts';
import { longTime, sectionOf, shortAgo, statusOf } from './rows-view.ts';
import { autoPreview, create, setSetting, type Attachment } from './commands.ts';
import { goalGate } from './goal-gate.ts';
import { autoPick, overrideOf, PREVIEW_DEBOUNCE, type AutoPreview } from './auto.ts';
import { defaultHarness, harnessOf } from './harness.ts';
import { MODE_ICON, agentMenu, agentName, modeMenu, teamMenu, teamPrefill, teamRows, whenAt, whenMenu, type Mode, type When } from './pickers.ts';

interface SettingRow {
  readonly key: string;
  readonly value: unknown;
}

const TIPS = ['goal1', 'goal2', 'vs', 'compare', 'auto', 'limit'] as const;
const GUIDE = 'https://trywisp.dev/guides';

export function HomeView(props: { readonly onBack?: () => void }): JSX.Element {
  const shell = useShell();
  const t = shell.t;
  const home = usePluginClient('shell').home;
  const sessions = useSignal(shell.client.entities.list<SessionRow>(SESSION));
  const { list: projects, reorder } = useProjects(shell, usePluginClient('shell').home);
  const settings = useSignal(shell.client.entities.list<SettingRow>('setting'));
  const now = useNow(shell.client);
  const harnesses = useSignal(shell.harnesses());
  /** what Auto runs today: the default harness (wisp's router picks per task once it's there) */
  const auto = (): string => defaultHarness(harnesses()) ?? '';
  const [text, setText] = createSignal('');
  const [mode, setMode] = createSignal<Mode>('auto');
  const [agent, setAgent] = createSignal('auto');
  // the model and thinking level picked for the harness (Default: '')
  const [model, setModel] = createSignal('');
  const [effort, setEffort] = createSignal('');
  const [picker, setPicker] = createSignal(false);
  const [compare, setCompare] = createSignal<string | undefined>(undefined);
  const [team, setTeam] = createSignal<ReadonlySet<string>>(new Set());
  // the team new tasks start with (Settings, `runtime.subagents`): pre-filled until you pick your own
  let teamTouched = false;
  const subagents = (): unknown => settings().find((r) => r.key === 'runtime.subagents')?.value;
  createEffect(() => {
    const pre = teamPrefill(subagents());
    if (!teamTouched) setTeam(pre);
  });
  const pickTeam = (next: ReadonlySet<string>): void => {
    teamTouched = true;
    setTeam(next);
  };
  const [goal, setGoal] = createSignal<string | undefined>(undefined);
  const [when, setWhen] = createSignal<When | undefined>(undefined);
  // files with the new task: picked, pasted or dropped, each uploading at once to this computer
  const att = useAttachments(shell, () => home);
  const files = att.files;
  const [picking, setPicking] = createSignal(false);
  const [where, setWhere] = createSignal<string | undefined>(undefined); // a project id, 'none', or the first project
  const [tipAt, setTipAt] = createSignal(0);
  // what Auto would run for the prompt (v1 auto-preview.js): asked after a pause in typing, the newest answer wins;
  // kept when you then pick your own harness, so the task tells Auto what it had shown (autoOverride)
  const [preview, setPreview] = createSignal<AutoPreview | undefined>(undefined);
  let asked = 0;
  const scope = shell.client.scope.child('home');
  onCleanup(() => scope.dispose());
  let cancel: (() => void) | undefined;
  const ask = (v: string): void => {
    cancel?.();
    if (agent() !== 'auto') return;
    const n = ++asked;
    if (!v.trim()) return void setPreview(undefined);
    cancel = scope.timeout(PREVIEW_DEBOUNCE, () => {
      shell.client.commands
        .run(autoPreview, {
          peer: home,
          prompt: v.trim(),
          ...(files().length > 0 && { attachments: files().length }),
          ...(goal() ? { goal: goal() as string } : {}),
          ...(team().size > 0 && { team: true }),
        })
        .then((p) => n === asked && setPreview(p))
        .catch(() => undefined);
    });
  };
  let input: HTMLTextAreaElement | undefined;
  onCleanup(shell.focusTargets.provide('launcher', () => input?.focus()));
  // a plugin may fill this prompt (Start from an issue): set it, the caret at its end
  const box = { text: () => text(), set: (v: string) => (setText(v), menu.typed(v)), focus: () => (input?.focus(), input?.setSelectionRange(input.value.length, input.value.length)) };
  if (shell.prompts) onCleanup(shell.prompts.provide('launcher', box));
  // v1 puts the caret in the prompt a beat after Home shows
  queueMicrotask(() => input?.focus());
  const project = createMemo(() => (where() === 'none' ? undefined : (projects().find((p) => p.id === where()) ?? projects()[0])));
  const worktree = createMemo(() => settings().find((r) => r.key === 'defaults.worktree')?.value !== false);
  const needs = createMemo(() =>
    sessions()
      .filter((s) => !s.archived && sectionOf(s) === 'needs')
      .sort((a, b) => b.updated_at - a.updated_at),
  );
  // the @ and / menus (plugins' prompt sources), New task's own
  const menu = usePromptMenu({ shell, where: 'home', text, setText, input: () => input, id: 'launcher-suggest', project: () => project()?.path });
  let goalInput: HTMLInputElement | undefined;
  const send = (): void => {
    const prompt = menu.encode(text().trim());
    // Goal on and Done when empty: ask first, so a task meant to keep going doesn't start as a one-shot (v1 #769)
    const gate = goalGate(prompt, goal());
    if (gate === 'askGoal') {
      goalInput?.focus();
      shell.toast.show(t('shell.goal.empty'), { action: { label: t('shell.goal.sendWithout'), onClick: () => (setGoal(undefined), send()) } });
      return;
    }
    if (gate !== 'send') {
      if (gate === 'sayWhat') shell.toast.show(t('shell.goal.sayWhat'));
      input?.focus();
      return;
    }
    menu.reset();
    const p = project();
    const id = entityKey(home, uuidv7());
    const g = goal();
    // a plugin's prompt source may take it (`/sandbox …`: a sandbox of its own), with what New task picked
    const launch = { ...(p && { cwd: p.path }), agent: agent(), mode: mode(), ...(model() && { model: model() }), ...(effort() && { effort: effort() }), ...(g && { goal: g }) };
    const pc = shell.client.plugin('shell');
    if (
      files().length === 0 &&
      shell
        .promptSources()()
        .some((s) => (s.where ?? ['home']).includes('home') && s.send?.(prompt, { client: pc, task: '', launch }) === true)
    ) {
      setText('');
      setGoal(undefined);
      return;
    }
    // the row and the page at once (optimistic), the box cleared; a refusal puts the text back. With files, the
    // task starts once they're up (usually already: they went when they were added)
    setText('');
    // Auto with a preview: the router picks on the peer (the same pick); the row shows it until the peer's arrives
    const ap = agent() === 'auto' ? autoPick(preview()) : undefined;
    const ov = overrideOf(preview(), { agent: agent(), model: model() });
    const runner = { agent: ap ? 'auto' : agent() === 'auto' ? auto() : agent(), ...(ap && { shows: ap.agent }), ...(ov && { autoOverride: ov }) };
    asked++;
    setPreview(undefined);
    const go = (attachments: readonly Attachment[]): void => {
      shell.client.commands
        .run(create, {
          peer: home,
          id,
          prompt,
          ...runner,
          mode: mode(),
          at: Date.now(),
          ...(p && { cwd: p.path, projectId: p.id, color: p.color }),
          ...(g && { goal: g }),
          ...(attachments.length > 0 && { attachments }),
          ...(agent() !== 'auto' && model() && { model: model() }),
          ...(agent() !== 'auto' && effort() && { effort: effort() }),
          ...(team().size > 0 && { team: teamRows(team(), subagents(), (a) => agentName(t, harnesses(), a)) }),
        })
        .catch(() => setText(prompt));
      shell.navigate({ t: 'openTask', id: id as EntityKey as never });
    };
    if (files().length === 0) go([]);
    else void att.take().then(go);
  };
  const attach = (): void => {
    setPicking(true);
    void shell.platform.pickFiles({ multiple: true }).then((picked) => {
      setPicking(false);
      if (picked.length) att.add(picked);
    });
  };
  const tool = (id: string, part: string, icon: LauncherTool['icon'], label: string, title: string, more: Partial<LauncherTool> = {}): LauncherTool => ({ id, part, icon, label, title, ...more });
  const view = (id: string): void => shell.navigate({ t: 'openView', id: id as never, params: null as Json });
  const settingsSheet = (pane: string): void => shell.navigate({ t: 'openOverlay', overlay: { kind: 'viewer', id: 'shell-settings.sheet' as never, params: { pane } } });
  const shown = (): { agent: string; label: string } | undefined => (agent() === 'auto' ? autoPick(preview()) : undefined);
  const pick = (): { name: string; logo?: string } => harnessOf(harnesses(), shown()?.agent ?? (agent() === 'auto' ? auto() : agent()));
  const chips = (): LauncherChip[] => [
    ...projects().map((p) => ({ id: p.id, kind: 'project' as const, name: p.name, title: p.path, color: p.color || 'slate', on: project()?.id === p.id, act: { onClick: () => setWhere(p.id) } })),
    { id: 'none', kind: 'none', name: t('shell.home.noFolder'), title: t('shell.home.noFolderTitle'), on: where() === 'none', act: { onClick: () => setWhere('none') } },
    {
      id: 'pick',
      kind: 'pick',
      name: t('shell.home.otherFolder'),
      title: t('shell.home.otherFolderTitle'),
      act: {
        menu: {
          items: [
            ...projects().map((p) => ({ value: p.id, label: p.name, hint: p.path })),
            { kind: 'separator' as const },
            { value: 'add', label: t('shell.home.addProject'), icon: 'folder' as const },
          ],
          onSelect: (v: string) => (v === 'add' ? shell.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: 'shell.projects' as never, params: null } }) : setWhere(v)),
        },
      },
    },
  ];
  const extras = () => [
    ...files().map((f, i) => ({ id: `file:${i}:${f.name}`, icon: 'clip' as const, label: f.name, removeLabel: t('shell.home.remove', { name: f.name }), onRemove: () => att.remove(f) })),
    ...(when()
      ? [{ id: 'when', icon: 'clock' as const, label: t('shell.when.chip', { when: t(`shell.when.${when()}`) }), removeLabel: t('shell.when.clear'), onRemove: () => setWhen(undefined) }]
      : []),
  ];
  const tips = (): PlainTip[] =>
    [0, 1, 2]
      .map((k) => TIPS[(tipAt() + k) % TIPS.length] ?? 'goal1')
      .map((id) => ({ before: t(`shell.tips.${id}`), bold: t(`shell.tips.${id}b`), after: t(`shell.tips.${id}a`), href: `${GUIDE}#${id}` }));
  return (
    <SplitHome greeting={t('shell.home.hello')} {...(props.onBack && { onBack: props.onBack, backLabel: t('shell.home.back') })}>
      <Launcher
        inLabel={t('shell.home.in')}
        chips={chips()}
        onReorder={reorder}
        placeholder={t('shell.home.placeholder')}
        value={text()}
        onInput={(v) => {
          setText(v);
          menu.typed(v);
          ask(v);
        }}
        onSend={send}
        suggest={menu.suggest()}
        onPaste={att.paste}
        onFiles={att.add}
        inputRef={(el) => (input = el)}
        mode={{ label: t(`shell.mode.${mode()}`), title: t('shell.home.fullAutoTitle'), icon: MODE_ICON[mode()], act: { menu: { items: modeMenu(t, mode()), onSelect: (v) => setMode(v as Mode) } } }}
        runner={{
          label: agentName(t, harnesses(), agent()),
          title: t('shell.home.autoTitle'),
          pick: shown()?.label ?? [pick().name, agent() !== 'auto' && model() ? model() : '', agent() !== 'auto' ? effort() : ''].filter(Boolean).join(' · '),
          pickTitle: shown() ? t('shell.home.autoWhy', { label: preview()?.pick?.label ?? '', why: preview()?.why ?? '' }) : t('shell.home.pickTitle', { name: pick().name }),
          ...(pick().logo && { logo: pick().logo }),
          compare: compare() ? t('shell.home.compareWith', { name: agentName(t, harnesses(), compare() ?? '') }) : t('shell.home.compare'),
          act: { menu: { items: agentMenu(t, harnesses(), agent()), onSelect: (a) => (setAgent(a), setModel(''), setEffort('')) } },
          // the searchable harness · model picker (v1 runner-picker.js)
          pickAct: { onClick: () => setPicker(true) },
          compareAct: { menu: { items: agentMenu(t, harnesses(), compare() ?? '', false), onSelect: (v) => setCompare(compare() === v ? undefined : v) } },
        }}
        lead={[
          tool('attach', 'launcher.attach', 'clip', t('shell.home.attach'), t('shell.home.attach'), { act: { onClick: attach, pending: picking() } }),
          tool('where', 'launcher.where', 'laptop', t('shell.home.where'), t('shell.home.where'), {
            text: false,
            act: {
              menu: {
                items: [
                  { value: 'here', label: t('shell.card.thisComputer'), icon: 'laptop', checked: true },
                  { kind: 'separator' },
                  { value: 'add', label: t('shell.home.addMachine'), icon: 'plus' },
                ],
                onSelect: (v) => v === 'add' && view('machine.this'),
              },
            },
          }),
        ]}
        mid={[
          // v1 #771: no Try it two ways button; the runner's + adds the second run
          tool('team', 'launcher.team', 'agent', t('shell.home.delegate'), t('shell.home.delegateTitle'), {
            text: true,
            ...(team().size > 0 && { on: true }),
            act: {
              menu: {
                items: teamMenu(t, harnesses(), team()),
                onSelect: (v) => {
                  const next = new Set(team());
                  if (next.has(v)) next.delete(v);
                  else next.add(v);
                  pickTeam(next);
                },
              },
            },
          }),
        ]}
        tail={[
          tool('goal', 'launcher.goal', 'target', t('shell.home.goal'), t('shell.home.goalTitle'), {
            text: true,
            ...(goal() !== undefined && { on: true }),
            act: { onClick: () => setGoal(goal() === undefined ? '' : undefined) },
          }),
          tool('worktree', 'launcher.worktree', 'branch', worktree() ? t('shell.home.worktree') : t('shell.home.inPlace'), t('shell.home.worktreeTitle'), {
            text: true,
            on: worktree(),
            act: { onClick: () => void shell.client.commands.run(setSetting, { peer: home, key: 'defaults.worktree', value: !worktree() }).catch(() => undefined) },
          }),
          tool('later', 'launcher.later', 'clock', t('shell.home.later'), t('shell.home.later'), {
            ...(when() && { on: true }),
            act: { menu: { items: whenMenu(t), onSelect: (v) => setWhen(v as When) } },
          }),
        ]}
        sendLabel={when() ? t('shell.when.send', { at: new Date(whenAt(when() ?? 'hour', now())).toLocaleString() }) : t('shell.home.send')}
        {...(goal() !== undefined && {
          goal: { label: t('shell.home.goal'), placeholder: t('shell.home.goalPlaceholder'), value: goal() ?? '', onInput: setGoal, ref: (el: HTMLInputElement) => (goalInput = el) },
        })}
        extras={extras()}
        recipes={{
          label: t('shell.home.recipes'),
          empty: t('shell.home.recipesEmpty'),
          add: t('shell.home.recipesNew'),
          issue: t('shell.home.issue'),
          issueTitle: t('shell.home.issueTitle'),
          addAct: { onClick: () => settingsSheet('recipes') },
          // Start from an issue (wisp.issues' picker, an overlay view; without that plugin, navigation drops it)
          issueAct: {
            onClick: () => shell.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: 'issues.picker' as never, params: { project: project()?.id ?? '', name: project()?.name ?? '' } } }),
          },
        }}
      />
      <RunnerPicker
        open={picker()}
        onOpenChange={setPicker}
        peer={home}
        value={{ agent: agent() === 'auto' ? auto() : agent(), model: model(), effort: effort() }}
        onChange={(r) => {
          setAgent(r.agent);
          setModel(r.model);
          setEffort(r.effort);
        }}
      />
      <NextList
        heading={t('shell.section.needs')}
        count={needs().length}
        rows={needs()
          .slice(0, 5)
          .map((s) => ({
            id: s.id,
            title: s.title,
            color: String(s.summary['color'] ?? 'slate'),
            state: statusOf(s, t).label,
            time: shortAgo(s.updated_at, now()),
            timeTitle: longTime(s.updated_at),
          }))}
        onOpen={(id) => shell.navigate({ t: 'openTask', id: id as EntityKey as never })}
      />
      {/* notes on plans other plugins add (wisp.budget's Spare allowance), v1 .sh-spare */}
      <Slot input="shell.home:cards" layout="contents" pickAgent={(a) => setAgent(a)} />
      <Tips
        heading={t('shell.tips.heading')}
        more={t('shell.tips.more')}
        moreTitle={t('shell.tips.moreTitle')}
        onMore={() => setTipAt((tipAt() + 3) % TIPS.length)}
        onOpen={(href) => shell.platform.openExternal(href)}
        setup={[
          { kind: 'tool', icon: 'github', title: t('shell.tips.github'), body: t('shell.tips.githubBody'), cta: t('shell.tips.signIn'), onClick: () => settingsSheet('accounts') },
          { kind: 'grid', icon: 'cloud', title: t('shell.tips.grid'), body: t('shell.tips.gridBody'), cta: t('shell.tips.setUp'), onClick: () => settingsSheet('cloud') },
        ]}
        tips={tips()}
      />
      <KeysHint
        items={[
          { keys: ['J', 'K'], label: t('shell.keys.move') },
          { keys: ['↵'], label: t('shell.keys.open') },
          { keys: ['E'], label: t('shell.keys.done') },
          { keys: ['Esc'], label: t('shell.keys.back') },
          { keys: ['['], label: t('shell.keys.hide') },
        ]}
      />
    </SplitHome>
  );
}
