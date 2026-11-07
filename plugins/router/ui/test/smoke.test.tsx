import { describe, expect, it } from 'vitest';
import ui from '../src/index.ts';
import { t } from '../src/i18n.ts';

describe('wisp.router ui', () => {
  it('declares its plugin id and catalogue', () => {
    expect(ui.id).toBe('wisp.router');
    expect(t('wisp.router.name')).toBe('router');
    for (const key of Object.keys(ui.catalogue ?? {})) expect(key.startsWith('wisp.router.')).toBe(true);
  });
});
