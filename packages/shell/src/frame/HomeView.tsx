// Home as v1 shows it (web/js/features/split.js renderHome, launcher.js, tips.js): the greeting, the
// prompt box, what needs you (up to five), the tips. Sending clears the box at once and opens the new
// task when the peer answers; a refusal puts the text back (the toast comes from the client).

import { createMemo, createSignal, onCleanup, type JSX } from 'solid-js';
import { defineCommand, type EntityKey } from '@wisp/client';
import { KeysHint, Launcher, NextList, SplitHome, Tips, useSignal, type LauncherTool } from '@wisp/ui';
import { useShell } from '../context.tsx';
import { usePluginClient } from '../slot.tsx';
import { useNow } from '../clock.ts';
import { SESSION, type SessionRow } from '../rows.ts';
import { HARNESS, longTime, sectionOf, shortAgo, statusOf } from './rows-view.ts';

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly color: string;
}

const create = defineCommand<{ peer: string; prompt: string; cwd?: string; agent: string }, { id: string }>({
  id: 'runtime.create',
  owner: (a) => a.peer,
  optimistic: 'none',
});

export function HomeView(props: { readonly onBack?: () => void }): JSX.Element {
  const shell = useShell();
  const t = shell.t;
  const home = usePluginClient('shell').home;
  const sessions = useSignal(shell.client.entities.list<SessionRow>(SESSION));
  const projects = useSignal(shell.client.entities.list<ProjectRow>('project'));
  const now = useNow(shell.client);
  const [text, setText] = createSignal('');
  let input: HTMLTextAreaElement | undefined;
  onCleanup(shell.focusTargets.provide('launcher', () => input?.focus()));
  // v1 puts the caret in the prompt a beat after Home shows
  queueMicrotask(() => input?.focus());
  const project = createMemo(() => projects()[0]);
  const needs = createMemo(() => sessions().filter((s) => !s.archived && sectionOf(s) === 'needs').sort((a, b) => b.updated_at - a.updated_at));
  const send = (): void => {
    const prompt = text().trim();
    if (!prompt) return;
    setText('');
    const p = project();
    shell.client.commands.run(create, { peer: home, prompt, agent: 'claude', ...(p && { cwd: p.path }) }).then(
      (r) => shell.navigate({ t: 'openTask', id: r.id as EntityKey as never }),
      () => setText(prompt),
    );
  };
  const tool = (id: string, part: string, icon: LauncherTool['icon'], label: string, title: string, more: Partial<LauncherTool> = {}): LauncherTool => ({ id, part, icon, label, title, ...more });
  const claude = HARNESS['claude'];
  return (
    <SplitHome greeting={t('shell.home.hello')} {...(props.onBack && { onBack: props.onBack, backLabel: t('shell.home.back') })}>
      <Launcher
        inLabel={t('shell.home.in')}
        project={{ name: project()?.name ?? '', title: project()?.path ?? '', color: project()?.color ?? 'slate' }}
        noFolder={t('shell.home.noFolder')}
        noFolderTitle={t('shell.home.noFolderTitle')}
        otherFolder={t('shell.home.otherFolder')}
        otherFolderTitle={t('shell.home.otherFolderTitle')}
        placeholder={t('shell.home.placeholder')}
        value={text()}
        onInput={setText}
        onSend={send}
        inputRef={(el) => (input = el)}
        mode={{ label: t('shell.home.fullAuto'), title: t('shell.home.fullAutoTitle') }}
        runner={{ label: t('shell.home.auto'), title: t('shell.home.autoTitle'), pick: claude?.name ?? '', pickTitle: t('shell.home.pickTitle', { name: claude?.name ?? '' }), ...(claude?.logo && { logo: claude.logo }), compare: t('shell.home.compare') }}
        lead={[tool('attach', 'launcher.attach', 'clip', t('shell.home.attach'), t('shell.home.attach')), tool('where', 'launcher.where', 'laptop', t('shell.home.where'), t('shell.home.where'), { text: false })]}
        mid={[
          tool('tryTwo', 'launcher.tryTwo', 'rerun', t('shell.home.tryTwo'), t('shell.home.tryTwoTitle'), { disabled: true, text: false }),
          tool('team', 'launcher.team', 'agent', t('shell.home.delegate'), t('shell.home.delegateTitle'), { text: true }),
        ]}
        tail={[
          tool('goal', 'launcher.goal', 'target', t('shell.home.goal'), t('shell.home.goalTitle'), { text: true }),
          tool('worktree', 'launcher.worktree', 'branch', t('shell.home.worktree'), t('shell.home.worktreeTitle'), { text: true, on: true }),
          tool('later', 'launcher.later', 'clock', t('shell.home.later'), t('shell.home.later')),
        ]}
        sendLabel={t('shell.home.send')}
        recipes={{ label: t('shell.home.recipes'), empty: t('shell.home.recipesEmpty'), add: t('shell.home.recipesNew'), issue: t('shell.home.issue'), issueTitle: t('shell.home.issueTitle') }}
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
        setup={[
          { kind: 'tool', icon: 'github', title: t('shell.tips.github'), body: t('shell.tips.githubBody'), cta: t('shell.tips.signIn') },
          { kind: 'grid', icon: 'cloud', title: t('shell.tips.grid'), body: t('shell.tips.gridBody'), cta: t('shell.tips.setUp') },
        ]}
        tips={[
          { before: t('shell.tips.goal1'), bold: t('shell.tips.goal1b'), after: t('shell.tips.goal1a') },
          { before: t('shell.tips.goal2'), bold: t('shell.tips.goal2b'), after: t('shell.tips.goal2a') },
          { before: t('shell.tips.vs'), bold: t('shell.tips.vsb'), after: t('shell.tips.vsa') },
        ]}
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
