// A member's editor (v1 crew.js crewEditor): Edit… on a member's page, and Add a crew member on the rail. v1's form
// on the kit (CrewEditorForm): Start from a ready-made member, the face (its dice rolls another), Name and Role, Their
// job, Checks in (cadences, or Custom… in words), Also starts when (v1's events, and hand-offs: after another member
// reports, ADR-0043), then the project, harness, mode and how many at once, and First check-in now. Save shows at
// once (crew.update or crew.create) and rolls back with the shell's toast if refused.
import { createEffect, createMemo, createSignal, type JSX } from 'solid-js';
import { uuidv7, type PluginClient } from '@wisp/client';
import { projectList, useShell } from '@wisp/shell';
import { CrewEditorForm, rollSpirit, useSignal, type CrewEditorBarItem, type CrewEditorChip } from '@wisp/ui';
import { createMember, updateMember } from './commands.ts';
import { crewData } from './data.ts';
import { EVENTS, TEMPLATES, addWake, draftOf, fromTemplate, patchOf, problemOf, toggleOn, type Draft } from './editor.ts';
import { t, type Key } from './i18n.ts';
import { CADENCES } from './model.ts';
import { cronWords, toCron } from './rules/schedule.ts';
import type { Member } from './types.ts';
import { VIEW } from './views.ts';

const MODES = [
  { id: 'plan', icon: 'plan', tone: 'accent' },
  { id: 'edits', icon: 'pen', tone: undefined },
  { id: 'auto', icon: 'spark', tone: 'warn' },
] as const;
const EVENT_ICON = { finished: 'bolt', done: 'done', ci: 'warn' } as const;
const HANDOFF = 'crew.reported';

