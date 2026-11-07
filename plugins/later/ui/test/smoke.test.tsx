import { describe, expect, it } from 'vitest';
import ui from '../src/index.ts';
import { t } from '../src/i18n.ts';

describe('wisp.later ui', () => {
  it('declares its plugin id and catalogue', () => {
    expect(ui.id).toBe('wisp.later');
    expect(t('wisp.later.name')).toBe('later');
    for (const key of Object.keys(ui.catalogue ?? {})) expect(key.startsWith('wisp.later.')).toBe(true);
  });
});
