// Home as v1 shows it (web/js/features/split.js renderHome, launcher.js, tips.js): the greeting, the
// prompt box, what needs you (up to five), the tips. Every control answers at once
// (design/feedback.md): a pick changes its label, a toggle flips, a menu opens, and sending shows the
// new task's row and page straight away (Starting…), the box cleared; a refusal puts the text back
// and the client toasts why.

import { useProjects } from './projects.ts';
import { usePromptMenu } from './prompt-menu.ts';
import { RunnerPicker } from './RunnerPicker.tsx';
import { useAttachments } from './attach.ts';
import { attachAct } from './capture.ts';
import { useMic } from './dictate.ts';
import { warm, warmer } from './warm.ts';
import { INSTALLABLE, useSetup } from './setup.ts';
import { useRecipes } from './recipes.ts';
import type { PickOptions } from '../platform/types.ts';
import { Show, createEffect, createMemo, createSignal, on, onCleanup, type JSX } from 'solid-js';
import { entityKey, uuidv7, type EntityKey, type Json, type PeerId } from '@wisp/client';
import { AutoPop, FeedbackLine, KeysHint, Launcher, NextList, SplitHome, Tips, useSignal, type LauncherChip, type LauncherTool, type PlainTip } from '@wisp/ui';
import { useShell } from '../context.tsx';
import { Slot, usePluginClient } from '../slot.tsx';
import { useNow } from '../clock.ts';
import { SESSION, type SessionRow } from '../rows.ts';
import { longTime, sectionOf, shortAgo, statusOf } from './rows-view.ts';
import { autoBlocked, autoPreview, autoRules, create, setSetting, type Attachment } from './commands.ts';
import { goalGate, goalOf, goalSent, isBareGoal, type HomeGoal } from './goal-gate.ts';
import { feedbackCommand, isFeedback, openFeedback } from './feedback.ts';
import { autoPick, neverRule, overrideOf, popOf, pct, PREVIEW_DEBOUNCE, shortLabel, usd, type AutoPreview } from './auto.ts';
import { defaultHarness, harnessOf } from './harness.ts';
import { MAX_RUNNERS, newGroup, nextRun } from './compare.ts';
import { firstRunOf, firstRunTools, launcherFull } from './first-run.ts';
import { whereItems } from './where.ts';
import { placeOn } from './run-on.ts';
import { alsoToggle, dirsOf, launchOf, parsePick } from './project-pick.ts';
import { promptKeys, remember, sentStore } from './prompt-keys.ts';
import { draftValue, launcherDraft } from './drafts.ts';
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
  // Run on (v1 launch.where): this computer, or another one you added (machines); only one at a time (F-comp-10)
  const peerIds = useSignal(shell.client.peers.list());
  const [runOn, setRunOn] = createSignal<string>(home);
  const target = (): PeerId => (peerIds().includes(runOn() as PeerId) ? runOn() : home) as PeerId;
  const sessions = useSignal(shell.client.entities.list<SessionRow>(SESSION));
  const { list: projects, reorder } = useProjects(shell, usePluginClient('shell').home);
  const settings = useSignal(shell.client.entities.list<SettingRow>('setting'));
  const now = useNow(shell.client);
  const harnesses = useSignal(shell.harnesses());
  /** what Auto runs today: the default harness (wisp's router picks per task once it's there) */
  const auto = (): string => defaultHarness(harnesses()) ?? '';
  // New task's text is a draft (kind 5): kept across reloads and updates (v1 F-task-32), under `<home>:launcher` → text,
  // where wisp.stuff's share-in puts what was shared to wisp
  const [draftKey, draftField] = launcherDraft(home);
  const draft = useSignal(shell.client.drafts.get<string>(draftKey, draftField));
  const text = (): string => draft() ?? '';
  const setText = (v: string): void => shell.client.drafts.set(draftKey, draftField, draftValue(v));
  const [mode, setMode] = createSignal<Mode>('auto');
  const [agent, setAgent] = createSignal('auto');
  // the model and thinking level picked for the harness (Default: '')
  const [model, setModel] = createSignal('');
  const [effort, setEffort] = createSignal('');
  // the account picked for the harness ('' : Auto, your saved one) and its name for the bar (F-acct-3)
  const [account, setAccount] = createSignal<{ id: string; label: string } | undefined>();
  const pickAgent = (a: string): void => {
    setAgent(a);
    setModel('');
    setEffort('');
    setAccount(undefined);
  };
  const [picker, setPicker] = createSignal(false);
  // What Auto will run (v1 auto-preview.js openPop): from the Auto pick while Auto picks
  const [autoPop, setAutoPop] = createSignal(false);
  // v1 modelLabel: the model alone (what a Never rule acts on), or "<harness>'s default model"
  const neverModel = (pk: { agent: string; model: string; label: string }): string =>
    pk.model ? (pk.label.split(' · ')[1] ?? pk.model) : t('shell.auto.defaultModel', { name: agentName(t, harnesses(), pk.agent) });
  const typeWord = (type: string): string => (type === 'ui' ? 'UI' : type);
  // Never pick this model for this kind of task: said at once with Undo, the toast says why if the peer refuses
  const never = async (pk: { agent: string; model: string; label: string }, type: string): Promise<void> => {
    const rule = neverRule(pk, type);
    const now = await shell.client.commands.run(autoRules, { peer: home }).then(
      (v) => v.settings?.blocked ?? [],
      () => [] as string[],
    );
    if (now.includes(rule)) return;
    const set = (list: readonly string[]): Promise<unknown> => shell.client.commands.run(autoBlocked, { peer: home, blocked: list }).then(() => ask(text()));
    shell.toast.show(t('shell.auto.wont', { model: neverModel(pk), kind: typeWord(type) }), { action: { label: t('shell.auto.undo'), onClick: () => void set(now).catch(() => undefined) } });
    await set([...now, rule]).catch(() => undefined);
  };
  // Until your first task the box is the prompt, how it runs and Send; the rest waits behind More options (v1
  // launcher.js firstRun). Once opened, or once there's a task of yours, it stays full (kept in this browser).
  const fullStore = launcherFull(shell.client);
  const full = useSignal(fullStore.value);
  const [ready, setReady] = createSignal(false);
  void fullStore.ready.then(() => setReady(true));
  const mine = createMemo(() => sessions().some((x) => x.agent !== 'wisp'));
  createEffect(() => {
    if (mine() && full() !== true) fullStore.set(true);
  });
  const firstRun = (): boolean => firstRunOf(full() === true, mine(), ready());
  const openFull = (): void => {
    fullStore.set(true);
    input?.focus();
  };
  // vs (v1 launcher.js compare): the same task on more harnesses, side by side; picks here don't touch the defaults
  const [runs, setRuns] = createSignal<readonly string[]>([]);
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
  // Goal: off for every new prompt, Done when's text a draft (v1 launcherGoal: `home-goal`, kept over a reload)
  const [goalOn, setGoalOn] = createSignal(false);
  const goalDraft = useSignal(shell.client.drafts.get<string>(draftKey, 'goal'));
  const homeGoal = (): HomeGoal => ({ on: goalOn(), text: goalDraft() ?? '' });
  const putGoal = (g: HomeGoal): void => {
    setGoalOn(g.on);
    shell.client.drafts.set(draftKey, 'goal', draftValue(g.text));
  };
  const goal = (): string | undefined => goalOf(homeGoal());
  const setGoal = (v: string | undefined): void => {
    if (v === undefined) setGoalOn(false);
    else putGoal({ on: true, text: v });
  };
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
  const ask = (v: string, now = false): void => {
    cancel?.();
    if (agent() !== 'auto') return;
    const n = ++asked;
    const go = (): void =>
      void shell.client.commands
        .run(autoPreview, {
          peer: home,
          prompt: v.trim(), // empty too: v1 shows Auto's pick before you type
          ...(files().length > 0 && { attachments: files().length }),
          ...(goal() ? { goal: goal() as string } : {}),
          ...(team().size > 0 && { team: true }),
        })
        .then((p) => n === asked && setPreview(p))
        .catch(() => undefined);
    // typing waits for a pause; the first ask goes at once (once setup is done: what it reads is declared below)
    if (now) {
      cancel = undefined;
      queueMicrotask(() => n === asked && go());
    } else cancel = scope.timeout(PREVIEW_DEBOUNCE, go);
  };
  ask('', true); // v1 refresh({ now: true }): Auto's pick shows from the start
  let input: HTMLTextAreaElement | undefined;
  onCleanup(shell.focusTargets.provide('launcher', () => input?.focus()));
  // a plugin may fill this prompt (Start from an issue): set it, the caret at its end
  const box = { text: () => text(), set: (v: string) => (setText(v), menu.typed(v)), focus: () => (input?.focus(), input?.setSelectionRange(input.value.length, input.value.length)) };
  if (shell.prompts) onCleanup(shell.prompts.provide('launcher', box));
  // v1 puts the caret in the prompt a beat after Home shows; never taken from what holds it already (a menu or a
  // dialog opened while Home was still loading kept its focus in v1, whose Home was there from the start)
  queueMicrotask(() => {
    const at = document.activeElement;
    if (!at || at === document.body) input?.focus();
  });
  // several projects picked over the list (project-pick.ts): New task starts in the first, and also works in the others
  // (runtime.create `dirs`, F-comp-47) until you leave one out with its ×; + on any other chip (or ⌘-click) adds it
  const listFilter = useSignal(shell.projectFilter?.value ?? (() => 'all'));
  const listPick = createMemo(() => launchOf(parsePick(listFilter()), projects()));
  const [ownAlso, setOwnAlso] = createSignal<readonly string[] | undefined>(undefined);
  createEffect(on(listPick, () => setOwnAlso(undefined), { defer: true }));
  const project = createMemo(() => (where() === 'none' ? undefined : (projects().find((p) => p.id === (where() ?? listPick().start)) ?? projects()[0])));
  const also = createMemo(() => (project() ? (ownAlso() ?? listPick().also).filter((id) => id !== project()?.id) : []));
  const pickWhere = (id: string): void => {
    setWhere(id);
    if (also().includes(id)) setOwnAlso(also().filter((x) => x !== id));
  };
  const worktree = createMemo(() => settings().find((r) => r.key === 'defaults.worktree')?.value !== false);
  const needs = createMemo(() =>
    sessions()
      .filter((s) => !s.archived && sectionOf(s) === 'needs')
      .sort((a, b) => b.updated_at - a.updated_at),
  );
  // the @ and / menus (plugins' prompt sources), New task's own
  const menu = usePromptMenu({ shell, where: 'home', text, setText, input: () => input, id: 'launcher-suggest', project: () => project()?.path });
  let goalInput: HTMLInputElement | undefined;
  // ↑ brings back what you sent, Shift+Tab cycles the mode (v1 prompt-history.js, F-task-31, F-comp-4)
  const sent = sentStore(shell.client);
  const sentList = useSignal(sent.value);
  const onKey = promptKeys({ sent: () => sentList() as readonly string[], value: text, set: (v) => (setText(v), menu.typed(v)), mode: { get: mode, set: setMode } });
  const send = (): void => {
    // /feedback … or /bug …: to the wisp team, never a task (v1 launcher.js)
    if (isFeedback(text())) {
      const typed = text();
      setText('');
      return feedbackCommand(shell, typed, { home, restore: () => text() === '' && setText(typed) });
    }
    // a bare /goal: Done when opens, to type it there (v1 box.goalOpen); `/goal <condition>` goes, the peer reads it
    if (isBareGoal(text())) {
      setText('');
      setGoalOn(true);
      queueMicrotask(() => goalInput?.focus());
      return;
    }
    const prompt = menu.encode(text().trim());
    if (prompt) sent.set((cur) => remember(cur as readonly string[], prompt));
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
    const id = entityKey(target(), uuidv7());
    const g = goal();
    // sent: Done when empties and Goal goes off for the next prompt; a refused launch puts both back
    const taken = goalSent(homeGoal());
    if (g !== undefined) putGoal(taken.next);
    // unless Done when was opened and typed in again meanwhile
    const goalBack = (): void => void (g !== undefined && !goalOn() && !goalDraft() && putGoal(taken.back));
    // a plugin's prompt source may take it (`/sandbox …`: a sandbox of its own), with what New task picked
    const w = when();
    const launch = {
      ...(p && { cwd: p.path }),
      agent: agent(),
      mode: mode(),
      ...(model() && { model: model() }),
      ...(effort() && { effort: effort() }),
      ...(g && { goal: g }),
      ...(w && { at: whenAt(w, now()) }),
    };
    const pc = shell.client.plugin('shell');
    if (
      files().length === 0 &&
      shell
        .promptSources()()
        .some((s) => (s.where ?? ['home']).includes('home') && s.send?.(prompt, { client: pc, task: '', launch }) === true)
    ) {
      setText('');
      setWhen(undefined);
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
    // several runs: one group, so Compare runs shows them side by side (v1: one shared groupId)
    const extra = runs();
    const group = extra.length > 0 ? newGroup(crypto.getRandomValues(new Uint8Array(6))) : undefined;
    setRuns([]);
    // the other folders it works in: on this computer only (another one has its own checkouts, placed per folder later)
    const dirs = target() === home ? dirsOf(p, also(), projects()) : [];
    setOwnAlso(undefined);
    const start = (attachments: readonly Attachment[], cwd: string): void => {
      shell.client.commands
        .run(create, {
          peer: target(),
          id,
          prompt,
          ...runner,
          ...(group && { group }),
          mode: mode(),
          at: Date.now(),
          ...(p && { cwd, projectId: p.id, color: p.color, worktree: worktree() }),
          ...(dirs.length > 0 && { dirs }),
          ...(g && { goal: g }),
          ...(attachments.length > 0 && { attachments }),
          ...(agent() !== 'auto' && model() && { model: model() }),
          ...(agent() !== 'auto' && effort() && { effort: effort() }),
          ...((a) => (agent() !== 'auto' && a ? { account: a.id } : {}))(account()),
          ...(team().size > 0 && { team: teamRows(team(), subagents(), (a) => agentName(t, harnesses(), a)) }),
        })
        .catch(() => (setText(prompt), goalBack()));
      // the other runs after the lead, so the lead is run A (Compare orders runs by when they started)
      for (const a of extra) {
        shell.client.commands
          .run(create, {
            peer: target(),
            id: entityKey(target(), uuidv7()),
            prompt,
            agent: a,
            mode: mode(),
            at: Date.now(),
            group: group ?? '',
            // each run of a compare in its own checkout, or they'd edit one folder (v1 forced it)
            ...(p && { cwd, projectId: p.id, color: p.color, worktree: true }),
            ...(dirs.length > 0 && { dirs }),
            ...(attachments.length > 0 && { attachments }),
          })
          .catch(() => undefined);
      }
      shell.navigate({ t: 'openTask', id: id as EntityKey as never });
    };
    // on another computer: its checkout of the project's repo first, found or cloned there (v1 places.js), said meanwhile
    const go = (attachments: readonly Attachment[]): void => {
      const peer = target();
      if (!p || peer === home) return start(attachments, p?.path ?? '');
      const where = shell.client.peers.name(peer);
      shell.toast.show(t('shell.runOn.setting', { name: p.name, where }));
      placeOn({ cwd: p.path, peer, home, name: p.name, where, run: (cmd, args) => shell.client.commands.run(cmd, args), say: (name, w) => t('shell.runOn.noOrigin', { name, where: w }) }).then(
        (cwd) => start(attachments, cwd),
        (err: unknown) => {
          setText(prompt);
          shell.toast.error(err instanceof Error ? err.message : t('shell.runOn.failed', { where }));
        },
      );
    };
    if (files().length === 0) go([]);
    else void att.take().then(go);
  };
  const attach = (o: PickOptions): void => {
    setPicking(true);
    void shell.platform.pickFiles(o).then((picked) => {
      setPicking(false);
      if (picked.length) att.add(picked);
    });
  };
  // the repo is fetched while you type, so Send starts at once (v1 warmLaunch)
  const warmUp = warmer(Date.now, (path) => void shell.client.commands.run(warm, { peer: home, path }).catch(() => undefined));
  const warmIt = (): void => warmUp(worktree() && target() === home ? project()?.path : undefined);
  // no coding agent on this computer: the install strip (v1 setup.js)
  const setup = useSetup(shell, () => home, () => harnessOf(harnesses(), INSTALLABLE).logo, () => input?.focus());
  // the Recipes row: the picked project's recipes, each opening its run dialog (v1 renderLaunchRecipes)
  const recipes = useRecipes(shell, () => home, () => (target() === home ? project()?.path : undefined));
  // the phone app's mic (v1 dictate.js): none elsewhere
  const mic = useMic(shell, { text, set: (v) => (setText(v), menu.typed(v), ask(v)), el: () => input });
  const tool = (id: string, part: string, icon: LauncherTool['icon'], label: string, title: string, more: Partial<LauncherTool> = {}): LauncherTool => ({ id, part, icon, label, title, ...more });
  const view = (id: string): void => shell.navigate({ t: 'openView', id: id as never, params: null as Json });
  const settingsSheet = (pane: string): void => shell.navigate({ t: 'openOverlay', overlay: { kind: 'viewer', id: 'shell-settings.sheet' as never, params: { pane } } });
  const shown = (): { agent: string; label: string } | undefined => (agent() === 'auto' ? autoPick(preview()) : undefined);
  const pick = (): { name: string; logo?: string } => harnessOf(harnesses(), shown()?.agent ?? (agent() === 'auto' ? auto() : agent()));
  const chips = (): LauncherChip[] => [
    ...projects().map((p) => {
      const start = project()?.id === p.id;
      const added = also().includes(p.id);
      const several = also().length > 0;
      return {
        id: p.id,
        kind: 'project' as const,
        name: p.name,
        title: start && several ? `${p.path}\n${t('shell.home.startsHere')}` : p.path,
        color: p.color || 'slate',
        on: start || added,
        act: { onClick: () => pickWhere(p.id) },
        // the folder it starts in has no badge; with no folder picked there's nothing to add to
        ...(!start && project() && { also: { on: added, label: t(added ? 'shell.home.leaveOut' : 'shell.home.also', { name: p.name }), onToggle: () => setOwnAlso(alsoToggle(also(), p.id)) } }),
      };
    }),
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
          onSelect: (v: string) => (v === 'add' ? shell.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: 'shell.projects' as never, params: null } }) : pickWhere(v)),
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
          warmIt();
        }}
        onSend={send}
        onKey={onKey}
        firstRun={firstRun()}
        setup={target() === home ? setup() : undefined}
        suggest={menu.suggest()}
        onPaste={(e) => menu.paste(e) || att.paste(e)}
        onFiles={att.add}
        inputRef={(el) => (input = el)}
        mode={{ label: t(`shell.mode.${mode()}`), title: t('shell.home.fullAutoTitle'), icon: MODE_ICON[mode()], act: { menu: { items: modeMenu(t, mode()), onSelect: (v) => setMode(v as Mode) } } }}
        runner={{
          label: agentName(t, harnesses(), agent()),
          title: t('shell.home.autoTitle'),
          pick:
            shown()?.label ??
            [pick().name, agent() !== 'auto' && model() ? model() : '', agent() !== 'auto' ? effort() : '', agent() !== 'auto' ? (account()?.label ?? '') : ''].filter(Boolean).join(' · '),
          pickTitle: shown() ? t('shell.home.autoWhy', { label: preview()?.pick?.label ?? '', why: preview()?.why ?? '' }) : t('shell.home.pickTitle', { name: pick().name }),
          ...(pick().logo && { logo: pick().logo }),
          compare: runs().length > 0 ? t('shell.home.compareMore', { n: MAX_RUNNERS }) : t('shell.home.compare'),
          act: { menu: { items: agentMenu(t, harnesses(), agent()), onSelect: pickAgent } },
          // the searchable harness · model picker (v1 runner-picker.js)
          pickAct: { onClick: () => (agent() === 'auto' ? setAutoPop(!autoPop()) : setPicker(true)) },
          ...(agent() === 'auto' && { pickOpen: autoPop() }),
          compareAct: {
            onClick: () => {
              const next = nextRun(
                agent(),
                runs(),
                harnesses().map((h) => h.id),
              );
              if (next) setRuns([...runs(), next]);
            },
          },
          compareFull: firstRun() || runs().length >= MAX_RUNNERS - 1,
          compares: runs().map((a, i) => {
            const h = harnessOf(harnesses(), a);
            return {
              label: h.name,
              logo: h.logo,
              removeLabel: t('shell.home.compareRemove', { name: h.name }),
              onRemove: () => setRuns(runs().filter((_, k) => k !== i)),
              act: { menu: { items: agentMenu(t, harnesses(), a, false), onSelect: (v) => setRuns(runs().map((x, k) => (k === i ? v : x))) } },
            };
          }),
        }}
        lead={firstRunTools(firstRun(), 'lead', [
          tool('attach', 'launcher.attach', 'clip', t('shell.home.attach'), t('shell.home.attach'), { act: attachAct(shell, attach, picking()) }),
          ...(mic ? [tool('mic', 'launcher.mic', 'mic', mic.label(), mic.label(), { on: mic.on(), act: { onClick: mic.toggle } })] : []),
          tool('where', 'launcher.where', target() === home ? 'laptop' : 'server', target() === home ? t('shell.home.where') : shell.client.peers.name(target()), t('shell.home.where'), {
            text: target() !== home,
            ...(target() !== home && { on: true }),
            act: {
              menu: {
                items: [
                  ...whereItems(peerIds(), target(), home, (p) => shell.client.peers.name(p as PeerId), t),
                  { kind: 'separator' },
                  { value: 'add', label: t('shell.home.addMachine'), icon: 'plus' },
                ],
                // a pick is the one place (the menu closes on it, as every menu does)
                onSelect: (v) => (v === 'add' ? view('machine.this') : setRunOn(v)),
              },
            },
          }),
        ])}
        mid={firstRunTools(firstRun(), 'mid', [
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
        ])}
        tail={firstRunTools(
          firstRun(),
          'tail',
          [
            tool('goal', 'launcher.goal', 'target', t('shell.home.goal'), t('shell.home.goalTitle'), {
              text: true,
              ...(goalOn() && { on: true }),
              act: { onClick: () => (setGoalOn(!goalOn()), queueMicrotask(() => (goalOn() ? goalInput : input)?.focus())) },
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
          ],
          tool('more', 'launcher.more', 'dots', t('shell.home.moreOptions'), t('shell.home.moreOptionsTitle'), { text: true, act: { onClick: openFull } }),
        )}
        sendLabel={when() ? t('shell.when.send', { at: new Date(whenAt(when() ?? 'hour', now())).toLocaleString() }) : t('shell.home.send')}
        {...(goal() !== undefined && {
          goal: { label: t('shell.home.goal'), placeholder: t('shell.home.goalPlaceholder'), value: goal() ?? '', onInput: setGoal, ref: (el: HTMLInputElement) => (goalInput = el) },
        })}
        extras={extras()}
        recipes={{
          label: t('shell.home.recipes'),
          empty: recipes.empty(),
          items: recipes.items(),
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
      {/* usage at a glance under the prompt box (wisp.budget's plan windows), v1 #790 .sh-usage */}
      <Slot input="shell.home:usage" layout="contents" />
      {/* opened from the Auto pick (v1 openPop); before Auto answers it says it's still looking, then fills in */}
      <Show when={autoPop()}>
        {(_) => {
          const p = (): AutoPreview => preview() ?? { pick: null, why: '' };
          const pop = () => popOf(p());
          const pk = () => p().pick;
          const row = (a: { agent: string; model: string; key: string; label: string; chance: number; usd: number; why?: string }, sug: boolean) => ({
            key: a.key,
            logo: harnessOf(harnesses(), a.agent).logo,
            title: sug ? t('shell.auto.try', { label: shortLabel(a) }) : shortLabel(a),
            sub: sug ? a.why || agentName(t, harnesses(), a.agent) : agentName(t, harnesses(), a.agent),
            chance: pct(a.chance),
            usd: usd(a.usd),
          });
          const goal = (): string => t(`shell.auto.goal.${p().goal === 'cheap' || p().goal === 'best' ? (p().goal as string) : 'balanced'}`);
          const facts = () => [
            ...(pop().chance ? [{ strong: pop().chance, text: t('shell.auto.likely') }] : []),
            ...(pop().usd ? [{ text: pop().usd }] : []),
            ...(pop().minutes ? [{ text: t('shell.auto.minutes', { n: pop().minutes }) }] : []),
          ];
          return (
            <AutoPop
              anchor={() => document.querySelector('[data-part="launcher.autoPreview"]')}
              label={t('shell.auto.popLabel')}
              head={((x) =>
                x
                  ? { logo: harnessOf(harnesses(), x.agent).logo, title: shortLabel(x), sub: `${agentName(t, harnesses(), x.agent)} · ${goal()}` }
                  : { nothing: t('shell.auto.nothing'), why: p().why || t('shell.auto.looking') })(pk())}
              why={pk() ? pop().why : undefined}
              facts={pk() ? facts() : []}
              suggest={((s) => (pk() && s ? { heading: t('shell.auto.worth'), row: row(s, true) } : undefined))(pop().suggest)}
              others={pk() && pop().others.length ? { heading: t('shell.auto.orRun'), rows: pop().others.map((a) => row(a, false)) } : undefined}
              never={((x) => (x ? t('shell.auto.never', { model: neverModel(x), kind: typeWord(p().type ?? '') }) : undefined))(pk())}
              how={t('shell.auto.how')}
              onClose={() => setAutoPop(false)}
              onHow={() => {
                setAutoPop(false);
                shell.navigate({ t: 'openOverlay', overlay: { kind: 'viewer', id: 'shell-settings.sheet' as never, params: { pane: 'auto' } } });
              }}
              onPick={(key) => {
                // run another pick instead: it's yours now, and the task tells Auto what it had shown (autoOverride)
                const c = [p().suggest, ...(p().alternatives ?? [])].find((a) => a?.key === key);
                setAutoPop(false);
                if (!c) return;
                pickAgent(c.agent);
                setModel(c.model);
                setEffort(c.effort);
              }}
              onNever={() => {
                setAutoPop(false);
                const x = pk();
                if (x) void never(x, p().type ?? '');
              }}
            />
          );
        }}
      </Show>
      <RunnerPicker
        open={picker()}
        onOpenChange={setPicker}
        peer={target()}
        accounts
        value={{ agent: agent() === 'auto' ? auto() : agent(), model: model(), effort: effort(), account: account()?.id ?? '' }}
        onChange={(r) => {
          setAgent(r.agent);
          setModel(r.model);
          setEffort(r.effort);
          setAccount(r.account ? { id: r.account, label: r.accountLabel ?? r.account } : undefined);
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
      <Slot input="shell.home:cards" layout="contents" pickAgent={pickAgent} />
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
      <FeedbackLine label={t('shell.feedback.line')} onClick={() => openFeedback(shell)} />
    </SplitHome>
  );
}
