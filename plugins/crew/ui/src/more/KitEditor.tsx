// A kit file in a dialog (v1 crew-kit.js kitEditor): a skill (name, when to use it, the steps) or
// an instructions file (name, text). A pasted SKILL.md fills the name and When. Saving closes at
// once; the parent saves optimistically and opens it again with what you typed if it's refused.

import { createSignal, Show, type JSX } from 'solid-js';
import { Button, Dialog, Field, Inline, Input, Stack, Text, TextArea } from '@wisp/ui';
import { t } from '../i18n.ts';
import { checkDraft, pastedSkill, sizeLabel } from './kit-logic.ts';
import { KIT_BODY_MAX, skillName } from './skill-md.ts';
import type { KitDraft, KitFile } from './types.ts';

export interface KitEditorProps {
  readonly name: string; // the member's
  readonly kit: readonly KitFile[];
  readonly kind: 'skill' | 'rules';
  /** the file being edited */
  readonly item?: KitFile;
  /** what was typed before (a refused save), or a proposed file to look over */
  readonly draft?: KitDraft;
  readonly onSave: (next: KitDraft) => void;
  readonly onRemove?: () => void;
  readonly onClose: () => void;
}

type FieldName = 'name' | 'description' | 'body';

// size-ok: one dialog's fields and their checks, read top to bottom
export function KitEditor(props: KitEditorProps): JSX.Element {
  const skill = props.kind === 'skill';
  const start = props.draft ?? { kind: props.kind, name: props.item?.name ?? (skill ? '' : 'AGENTS.md'), description: props.item?.description ?? '', body: props.item?.body ?? '' };
  const [name, setName] = createSignal(start.name);
  const [desc, setDesc] = createSignal(start.description ?? '');
  const [body, setBody] = createSignal(start.body);
  const [bad, setBad] = createSignal<FieldName | undefined>();
  const [clash, setClash] = createSignal(false);
  const onBody = (v: string): void => {
    setBad(undefined);
    const sk = skill ? pastedSkill(v) : undefined;
    if (!sk) return void setBody(v);
    if (sk.name && !name()) setName(sk.name);
    if (sk.description && !desc()) setDesc(sk.description);
    setBody(sk.body);
  };
  const submit = (): void => {
    const next: KitDraft = { kind: props.kind, name: skill ? skillName(name()) : name().trim(), ...(skill && { description: desc().trim() }), body: body().trim() };
    const check = checkDraft(props.kit, next, props.item?.id);
    setBad(check.missing);
    setClash(!!check.clash);
    if (check.missing || check.clash) return;
    props.onSave(next);
  };
  const title = (): string =>
    props.item ? t('wisp.crew.more.kit.editTitle', { name: props.item.name }) : skill ? t('wisp.crew.more.kit.newSkillTitle', { name: props.name }) : t('wisp.crew.more.kit.newRulesTitle', { name: props.name });
  return (
    <Dialog
      part="crew.kitEditor"
      open
      size="lg"
      title={title()}
      onOpenChange={(o) => !o && props.onClose()}
      footer={
        <Inline gap="2" justify="between">
          <Show when={props.item && props.onRemove} fallback={<span />}>
            <Button variant="ghost" size="sm" tone="bad" icon="trash" onClick={() => props.onRemove?.()}>
              {t('wisp.crew.more.kit.remove')}
            </Button>
          </Show>
          <Inline gap="2">
            <Show when={body().length > 2000}>
              <Text size="sm" tone="muted" numeric nowrap>
                {t('wisp.crew.more.kit.chars', { n: sizeLabel(body().length) })}
              </Text>
            </Show>
            <Button variant="ghost" size="sm" onClick={() => props.onClose()}>
              {t('wisp.crew.more.cancel')}
            </Button>
            <Button variant="primary" size="sm" onClick={submit}>
              {props.item ? t('wisp.crew.more.save') : t('wisp.crew.more.add')}
            </Button>
          </Inline>
        </Inline>
      }
    >
      <Stack gap="4">
        <Field
          label={t('wisp.crew.more.kit.name')}
          hint={skill ? t('wisp.crew.more.kit.nameHintSkill') : t('wisp.crew.more.kit.nameHintRules')}
          {...(clash() ? { error: t(skill ? 'wisp.crew.more.kit.clashSkill' : 'wisp.crew.more.kit.clashRules', { name: props.name }) } : bad() === 'name' ? { error: t('wisp.crew.more.kit.required') } : {})}
        >
          <Input
            value={name()}
            mono
            maxLength={64}
            spellcheck={false}
            autocomplete="off"
            placeholder={skill ? 'release-notes' : 'AGENTS.md'}
            onInput={(v) => (setName(v), setClash(false), setBad(undefined))}
            onBlur={() => skill && setName(skillName(name()))}
            autofocus={!props.item && skill}
          />
        </Field>
        <Show when={skill}>
          <Field label={t('wisp.crew.more.kit.when')} hint={t('wisp.crew.more.kit.whenHint')} {...(bad() === 'description' ? { error: t('wisp.crew.more.kit.required') } : {})}>
            <TextArea value={desc()} minRows={2} maxLength={1024} placeholder={t('wisp.crew.more.kit.whenPlaceholder')} onInput={(v) => (setDesc(v), setBad(undefined))} />
          </Field>
        </Show>
        <Field
          label={skill ? t('wisp.crew.more.kit.skillBody') : t('wisp.crew.more.kit.rulesBody')}
          hint={skill ? t('wisp.crew.more.kit.skillBodyHint') : t('wisp.crew.more.kit.rulesBodyHint')}
          {...(bad() === 'body' ? { error: t('wisp.crew.more.kit.required') } : {})}
        >
          <TextArea value={body()} mono minRows={10} maxRows={22} maxLength={KIT_BODY_MAX} spellcheck={false} placeholder={skill ? t('wisp.crew.more.kit.skillPlaceholder') : t('wisp.crew.more.kit.rulesPlaceholder')} onInput={onBody} autofocus={!!props.item || !skill} />
        </Field>
      </Stack>
    </Dialog>
  );
}
