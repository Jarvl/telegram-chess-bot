import { beforeAll, describe, expect, it } from 'vitest';
import { snapshotImageKey } from '../../src/images/cache';
import { loadFonts, type SnapshotFonts } from '../../src/images/fonts';
import { renderSnapshotPng, renderSnapshotSvg } from '../../src/images/snapshot';
import { buildSnapshotModel, type SnapshotInput } from '../../src/images/snapshotModel';
import { snapshotInput } from '../helpers/snapshotFixtures';

let fonts: SnapshotFonts;
beforeAll(async () => {
  fonts = await loadFonts();
});

const render = (overrides: Partial<SnapshotInput> = {}) =>
  renderSnapshotSvg(buildSnapshotModel(snapshotInput(overrides)), fonts);

describe('renderSnapshotPng', () => {
  it('rasterises the card to a 1664 × 1024 PNG', async () => {
    const png = renderSnapshotPng(await render());
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(1664);
    expect(png.readUInt32BE(20)).toBe(1024);
  });
});

describe('renderSnapshotSvg', () => {
  it('is deterministic, and changes with what the card shows', async () => {
    expect(await render()).toBe(await render());
    expect(await render()).not.toBe(await render({ groupTitle: 'Another club' }));
    expect(await render()).not.toBe(
      await render({ board: { ...snapshotInput().board, orientation: 'black' } }),
    );
  });

  it('draws text as paths, so the SVG carries no font dependency', async () => {
    const svg = await render();
    expect(svg).toMatch(/^<svg /);
    expect(svg).not.toContain('<text');
  });

  it.each([
    ['CJK and Hangul names', { name: '李小龍 さくら 김민수', rating: null, engineLevel: null }],
    ['a 60-character unbroken name', { name: 'x'.repeat(60), rating: null, engineLevel: null }],
    ['XML-special characters', { name: `<b>&"'</b>`, rating: null, engineLevel: null }],
  ])('renders %s without throwing', async (_label, white) => {
    const svg = await render({ white });
    expect(() => renderSnapshotPng(svg)).not.toThrow();
  });

  it('renders emoji, ZWJ sequences, flags and chess symbols in a group title', async () => {
    const svg = await render({ groupTitle: '♞ Goats 🐐🔥 👨‍👩‍👧 🇺🇦 & <friends>' });
    expect(() => renderSnapshotPng(svg)).not.toThrow();
  });

  it('renders a long game with faded rows and a finished result', async () => {
    const sans = Array.from({ length: 61 }, (_, i) => (i % 2 ? 'Nxe5+' : 'Qxd8#'));
    const svg = await render({
      ply: 61,
      plyCount: 61,
      sans,
      status: 'finished',
      result: '1-0',
      endReason: 'checkmate',
      deadlineAt: null,
    });
    expect(() => renderSnapshotPng(svg)).not.toThrow();
  });
});

describe('snapshotImageKey', () => {
  it('is the sha256 of the card, so identical cards share a key', async () => {
    const svg = await render();
    expect(snapshotImageKey(svg)).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshotImageKey(svg)).toBe(snapshotImageKey(await render()));
    expect(snapshotImageKey(svg)).not.toBe(snapshotImageKey(await render({ rated: false })));
  });
});
