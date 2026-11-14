import { expect, test } from 'vitest';
import { fieldsOf, groups, nameOf, pluginName, specOf, type SourceRow } from '../src/when.ts';

const src = (plugin: string, on: string, fields: unknown = {}): SourceRow => ({ plugin, available: true, on, title: on, fields, mode: 'push' });

test('the_when_picker_groups_sources_by_owner_reads_their_fields_and_writes_the_trigger_spec', () => {
  const rows = [
    src('wisp.automations', 'manual'),
    src('wisp.automations', 'schedule', { properties: { cron: { type: 'string', title: 'When' }, tz: { type: 'string' } }, required: ['cron'] }),
    src('wisp.runtime', 'task.finished', { properties: { project: { type: 'string' }, retries: { type: 'integer' }, quiet: { type: 'boolean' }, tags: { type: 'array' } } }),
  ];
  expect(groups(rows).map((g) => [g.plugin, g.sources.map((s) => s.on)])).toEqual([
    ['wisp.automations', ['schedule', 'manual']],
    ['wisp.runtime', ['task.finished']],
  ]);
  expect(pluginName('wisp.runtime')).toBe('Runtime');
  const f = fieldsOf(rows[2]!.fields);
  expect(f.map((x) => `${x.key}:${x.type}`)).toEqual(['project:string', 'retries:number', 'quiet:boolean']);
  const cron = fieldsOf(rows[1]!.fields);
  expect(cron[0]).toMatchObject({ key: 'cron', title: 'When', required: true });
  // what's missing, in order: the source, the prompt, a required field, a number that isn't one
  expect(specOf({ on: '', prompt: 'x', values: {} }, [])).toEqual({ missing: 'on' });
  expect(specOf({ on: 'schedule', prompt: ' ', values: {} }, cron)).toEqual({ missing: 'prompt' });
  expect(specOf({ on: 'schedule', prompt: 'Look', values: {} }, cron)).toEqual({ missing: 'cron' });
  expect(specOf({ on: 'task.finished', prompt: 'Review it', values: { retries: 'two' } }, f)).toEqual({ missing: 'retries' });
  expect(specOf({ on: 'task.finished', prompt: ' Review it ', values: { project: ' web ', retries: '2', quiet: true } }, f)).toEqual({
    spec: { on: 'task.finished', prompt: 'Review it', project: 'web', retries: 2, quiet: true },
  });
  expect(nameOf('Review every PR!')).toBe('review-every-pr');
});
