// Skills and instructions on a member's page (v1 crew-kit.js kitHtml, kitClick, addMenu): a row a file with its
// switch, Add (Generate with them…, an instructions file, a skill, from this computer), and the dialogs those open.
// Every change is the member's whole kit through crew.update: the row changes at once, and a refused save rolls back
// with the shell's toast (the editor comes back with what you typed).

import { createSignal, Match, Show, Switch, type JSX } from 'solid-js';
import { useShell } from '@wisp/shell';
import { CrewKitList, CrewSection, CrewText, Menu } from '@wisp/ui';
import { updateMember, type MemberPatch } from '../commands.ts';
import type { CrewMember } from '../data.ts';
import { t } from '../i18n.ts';
import { fileToKit, fitsKit, kitFileOk, mergeKit } from './kit-logic.ts';
import { KitEditor } from './KitEditor.tsx';
import { GenerateKit, LocalKitPicker } from './KitDialogs.tsx';
import { kitRows, toggled, type Say } from './kit-view.ts';
import { KIT_MAX } from './skill-md.ts';
import type { KitDraft, KitFile } from './types.ts';
import type { PluginClient } from '@wisp/client';

export interface KitSectionProps {
  readonly client: PluginClient;
  readonly member: () => CrewMember;
}

type Open = { readonly t: 'edit'; readonly kind: 'skill' | 'rules'; readonly item?: KitFile; readonly draft?: KitDraft } | { readonly t: 'local' } | { readonly t: 'generate' };

const say = t as unknown as Say;

export default function KitSection(props: KitSectionProps): JSX.Element {
  const shell = useShell();
  const [open, setOpen] = createSignal<Open | undefined>(undefined);
  const m = (): CrewMember => props.member();
  const kit = (): readonly KitFile[] => m().kit ?? [];
  const locked = (): boolean => !!m().spell;
  /** Saves part of the member; resolves whether the peer took it (refused: rolled back, toasted). */
  const save = (patch: MemberPatch): Promise<boolean> =>
    props.client.run(updateMember, { key: m().key, id: m().id, ...patch }).then(
      () => true,
      () => false,
    );
  const full = (): boolean => {
    if (kit().length < KIT_MAX) return false;
    shell.toast.error(say('wisp.crew.more.kit.full', { name: m().name, n: KIT_MAX }));
    return true;
  };
  let picker: HTMLInputElement | undefined;
  const pick = (v: string): void => {
    if (v === 'generate') return void setOpen({ t: 'generate' });
    if (full()) return;
    if (v === 'rules' || v === 'skill') setOpen({ t: 'edit', kind: v });
    if (v === 'local') setOpen({ t: 'local' });
    if (v === 'upload') picker?.click();
  };
  // .md files picked or dropped (v1 addFiles): a SKILL.md (or one with a name and When up top) is a skill, the rest
  // instructions under their own name; added at once, the same name replaced
  const addFiles = (files: readonly File[]): void => {
    if (locked()) return;
    const md = files.filter((f) => kitFileOk(f.name, f.size));
    if (!md.length) return void shell.toast.error(t('wisp.crew.more.kit.dropMd'));
    void Promise.all(md.map(async (f) => fileToKit(f.name, await f.text()))).then(
      (drafts) => {
        if (!fitsKit(kit().length, drafts.length)) return void shell.toast.error(say('wisp.crew.more.local.tooMany', { n: KIT_MAX }));
        void save({ kit: mergeKit(kit(), drafts) });
      },
      () => shell.toast.error(t('wisp.crew.more.kit.readFailed')),
    );
  };
  const openFile = (id: string): void => {
    const k = kit().find((x) => x.id === id);
    if (k && !locked()) setOpen({ t: 'edit', kind: k.kind, item: k });
  };
  const saveFile = (o: Extract<Open, { t: 'edit' }>, next: KitDraft): void => {
    setOpen(undefined);
    const item = o.item;
    const list = item ? kit().map((k) => (k.id === item.id ? { ...k, ...next } : k)) : mergeKit(kit(), [next]);
    // refused: the editor comes back with what you typed (v1)
    void save({ kit: list }).then((ok) => ok || setOpen({ ...o, draft: next }));
  };
  const removeFile = (item: KitFile): void => {
    setOpen(undefined);
    void save({ kit: kit().filter((k) => k.id !== item.id) });
  };
  return (
    <CrewSection
      part="crew.kit"
      title={t('wisp.crew.page.kit')}
      count={kit().length || undefined}
      {...(!locked() && { onFiles: addFiles })}
      tool={
        <Show when={!locked()}>
          <Menu
            part="crew.kit.add"
            trigger={{ label: t('wisp.crew.more.kit.add'), icon: 'plus', variant: 'link', size: 'xs' }}
            items={[
              { value: 'generate', label: say('wisp.crew.more.kit.menu.generate', { name: m().name }), hint: t('wisp.crew.more.kit.menu.generateHint'), icon: 'wizard' },
              { value: 'rules', label: t('wisp.crew.more.kit.menu.rules'), hint: t('wisp.crew.more.kit.menu.rulesHint'), icon: 'file' },
              { value: 'skill', label: t('wisp.crew.more.kit.menu.skill'), hint: t('wisp.crew.more.kit.menu.skillHint'), icon: 'spark' },
              { value: 'local', label: t('wisp.crew.more.kit.menu.local'), hint: t('wisp.crew.more.kit.menu.localHint'), icon: 'laptop' },
              { value: 'upload', label: t('wisp.crew.more.kit.menu.upload'), hint: t('wisp.crew.more.kit.menu.uploadHint'), icon: 'clip' },
            ]}
            onSelect={pick}
          />
          <input
            ref={(el) => (picker = el)}
            type="file"
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            multiple
            hidden
            onChange={(e) => {
              addFiles([...(e.currentTarget.files ?? [])]);
              e.currentTarget.value = '';
            }}
          />
        </Show>
      }
    >
      <Show when={kit().length} fallback={<CrewText text={locked() ? t('wisp.crew.more.kit.locked') : t('wisp.crew.page.kit.empty')} empty />}>
        <CrewKitList rows={kitRows(m(), say)} locked={locked()} onOpen={openFile} onToggle={(id, on) => void save({ kit: toggled(kit(), id, on) })} />
      </Show>
      <Switch>
        <Match when={(() => { const o = open(); return o?.t === 'edit' ? o : undefined; })()}>
          {(o) => (
            <KitEditor
              name={m().name}
              kit={kit()}
              kind={o().kind}
              {...(o().item && { item: o().item as KitFile, onRemove: () => removeFile(o().item as KitFile) })}
              {...(o().draft && { draft: o().draft as KitDraft })}
              onSave={(next) => saveFile(o(), next)}
              onClose={() => setOpen(undefined)}
            />
          )}
        </Match>
        <Match when={open()?.t === 'local'}>
          <LocalKitPicker
            client={props.client}
            member={m}
            onClose={() => setOpen(undefined)}
            onAdd={(drafts) => {
              setOpen(undefined);
              void save({ kit: mergeKit(kit(), drafts) });
            }}
          />
        </Match>
        <Match when={open()?.t === 'generate'}>
          <GenerateKit client={props.client} member={m} onClose={() => setOpen(undefined)} onRestore={() => setOpen({ t: 'generate' })} />
        </Match>
      </Switch>
    </CrewSection>
  );
}
