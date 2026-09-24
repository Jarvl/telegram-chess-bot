import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FONT_MANIFEST } from '../../../../scripts/fetch-fonts.mjs';
import { FONT_FILES, loadFonts } from '../../src/images/fonts';

describe('loadFonts', () => {
  it('loads every fetched font, in the fallback order', async () => {
    const fonts = await loadFonts();
    expect(fonts.map((font) => [font.name, font.weight])).toEqual([
      ['Noto Sans', 400],
      ['Noto Sans', 600],
      ['Noto Sans', 700],
      ['Noto Emoji', 400],
      ['Noto Sans Symbols 2', 400],
      ['Noto Sans CJK SC', 400],
    ]);
    for (const font of fonts) expect((font.data as Buffer).length).toBeGreaterThan(100_000);
  });

  it('loads exactly the files the fetch script downloads', () => {
    expect(FONT_FILES).toEqual(FONT_MANIFEST.map((entry) => entry.file));
  });

  it('says how to fix a missing font', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'no-fonts-'));
    try {
      await expect(loadFonts(empty)).rejects.toThrow(
        'fonts missing in apps/server/fonts, run pnpm fonts',
      );
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
