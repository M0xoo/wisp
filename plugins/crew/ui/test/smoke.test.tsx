import { describe, expect, it } from 'vitest';
import ui from '../src/index.ts';
import { t } from '../src/i18n.ts';

describe('wisp.crew ui', () => {
  it('declares its plugin id and catalogue', () => {
    expect(ui.id).toBe('wisp.crew');
    expect(t('wisp.crew.name')).toBe('crew');
    for (const key of Object.keys(ui.catalogue ?? {})) expect(key.startsWith('wisp.crew.')).toBe(true);
  });
});
