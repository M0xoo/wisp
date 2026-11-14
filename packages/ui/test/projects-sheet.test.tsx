// Projects (app/ProjectsSheet.tsx, v1 projects.js): the name edited in place, the hint's command, the found repos.
import { expect, test } from 'vitest';
import { mount } from './helpers.tsx';
import { ProjectsSheet } from '../src/app/ProjectsSheet.tsx';

test('a name is edited in place: Enter keeps it, Escape puts it back; wisp add is code; a found repo adds_v1_projects', () => {
  const said: string[] = [];
  const host = mount(() => (
    <ProjectsSheet
      places={[{ id: '', label: 'This computer', icon: 'folder', on: true }]}
      onPlace={() => {}}
      addMachine={{ label: 'Machine', title: 'Run agents on another computer over SSH', onClick: () => said.push('machine') }}
      field={<input />}
      add={{ label: 'Add', onClick: () => said.push('add') }}
      hint={['Or run ', { code: 'wisp add' }, ' inside any folder.']}
      rows={[{ id: 'web', name: 'web', path: '~/code/web', count: '4 tasks', color: 'violet' }]}
      empty="No projects yet."
      nameLabel="Project name"
      colourLabel="Change colour"
      colours={[{ value: 'teal', label: 'Teal' }]}
      onColour={() => {}}
      onRename={(id, name) => said.push(`rename ${id} ${name}`)}
      removeLabel={(n) => `Remove ${n}`}
      onRemove={(id) => said.push(`remove ${id}`)}
      found={{ heading: 'Found on this machine', sub: '· git repos', items: [{ path: '/u/code/api', name: 'api', where: '~/code', label: 'Add api' }], onAdd: (p) => said.push(`found ${p}`) }}
    />
  ));
  expect(host.querySelector('[data-kit="pj-hint"] code')?.textContent).toBe('wisp add');
  const name = host.querySelector('[data-kit="pj-name"]') as HTMLInputElement;
  name.value = 'webapp';
  name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(name.value).toBe('web');
  name.value = 'webapp';
  name.dispatchEvent(new FocusEvent('blur'));
  (host.querySelector('[data-kit="pj-repo"]') as HTMLButtonElement).click();
  (host.querySelector('[data-kit="pj-remove"]') as HTMLButtonElement).click();
  (host.querySelector('[data-kit="pj-go"]') as HTMLButtonElement).click();
  expect(said).toEqual(['rename web webapp', 'found /u/code/api', 'remove web', 'add']);
});
