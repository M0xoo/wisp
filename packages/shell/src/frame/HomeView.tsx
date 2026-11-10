// Home as v1 shows it (web/js/features/split.js renderHome, launcher.js, tips.js): the greeting, the
// prompt box, what needs you (up to five), the tips. Every control answers at once
// (design/feedback.md): a pick changes its label, a toggle flips, a menu opens, and sending shows the
// new task's row and page straight away (Starting…), the box cleared; a refusal puts the text back
// and the client toasts why.

import { createMemo, createSignal, onCleanup, type JSX } from 'solid-js';
import { entityKey, uuidv7, type EntityKey, type Json } from '@wisp/client';
import { KeysHint, Launcher, NextList, SplitHome, Tips, useSignal, type LauncherChip, type LauncherTool, type PlainTip } from '@wisp/ui';
import { useShell } from '../context.tsx';
import { usePluginClient } from '../slot.tsx';
import { useNow } from '../clock.ts';
import { SESSION, type SessionRow } from '../rows.ts';
import { longTime, sectionOf, shortAgo, statusOf } from './rows-view.ts';
import { create, setSetting } from './commands.ts';
import { defaultHarness, harnessOf } from './harness.ts';
import { MODE_ICON, agentMenu, agentName, modeMenu, teamMenu, whenAt, whenMenu, type Mode, type When } from './pickers.ts';

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly color: string;
}

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
  const projects = useSignal(shell.client.entities.list<ProjectRow>('project'));
  const settings = useSignal(shell.client.entities.list<SettingRow>('setting'));
  const now = useNow(shell.client);
  const harnesses = useSignal(shell.harnesses());
  /** what Auto runs today: the default harness (wisp's router picks per task once it's there) */
  const auto = (): string => defaultHarness(harnesses()) ?? '';
  const [text, setText] = createSignal('');
  const [mode, setMode] = createSignal<Mode>('auto');
  const [agent, setAgent] = createSignal('auto');
  const [compare, setCompare] = createSignal<string | undefined>(undefined);
  const [team, setTeam] = createSignal<ReadonlySet<string>>(new Set());
  const [goal, setGoal] = createSignal<string | undefined>(undefined);
  const [when, setWhen] = createSignal<When | undefined>(undefined);
  const [files, setFiles] = createSignal<readonly File[]>([]);
  const [picking, setPicking] = createSignal(false);
  const [where, setWhere] = createSignal<string | undefined>(undefined); // a project id, 'none', or the first project
  const [tipAt, setTipAt] = createSignal(0);
  let input: HTMLTextAreaElement | undefined;
  onCleanup(shell.focusTargets.provide('launcher', () => input?.focus()));
  // v1 puts the caret in the prompt a beat after Home shows
  queueMicrotask(() => input?.focus());
  const project = createMemo(() => (where() === 'none' ? undefined : (projects().find((p) => p.id === where()) ?? projects()[0])));
  const worktree = createMemo(() => settings().find((r) => r.key === 'defaults.worktree')?.value !== false);
  const needs = createMemo(() => sessions().filter((s) => !s.archived && sectionOf(s) === 'needs').sort((a, b) => b.updated_at - a.updated_at));
  const send = (): void => {
    const prompt = text().trim();
    if (!prompt) return;
    const p = project();
    const id = entityKey(home, uuidv7());
    const g = goal();
    // the row and the page at once (optimistic), the box cleared; a refusal puts the text back
    setText('');
    shell.client.commands
      .run(create, { peer: home, id, prompt, agent: agent() === 'auto' ? auto() : agent(), mode: mode(), at: Date.now(), ...(p && { cwd: p.path, projectId: p.id, color: p.color }), ...(g && { goal: g }) })
      .catch(() => setText(prompt));
    shell.navigate({ t: 'openTask', id: id as EntityKey as never });
  };
  const attach = (): void => {
    setPicking(true);
    void shell.platform.pickFiles({ multiple: true }).then((picked) => {
      setPicking(false);
      if (picked.length) setFiles([...files(), ...picked]);
    });
  };
  const tool = (id: string, part: string, icon: LauncherTool['icon'], label: string, title: string, more: Partial<LauncherTool> = {}): LauncherTool => ({ id, part, icon, label, title, ...more });
  const view = (id: string): void => shell.navigate({ t: 'openView', id: id as never, params: null as Json });
  const settingsSheet = (pane: string): void => shell.navigate({ t: 'openOverlay', overlay: { kind: 'viewer', id: 'shell-settings.sheet' as never, params: { pane } } });
  const pick = (): { name: string; logo?: string } => harnessOf(harnesses(), agent() === 'auto' ? auto() : agent());
  const chips = (): LauncherChip[] => [
    ...projects().map((p) => ({ id: p.id, kind: 'project' as const, name: p.name, title: p.path, color: p.color, on: project()?.id === p.id, act: { onClick: () => setWhere(p.id) } })),
    { id: 'none', kind: 'none', name: t('shell.home.noFolder'), title: t('shell.home.noFolderTitle'), on: where() === 'none', act: { onClick: () => setWhere('none') } },
    { id: 'pick', kind: 'pick', name: t('shell.home.otherFolder'), title: t('shell.home.otherFolderTitle'), act: { menu: { items: [...projects().map((p) => ({ value: p.id, label: p.name, hint: p.path })), { kind: 'separator' as const }, { value: 'add', label: t('shell.home.addProject'), icon: 'folder' as const }], onSelect: (v: string) => (v === 'add' ? settingsSheet('projects') : setWhere(v)) } } },
  ];
  const extras = () => [
    ...files().map((f, i) => ({ id: `file:${i}:${f.name}`, icon: 'clip' as const, label: f.name, removeLabel: t('shell.home.remove', { name: f.name }), onRemove: () => setFiles(files().filter((x) => x !== f)) })),
    ...(when() ? [{ id: 'when', icon: 'clock' as const, label: t('shell.when.chip', { when: t(`shell.when.${when()}`) }), removeLabel: t('shell.when.clear'), onRemove: () => setWhen(undefined) }] : []),
  ];
  const tips = (): PlainTip[] => [0, 1, 2].map((k) => TIPS[(tipAt() + k) % TIPS.length] ?? 'goal1').map((id) => ({ before: t(`shell.tips.${id}`), bold: t(`shell.tips.${id}b`), after: t(`shell.tips.${id}a`), href: `${GUIDE}#${id}` }));
  return (
    <SplitHome greeting={t('shell.home.hello')} {...(props.onBack && { onBack: props.onBack, backLabel: t('shell.home.back') })}>
      <Launcher
        inLabel={t('shell.home.in')}
        chips={chips()}
        placeholder={t('shell.home.placeholder')}
        value={text()}
        onInput={setText}
        onSend={send}
        inputRef={(el) => (input = el)}
        mode={{ label: t(`shell.mode.${mode()}`), title: t('shell.home.fullAutoTitle'), icon: MODE_ICON[mode()], act: { menu: { items: modeMenu(t, mode()), onSelect: (v) => setMode(v as Mode) } } }}
        runner={{
          label: agentName(t, harnesses(), agent()),
          title: t('shell.home.autoTitle'),
          pick: pick().name,
          pickTitle: t('shell.home.pickTitle', { name: pick().name }),
          ...(pick().logo && { logo: pick().logo }),
          compare: compare() ? t('shell.home.compareWith', { name: agentName(t, harnesses(), compare() ?? '') }) : t('shell.home.compare'),
          act: { menu: { items: agentMenu(t, harnesses(), agent()), onSelect: setAgent } },
          pickAct: { menu: { items: agentMenu(t, harnesses(), agent() === 'auto' ? auto() : agent(), false), onSelect: setAgent } },
          compareAct: { menu: { items: agentMenu(t, harnesses(), compare() ?? '', false), onSelect: (v) => setCompare(compare() === v ? undefined : v) } },
        }}
        lead={[
          tool('attach', 'launcher.attach', 'clip', t('shell.home.attach'), t('shell.home.attach'), { act: { onClick: attach, pending: picking() } }),
          tool('where', 'launcher.where', 'laptop', t('shell.home.where'), t('shell.home.where'), { text: false, act: { menu: { items: [{ value: 'here', label: t('shell.card.thisComputer'), icon: 'laptop', checked: true }, { kind: 'separator' }, { value: 'add', label: t('shell.home.addMachine'), icon: 'plus' }], onSelect: (v) => v === 'add' && view('machine.this') } } }),
        ]}
        mid={[
          tool('tryTwo', 'launcher.tryTwo', 'rerun', t('shell.home.tryTwo'), agent() === 'auto' ? t('shell.home.tryTwoTitle') : t('shell.home.tryTwo'), { disabled: agent() === 'auto', text: false, on: compare() === agent(), act: { onClick: () => setCompare(compare() === agent() ? undefined : agent()) } }),
          tool('team', 'launcher.team', 'agent', t('shell.home.delegate'), t('shell.home.delegateTitle'), { text: true, ...(team().size > 0 && { on: true }), act: { menu: { items: teamMenu(t, harnesses(), team()), onSelect: (v) => { const next = new Set(team()); if (next.has(v)) next.delete(v); else next.add(v); setTeam(next); } } } }),
        ]}
        tail={[
          tool('goal', 'launcher.goal', 'target', t('shell.home.goal'), t('shell.home.goalTitle'), { text: true, ...(goal() !== undefined && { on: true }), act: { onClick: () => setGoal(goal() === undefined ? '' : undefined) } }),
          tool('worktree', 'launcher.worktree', 'branch', worktree() ? t('shell.home.worktree') : t('shell.home.inPlace'), t('shell.home.worktreeTitle'), { text: true, on: worktree(), act: { onClick: () => void shell.client.commands.run(setSetting, { peer: home, key: 'defaults.worktree', value: !worktree() }).catch(() => undefined) } }),
          tool('later', 'launcher.later', 'clock', t('shell.home.later'), t('shell.home.later'), { ...(when() && { on: true }), act: { menu: { items: whenMenu(t), onSelect: (v) => setWhen(v as When) } } }),
        ]}
        sendLabel={when() ? t('shell.when.send', { at: new Date(whenAt(when() ?? 'hour', now())).toLocaleString() }) : t('shell.home.send')}
        {...(goal() !== undefined && { goal: { label: t('shell.home.goal'), placeholder: t('shell.home.goalPlaceholder'), value: goal() ?? '', onInput: setGoal } })}
        extras={extras()}
        recipes={{
          label: t('shell.home.recipes'),
          empty: t('shell.home.recipesEmpty'),
          add: t('shell.home.recipesNew'),
          issue: t('shell.home.issue'),
          issueTitle: t('shell.home.issueTitle'),
          addAct: { onClick: () => settingsSheet('recipes') },
          issueAct: { onClick: () => shell.palette.open() },
        }}
      />
      <NextList
        heading={t('shell.section.needs')}
        count={needs().length}
        rows={needs().slice(0, 5).map((s) => ({ id: s.id, title: s.title, color: String(s.summary['color'] ?? 'slate'), state: statusOf(s, t).label, time: shortAgo(s.updated_at, now()), timeTitle: longTime(s.updated_at) }))}
        onOpen={(id) => shell.navigate({ t: 'openTask', id: id as EntityKey as never })}
      />
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
