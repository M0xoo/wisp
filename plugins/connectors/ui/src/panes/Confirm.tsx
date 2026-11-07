// A confirm (design/copy.md): the question first, the consequence after it, the action on the
// button. The kit has no `ask()` yet, so each pane package carries this small one over Dialog.

import type { JSX } from 'solid-js';
import { Button, Dialog, Inline, Text } from '@wisp/ui';
import { t } from '../i18n.ts';

export interface ConfirmProps {
  readonly open: boolean;
  readonly question: string;
  readonly detail: string;
  readonly ok: string;
  readonly danger?: boolean;
  readonly onAnswer: (yes: boolean) => void;
}

export function Confirm(props: ConfirmProps): JSX.Element {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(o) => {
        if (!o) props.onAnswer(false);
      }}
      role="alertdialog"
      size="sm"
      title={props.question}
      part="connectors.confirm"
      footer={
        <Inline gap="3" justify="end">
          <Button variant="ghost" size="sm" onClick={() => props.onAnswer(false)}>
            {t('connectors.cancel')}
          </Button>
          <Button variant={props.danger === true ? 'danger' : 'primary'} size="sm" onClick={() => props.onAnswer(true)}>
            {props.ok}
          </Button>
        </Inline>
      }
    >
      <Text as="p" tone="muted">
        {props.detail}
      </Text>
    </Dialog>
  );
}
