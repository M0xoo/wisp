// v1 .l-setup (setup.js renderSetup): no coding agent on this computer, so the launcher offers to install opencode
// (its free models need no account), with a Re-check for one you installed yourself. One line that never wraps.
import { Show, type JSX } from 'solid-js';
import { flag } from '../core/props.ts';
import { Button } from '../controls/Button.tsx';
import { Icon } from '../content/Icon.tsx';

export interface LauncherSetupProps {
  readonly logo?: string | undefined;
  readonly line: string;
  /** the last install failed: the line in red */
  readonly bad?: boolean;
  /** installing: both buttons wait, the install's ring in place */
  readonly busy: boolean;
  readonly recheck: { readonly label: string; readonly busy: boolean; readonly onClick: () => void };
  readonly install: { readonly label: string; readonly onClick: () => void };
}

export function LauncherSetup(props: LauncherSetupProps): JSX.Element {
  return (
    <div data-kit="l-setup" data-part="launcher.setup" data-busy={flag(props.busy)}>
      <span data-kit="ls-logo">
        <Show when={props.logo}>{(src) => <img src={src()} alt="" />}</Show>
      </span>
      <span data-kit="ls-text" data-bad={flag(props.bad && !props.busy)} title={props.line}>
        {props.line}
      </span>
      <button
        type="button"
        data-kit="icon-btn"
        data-part="launcher.setup.recheck"
        data-busy={flag(props.recheck.busy)}
        disabled={props.busy || props.recheck.busy}
        title={props.recheck.label}
        aria-label={props.recheck.label}
        onClick={() => props.recheck.onClick()}
      >
        <Icon name="replay" />
      </button>
      <Button variant="primary" size="sm" part="launcher.setup.install" loading={props.busy} disabled={props.busy} onClick={() => props.install.onClick()}>
        {props.install.label}
      </Button>
    </div>
  );
}
