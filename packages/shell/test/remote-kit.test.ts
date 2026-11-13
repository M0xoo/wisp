// What an untrusted plugin's UI may describe is one list in two places: descriptor.ts draws it, and
// src/remote/kit.json is what agents write a plugin from (wisp_plugin_schema, wisp_plugin_check).
// They must say the same, or an agent writes descriptors the app drops (or never uses ones it draws).
import { describe, expect, test } from 'vitest';
import kit from '../src/remote/kit.json' with { type: 'json' };
import { KIT, LIMITS, PARENTS } from '../src/remote/descriptor.ts';
import { PRELUDE } from '../src/remote/frame.ts';

describe('the kit agents write untrusted plugins from (ADR-0048)', () => {
  test('agents_reference_kit_is_the_one_the_descriptor_renderer_draws', () => {
    expect(kit.components).toEqual(KIT);
    expect([...kit.parents].sort()).toEqual([...PARENTS].sort());
    const { module: _module, ...limits } = kit.limits;
    expect(limits).toEqual(LIMITS);
    expect(Object.keys(kit.events).every((c) => Object.hasOwn(KIT, c))).toBe(true);
  });

  test('agents_reference_names_the_wisp_api_the_worker_has', () => {
    // its members, one per line: `render: …`, `call,`, `on: …`
    const api = PRELUDE.split('self.wisp = Object.freeze({')[1]?.split('\n  });')[0] ?? '';
    const names = [...api.matchAll(/^ {4}(\w+)\b/gm)].map((m) => m[1]);
    expect(names.sort()).toEqual([...kit.api].sort());
  });
});