// size-ok: one form whose rows share its draft
export default function CrewEditor(props: { readonly client: PluginClient; readonly params: { id?: string } }): JSX.Element {
  const c = props.client;
  const shell = useShell();
  const say = t as (k: string, v?: Readonly<Record<string, string | number>>) => string;
  const data = crewData(c);
  const members = useSignal(data.members);
  const harnesses = useSignal(shell.harnesses());
  const projectRows = useSignal(c.entities.list<unknown>('project'));
  // read through `members()` so what depends on it follows the rows as they arrive
  const member = (): (Member & { key: string }) | undefined => (members(), props.params.id ? (data.byId(props.params.id) as (Member & { key: string }) | undefined) : undefined);
  const editing = (): boolean => props.params.id !== undefined;
  // the member as it was when the form filled: its row may arrive after the dialog opens (a reload on it)
  let before = draftOf(member());
  let touched = false;
  // a new member works where you are: the project the list shows, or your only one (v1: the launcher's project)
  const here = (): string => {
    const all = projectList(projectRows(), undefined);
    const on = shell.projectFilter?.value();
    return all.find((p) => p.id === on)?.path ?? (all.length === 1 ? (all[0]?.path ?? '') : '');
  };
  const [d, setD] = createSignal<Draft>(editing() ? before : { ...before, avatar: rollSpirit(String(Math.random())), cwd: here() });
  createEffect(() => {
    const m = member();
    if (!m || touched) return;
    before = draftOf(m);
    setD(before);
  });
  const [problem, setProblem] = createSignal<string | undefined>(undefined);
  const [picked, setPicked] = createSignal<string | undefined>(undefined);
  const [checkin, setCheckin] = createSignal(!editing());
  // Custom…: a schedule typed in words, kept open once picked (v1)
  const [typing, setTyping] = createSignal(!CADENCES.some(([v]) => v === d().cron));
  const [said, setSaid] = createSignal(cronWords(d().cron) ?? d().cron);
  const set = (patch: Partial<Draft>): void => {
    touched = true;
    setD({ ...d(), ...patch });
  };
  const others = createMemo(() => members().filter((m) => m.id !== props.params.id));
  const close = (): void => c.navigate({ t: 'closeOverlay', id: VIEW.editor as never });
  const tplText = (key: string): { name: string; role: string; brief: string } => ({
    name: t(`wisp.crew.tpl.${key}.name` as Key),
    role: t(`wisp.crew.tpl.${key}.role` as Key),
    brief: t(`wisp.crew.tpl.${key}.brief` as Key),
  });

  const save = (): void => {
    const why = problemOf(
      d(),
      others().map((m) => m.name),
    );
    if (why) return void setProblem(why);
    const m = member();
    if (m) {
      const patch = patchOf(d(), before);
      if (Object.keys(patch).length > 0) void c.run(updateMember, { key: m.key as never, id: m.id, ...patch }).catch(() => undefined);
    } else {
      const v = { ...d(), name: d().name.trim(), role: d().role.trim(), brief: d().brief.trim() };
      void c.run(createMember, { peer: c.home, id: uuidv7(), member: v as unknown as Member, ...(checkin() && { checkin: true }) }).catch(() => undefined);
    }
    close();
  };

  const projects = createMemo(() => projectList(projectRows(), undefined));
  const projectName = (): string => projects().find((p) => p.path === d().cwd)?.name ?? (d().cwd ? (d().cwd.split(/[\\/]/).pop() ?? d().cwd) : t('wisp.crew.editor.noProject'));
  const harnessName = (): string => (d().agent && d().agent !== 'auto' ? (harnesses().find((h) => h.id === d().agent)?.name ?? d().agent) : t('wisp.crew.editor.auto'));
  const mode = (): (typeof MODES)[number] => MODES.find((m) => m.id === d().mode) ?? MODES[2];
  const bar = (): CrewEditorBarItem[] => [
    {
      id: 'project',
      kind: 'tog',
      icon: 'folder',
      label: projectName(),
      title: t('wisp.crew.editor.projectTitle'),
      act: {
        menu: {
          items: [{ value: '', label: t('wisp.crew.editor.noProject') }, ...projects().map((p) => ({ value: p.path, label: p.name }))],
          onSelect: (cwd) => set({ cwd }),
        },
      },
    },
    {
      id: 'runner',
      kind: 'runner',
      icon: 'spark',
      label: harnessName(),
      note: t('wisp.crew.editor.default'),
      title: t('wisp.crew.editor.runnerTitle'),
      act: { menu: { items: [{ value: 'auto', label: t('wisp.crew.editor.auto') }, ...harnesses().map((h) => ({ value: h.id, label: h.name }))], onSelect: (agent) => set({ agent }) } },
    },
    {
      id: 'mode',
      kind: 'mode',
      icon: mode().icon,
      label: t(`wisp.crew.page.mode.${mode().id}`),
      tone: mode().tone,
      act: { menu: { items: MODES.map((m) => ({ value: m.id, label: t(`wisp.crew.page.mode.${m.id}`) })), onSelect: (v) => set({ mode: v as Draft['mode'] }) } },
    },
  ];

  // v1's events, then a hand-off chip per other member (after they report, ADR-0043's wakes)
  const eventChips = (): CrewEditorChip[] => [
    ...EVENTS.map((k) => ({ value: k, label: t(`wisp.crew.editor.event.${k}` as Key), icon: EVENT_ICON[k as keyof typeof EVENT_ICON] })),
    ...others().map((m) => ({ value: `@${m.name}`, label: say('wisp.crew.editor.wake.after', { name: m.name }), icon: 'crew' as const })),
  ];
  const onNow = (): string[] => [
    ...d().on,
    ...d()
      .wakes.filter((w) => w.on === HANDOFF && typeof w.match?.['member'] === 'string')
      .map((w) => `@${String(w.match?.['member'])}`),
  ];
  const toggleEvent = (v: string): void => {
    if (!v.startsWith('@')) return set({ on: toggleOn(d().on, v) });
    const name = v.slice(1);
    const has = d().wakes.some((w) => w.on === HANDOFF && w.match?.['member'] === name);
    set({ wakes: has ? d().wakes.filter((w) => !(w.on === HANDOFF && w.match?.['member'] === name)) : addWake(d().wakes, HANDOFF, name) });
  };

  const typed = (): string | null => toCron(said());
  const read = (): string => {
    const s = said().trim();
    const cron = typed();
    if (!s) return t('wisp.crew.editor.custom.say');
    if (!cron) return t('wisp.crew.editor.custom.try');
    const words = cronWords(cron) ?? cron;
    return words.toLowerCase() === s.toLowerCase() ? t('wisp.crew.editor.custom.ok') : `= ${words}`;
  };
  const name = (): string => d().name.trim();
  const pick = (key: string): void => {
    const tp = TEMPLATES.find((x) => x.key === key);
    if (!tp) return;
    setPicked(key);
    touched = true;
    setD(
      fromTemplate(
        d(),
        tp,
        tplText(key),
        TEMPLATES.map((x) => tplText(x.key).name),
      ),
    );
    setCheckin(!!tp.cron); // one that waits for tasks has nothing to check yet
    setTyping(false);
    setSaid(cronWords(tp.cron) ?? tp.cron);
  };
  return (
    <CrewEditorForm
      start={
        editing()
          ? undefined
          : {
              label: t('wisp.crew.editor.start'),
              templates: TEMPLATES.map((tp) => ({ key: tp.key, label: tplText(tp.key).role, avatar: tp.avatar })),
              picked: picked(),
              onPick: pick,
            }
      }
      face={{ avatar: d().avatar, name: d().name || 'wisp', title: t('wisp.crew.editor.face'), onRoll: () => set({ avatar: rollSpirit(String(Math.random())) }) }}
      name={{ label: t('wisp.crew.editor.name'), value: d().name, placeholder: t('wisp.crew.editor.namePlaceholder'), onInput: (v) => (setProblem(undefined), set({ name: v })) }}
      role={{ label: t('wisp.crew.editor.role'), value: d().role, placeholder: t('wisp.crew.editor.rolePlaceholder'), onInput: (v) => set({ role: v }) }}
      handle={
        problem()
          ? { text: say(problem() as string), bad: true }
          : name()
            ? { text: t('wisp.crew.editor.handle.before'), code: `@${name()}`, after: t('wisp.crew.editor.handle.after') }
            : { text: t('wisp.crew.editor.handle.none') }
      }
      job={{ label: t('wisp.crew.editor.job'), hint: t('wisp.crew.editor.jobHint'), value: d().brief, placeholder: t('wisp.crew.editor.jobPlaceholder'), onInput: (v) => set({ brief: v }) }}
      cadence={{
        label: t('wisp.crew.editor.cron'),
        hint: t('wisp.crew.editor.cronHint'),
        chips: [...CADENCES.map(([v, k]) => ({ value: v, label: t(k) })), { value: 'custom', label: t('wisp.crew.editor.custom') }],
        value: typing() ? 'custom' : d().cron,
        onPick: (v) => {
          setTyping(v === 'custom');
          if (v !== 'custom') {
            set({ cron: v });
            setSaid(cronWords(v) ?? v);
          }
        },
        custom: typing()
          ? {
              value: said(),
              placeholder: t('wisp.crew.editor.customPlaceholder'),
              read: read(),
              bad: said().trim() !== '' && !typed(),
              onInput: (v: string) => {
                setSaid(v);
                const cron = toCron(v);
                if (cron) set({ cron });
              },
            }
          : undefined,
      }}
      events={{ label: t('wisp.crew.editor.events'), hint: t('wisp.crew.editor.eventsHint'), chips: eventChips(), on: onNow(), onToggle: toggleEvent }}
      bar={bar()}
      parallel={{
        label: say('wisp.crew.editor.atOnce', { count: d().parallel }),
        title: t('wisp.crew.editor.parallelTitle'),
        value: d().parallel,
        less: t('wisp.crew.editor.less'),
        more: t('wisp.crew.editor.more'),
        onStep: (by) => set({ parallel: Math.min(5, Math.max(1, d().parallel + by)) }),
      }}
      checkin={editing() ? undefined : { label: t('wisp.crew.editor.checkin'), on: checkin(), onToggle: setCheckin }}
      cancel={{ label: t('wisp.crew.page.cancel'), onClick: close }}
      submit={{ label: editing() ? t('wisp.crew.page.save') : t('wisp.crew.editor.addButton'), onClick: save }}
    />
  );
}
