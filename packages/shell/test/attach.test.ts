import { expect, test } from 'vitest';
import { filesOf, named, upload } from '../src/frame/attach.ts';
import type { ShellContext } from '../src/contract.ts';

test('pasted_and_dropped_files_become_chips_and_go_up_to_the_tasks_computer_as_its_attachments', async () => {
  const a = new File(['x'], 'notes.md', { type: 'text/markdown' });
  const shot = new File(['png'], 'image.png', { type: 'image/png' });
  // a drop's files; a paste's image comes as an item in some browsers
  expect(filesOf({ files: [a], items: [] } as unknown as DataTransfer)).toEqual([a]);
  expect(filesOf({ files: [], items: [{ kind: 'string', getAsFile: () => null }, { kind: 'file', getAsFile: () => shot }] } as unknown as DataTransfer)).toEqual([shot]);
  expect(filesOf({ files: [], items: [{ kind: 'string', getAsFile: () => null }] } as unknown as DataTransfer)).toEqual([]);
  expect(filesOf(null)).toEqual([]);
  // a pasted screenshot is named for when it came (v1); a real name stays
  expect(named(shot, Date.UTC(2026, 10, 11, 9, 30)).name).toBe('pasted-2026-11-11T09-30-00-000Z.png');
  expect(named(a, 0)).toBe(a);
  // up through the client's route call to the task's peer, each answer an attachment
  const sent: { peer: string; path: string; body: unknown }[] = [];
  const shell = {
    client: {
      plugin: () => ({
        http: (peer: string) => ({
          send: (r: { path: string; body: unknown }) => {
            sent.push({ peer, path: r.path, body: r.body });
            return Promise.resolve({ id: 'u1', name: 'notes.md', mime: 'text/markdown', size: 1, path: '/x' });
          },
        }),
      }),
    },
  } as unknown as ShellContext;
  expect(await upload(shell, 'studio' as never, [a])).toEqual([{ id: 'u1', name: 'notes.md', mime: 'text/markdown', size: 1 }]);
  expect(sent).toEqual([{ peer: 'studio', path: '/uploads?name=notes.md&type=text%2Fmarkdown', body: a }]);
});
