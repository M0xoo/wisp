// One confirm for the pane (v1 ask()): the question as the title, what follows under it, and the
// action named on its button. Cancel, Escape, × or a click outside answer nothing.
import { Show, type JSX } from 'solid-js';
import { Button, Dialog, Inline, Text } from '@wisp/ui';
import { t } from '../i18n.ts';

export interface Ask {
  readonly title: string;
  readonly body: string;
  readonly ok: string;
  readonly danger: boolean;
  readonly run: () => void;
}

export function Confirm(props: { readonly ask: Ask | undefined; readonly onClose: () => void }): JSX.Element {
  return (
    <Show when={props.ask}>
      {(a) => (
        <Dialog
          open
          role="alertdialog"
          size="sm"
          part="worktrees.confirm"
          title={a().title}
          onOpenChange={(open) => {
            if (!open) props.onClose();
          }}
          footer={
            <Inline gap="3" justify="end">
              <Button variant="ghost" onClick={() => props.onClose()}>
                {t('worktrees.cancel')}
              </Button>
              <Button
                variant={a().danger ? 'danger' : 'primary'}
                part="worktrees.confirm.ok"
                onClick={() => {
                  const run = a().run;
                  props.onClose();
                  run();
                }}
              >
                {a().ok}
              </Button>
            </Inline>
          }
        >
          <Text as="p">{a().body}</Text>
        </Dialog>
      )}
    </Show>
  );
}
