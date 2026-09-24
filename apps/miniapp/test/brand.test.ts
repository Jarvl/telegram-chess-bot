import { en } from '@group-chess/shared';
import { describe, expect, it } from 'vitest';
import { AUTHOR_URL, BRAND, REPO_URL } from '../src/brand';

describe('brand', () => {
  it('names the app Chess Goat and points at its author and source', () => {
    expect(BRAND.name).toBe('Chess Goat');
    expect(AUTHOR_URL).toBe('https://t.me/Jarvl');
    expect(REPO_URL).toBe('https://github.com/Jarvl/telegram-chess-bot');
    expect(BRAND.markUrl).toMatch(/goat-mark/);
    expect(BRAND.bannerUrl).toMatch(/goat-banner/);
  });

  it('says Chess Goat in the licence note', () => {
    expect(en['app.settings.about']).toContain('Chess Goat is free software');
    expect(en['app.settings.about']).not.toContain('Group Chess');
  });
});
