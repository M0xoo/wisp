// Files a job proposed for the member's kit, under that job in its thread (v1 crew-kit.js offerHtml, offerClick):
// tick what to add, open one to read and edit it first, then Add (the ticked files join the kit, the offer settles)
// or Dismiss. Both write at once through crew.update and roll back with the shell's toast if refused.

import { createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import type { PluginClient } from '@wisp/client';
import { useShell } from '@wisp/shell';
import { CrewOffer, CrewPickList } from '@wisp/ui';
import { settleOffer } from '../commands.ts';
import type { CrewMember } from '../data.ts';
import { t } from '../i18n.ts';
import type { Offer } from '../types.ts';
import { newKitId, sameFile } from './kit-logic.ts';
import { KitEditor } from './KitEditor.tsx';
import { addOffer, dropOffer, offerOf, offerPill, type Say } from './kit-view.ts';
import { KIT_MAX } from './skill-md.ts';
import type { KitDraft, KitFile } from './types.ts';

const say = t as unknown as Say;

export interface OffersSectionProps {
  readonly client: PluginClient;
  readonly member: () => CrewMember;
  /** the job (task id) whose offer this shows */
  readonly job: string;
}

export default function OffersSection(props: OffersSectionProps): JSX.Element {
  const offer = (): Offer | undefined => offerOf(props.member().offers, props.job);
  // keyed by the offer's id: a follow-up's new offer is a new card, so what you unticked or added on the old one
  // doesn't carry over; a row update to the same offer keeps the card (and its ticks)
  const id = createMemo(() => offer()?.id);
  return (
    <Show when={id()} keyed>
      {(key) => {
        let last: Offer | undefined;
        const current = (): Offer => {
          const o = offer();
          if (o && o.id === key) last = o;
          return last as Offer;
        };
        return (
          <Show when={current()}>
            <OfferCard client={props.client} member={props.member} offer={current} />
          </Show>
        );
      }}
    </Show>
  );
}

function OfferCard(props: { readonly client: PluginClient; readonly member: () => CrewMember; readonly offer: () => Offer }): JSX.Element {
  const shell = useShell();
  const m = props.member;
  const o = props.offer;
  const kit = (): readonly KitFile[] => m().kit ?? [];
  const [off, setOff] = createSignal<ReadonlySet<number>>(new Set());
  // names you already added through the editor: ticked and greyed, and Dismiss reads Done
  const [done, setDone] = createSignal<ReadonlySet<string>>(new Set());
  const [reading, setReading] = createSignal<number | undefined>(undefined);
  const n = (): number => o().files.filter((f, i) => !off().has(i) && !done().has(f.name)).length;
  const run = (a: { kit?: KitFile[]; offers: ReturnType<typeof dropOffer> }): void =>
    void props.client.run(settleOffer, { key: m().key, id: m().id, ...a }).catch(() => undefined);
  const add = (): void => {
    const plan = addOffer(kit(), o(), off(), done());
    if (plan === 'tooMany') return void shell.toast.error(say('wisp.crew.more.offer.tooMany', { n: KIT_MAX, name: m().name }));
    run(plan);
  };
  const pick = (key: string, on: boolean): void => {
    const next = new Set(off());
    if (on) next.delete(Number(key));
    else next.add(Number(key));
    setOff(next);
  };
  // reading one: its own copy, or yours with it written over (same name); saving adds it to the kit
  const saveRead = (f: KitDraft, next: KitDraft, item: KitFile | undefined): void => {
    setReading(undefined);
    const list = item ? kit().map((k) => (k.id === item.id ? { ...k, ...next } : k)) : [...kit(), { id: newKitId(), on: true, ...next }];
    setDone(new Set([...done(), next.name, f.name]));
    void props.client
      .run(settleOffer, { key: m().key, id: m().id, kit: list, offers: [] })
      .catch(() => setDone(new Set([...done()].filter((x) => x !== next.name && x !== f.name))));
  };
  const settledText = (): { taken: boolean; text: string; names: readonly string[] } | undefined => {
    const x = o();
    if (x.state === 'open') return undefined;
    return x.state === 'taken' && x.names?.length
      ? { taken: true, text: t('wisp.crew.more.offer.taken'), names: x.names }
      : { taken: false, text: say('wisp.crew.more.offer.dismissed', { count: x.files.length }), names: [] };
  };
  return (
    <>
      <CrewOffer
        title={say('wisp.crew.more.offer.title', { name: m().name })}
        hint={say('wisp.crew.more.offer.hint', { count: o().files.length })}
        settled={settledText()}
        add={{ label: n() ? say('wisp.crew.more.offer.addN', { n: n() }) : t('wisp.crew.more.offer.add'), disabled: !n(), onClick: add }}
        dismiss={{ label: done().size ? t('wisp.crew.more.offer.done') : t('wisp.crew.more.offer.dismiss'), onClick: () => run({ offers: dropOffer(o(), done()) }) }}
      >
        <CrewPickList
          rows={o().files.map((f, i) => ({
            key: String(i),
            kind: f.kind,
            name: f.name,
            description: f.kind === 'skill' ? f.description : undefined,
            picked: !off().has(i),
            added: done().has(f.name),
            pill: offerPill(kit(), f as KitDraft, done().has(f.name), say),
          }))}
          open={t('wisp.crew.more.offer.read')}
          onPick={pick}
          onOpen={(key) => setReading(Number(key))}
        />
      </CrewOffer>
      <For each={reading() === undefined ? [] : [reading() as number]}>
        {(i) => {
          const f = o().files[i] as KitDraft | undefined;
          if (!f) return null;
          const item = kit().find((k) => sameFile(k, f));
          return (
            <KitEditor
              name={m().name}
              kit={kit()}
              kind={f.kind}
              {...(item && { item })}
              {...(!done().has(f.name) && { draft: f })}
              onSave={(next) => saveRead(f, next, item)}
              onClose={() => setReading(undefined)}
            />
          );
        }}
      </For>
    </>
  );
}
