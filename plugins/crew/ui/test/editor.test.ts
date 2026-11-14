import { expect, test } from 'vitest';
import { TEMPLATES, addWake, draftOf, fromTemplate, patchOf, problemOf, toggleOn, wakeLabel, type Template, type TemplateText } from '../src/editor.ts';
import type { Member } from '../src/types.ts';

const say = (k: string, v?: Readonly<Record<string, string | number>>): string => (k === 'wisp.crew.editor.wake.after' ? `After ${v?.['name']} reports` : k);

test('the_crew_editor_saves_only_what_changed_and_its_wakes_as_trigger_specs_for_this_member', () => {
  const m = { name: 'Ada', role: 'reviews PRs', brief: '', cron: '', parallel: 1, agent: 'claude', mode: 'auto', cwd: '/w/web', wakes: [{ on: 'pr.opened' }] } as unknown as Member;
  const d = draftOf(m);
  expect(d.wakes).toEqual([{ on: 'pr.opened' }]);
  // a new one: on call, one job at once, Full auto, no wakes
  // a new member runs two jobs at once, as v1's editor starts them (`member?.parallel || 2`)
  expect(draftOf(undefined)).toMatchObject({ name: '', cron: '', parallel: 2, mode: 'auto', wakes: [], on: [], avatar: '' });
  // only the changes go, trimmed; a hand-off after Bob reports
  const wakes = addWake(d.wakes, 'crew.reported', 'Bob');
  expect(patchOf({ ...d, role: ' reviews every PR ', wakes }, d)).toEqual({ role: 'reviews every PR', wakes: [{ on: 'pr.opened' }, { on: 'crew.reported', match: { member: 'Bob' } }] });
  expect(patchOf(d, d)).toEqual({});
  expect(addWake(wakes, 'crew.reported', 'Bob')).toHaveLength(2);
  expect(wakeLabel({ on: 'crew.reported', match: { member: 'Bob' } }, (o) => o, say)).toBe('After Bob reports');
  expect(wakeLabel({ on: 'pr.opened' }, () => 'PR opened', say)).toBe('PR opened');
  // the name: needed, its shape, not another member's
  expect(problemOf({ ...d, name: ' ' }, [])).toBe('wisp.crew.editor.need.name');
  expect(problemOf({ ...d, name: '!x' }, [])).toBe('wisp.crew.editor.bad.name');
  expect(problemOf({ ...d, name: 'bob' }, ['Bob'])).toBe('wisp.crew.editor.taken');
  expect(problemOf(d, ['Bob'])).toBeUndefined();
});

test('a_crew_member_row_reads_its_fields_from_its_body_as_the_crew_host_writes_it', async () => {
  const { memberOf } = await import('../src/data.ts');
  const m = memberOf({ id: 'm1', name: 'Ada', updated_at: 5, body: { id: 'm1', name: 'Ada', role: 'reviews', avatar: 'blob.teal', paused: true, wakes: [{ on: 'pr.opened' }] } });
  expect(m).toMatchObject({ id: 'm1', name: 'Ada', role: 'reviews', avatar: 'blob.teal', paused: true, wakes: [{ on: 'pr.opened' }] });
  // a row already flat (dev data, an optimistic upsert) is its own
  expect(memberOf({ id: 'm2', name: 'Bob', role: 'x' })).toMatchObject({ role: 'x' });
});

test('a_template_fills_the_editor_as_v1s_does_and_the_event_chips_and_face_save_with_the_rest', () => {
  const text = (k: string): TemplateText => ({ name: `N-${k}`, role: `R-${k}`, brief: `B-${k}` });
  const names = TEMPLATES.map((x) => text(x.key).name);
  const verify = TEMPLATES.find((x) => x.key === 'verify') as Template;
  const ci = TEMPLATES.find((x) => x.key === 'ci') as Template;
  // empty name: the template's own; its role, brief, schedule, events and face
  const a = fromTemplate(draftOf(undefined), verify, text('verify'), names);
  expect(a).toMatchObject({ name: 'N-verify', role: 'R-verify', brief: 'B-verify', cron: '', on: ['finished'], avatar: verify.avatar });
  // another template replaces a template's name (a suggestion), never one you typed
  expect(fromTemplate(a, ci, text('ci'), names)).toMatchObject({ name: 'N-ci', cron: '*/30 * * * *', on: [] });
  expect(fromTemplate({ ...a, name: 'Mine' }, ci, text('ci'), names).name).toBe('Mine');
  // the event chips toggle; an event v1 doesn't know is dropped when a member is read
  expect(toggleOn(['finished'], 'ci')).toEqual(['finished', 'ci']);
  expect(toggleOn(['finished', 'ci'], 'finished')).toEqual(['ci']);
  expect(draftOf({ on: ['done', 'nope'] } as unknown as Member).on).toEqual(['done']);
  // Save sends the face and the events with whatever else changed
  const before = draftOf({ name: 'Ada', avatar: 'blob.teal', on: [] } as unknown as Member);
  expect(patchOf({ ...before, avatar: 'ghost.sky', on: ['ci'] }, before)).toEqual({ avatar: 'ghost.sky', on: ['ci'] });
});

test('settling_an_offer_shows_at_once_as_the_peer_will_keep_it', async () => {
  const { settled } = await import('../src/commands.ts');
  const offers = [
    { id: 'o1', job: 's1', at: 1, state: 'open' as const, files: [] },
    { id: 'o2', job: 's2', at: 1, state: 'open' as const, files: [] },
  ];
  expect(settled(offers, [{ id: 'o2', state: 'taken', names: ['AGENTS.md'] }], 9)).toEqual([offers[0], { ...offers[1], state: 'taken', names: ['AGENTS.md'], settledAt: 9 }]);
  expect(settled(offers, [{ id: 'gone', state: 'dismissed', names: [] }], 9)).toEqual(offers);
});
