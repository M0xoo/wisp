import { describe, expect, it } from 'vitest';
import ui from '../src/index.ts';
import { t } from '../src/i18n.ts';

describe('wisp.goal ui', () => {
  it('declares its plugin id and catalogue', () => {
    expect(ui.id).toBe('wisp.goal');
    expect(t('wisp.goal.name')).toBe('goal');
    for (const key of Object.keys(ui.catalogue ?? {})) expect(key.startsWith('wisp.goal.')).toBe(true);
  });
});
