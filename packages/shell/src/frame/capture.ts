// The attach button (v1 attachments.js, F-comp-13): in the Android app it opens Take photo, Record video and Choose
// files (the camera first: that's what a phone has that a computer doesn't); elsewhere it's the file picker. A photo
// or a video goes in the tray and uploads like a picked file.
import type { Act, IconName, MenuItem } from '@wisp/ui';
import type { ShellContext } from '../contract.ts';
import type { PickOptions } from '../platform/types.ts';

export type AttachKind = 'photo' | 'video' | 'files';

/** What each choice asks the platform's picker for. */
export const PICK: Readonly<Record<AttachKind, PickOptions>> = {
  photo: { accept: 'image/*', capture: true },
  video: { accept: 'video/*', capture: true },
  files: { multiple: true },
};

/** The attach button's act: the menu where the platform has a camera, else a press that opens the picker. */
export function attachAct(shell: ShellContext, pick: (o: PickOptions) => void, pending: boolean): Act {
  if (!shell.platform.camera) return { onClick: () => pick(PICK.files), pending };
  const item = (k: AttachKind, icon: IconName): MenuItem => ({ value: k, label: shell.t(`shell.attach.${k}`), icon, part: 'composer.attachMenu' });
  return {
    pending,
    menu: { items: [item('photo', 'camera'), item('video', 'video'), item('files', 'file')], onSelect: (v) => pick(PICK[v as AttachKind] ?? PICK.files) },
  };
}
