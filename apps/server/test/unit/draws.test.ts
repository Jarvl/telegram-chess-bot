import { describe, expect, it } from 'vitest';
import { canOfferDraw } from '../../src/domain/draws';

const game = (over: Partial<Parameters<typeof canOfferDraw>[0]>) => ({
  drawOfferBy: null,
  lastDrawOfferPlyWhite: null,
  lastDrawOfferPlyBlack: null,
  plyCount: 0,
  ...over,
});

describe('canOfferDraw', () => {
  it('allows a first offer and refuses one while another is pending', () => {
    expect(canOfferDraw(game({}), 'white')).toBe(true);
    expect(canOfferDraw(game({ drawOfferBy: 'white' }), 'black')).toBe(false);
  });

  it('requires the player to have moved since their last offer', () => {
    expect(canOfferDraw(game({ lastDrawOfferPlyWhite: 0, plyCount: 0 }), 'white')).toBe(false);
    expect(canOfferDraw(game({ lastDrawOfferPlyWhite: 0, plyCount: 1 }), 'white')).toBe(true);
    expect(canOfferDraw(game({ lastDrawOfferPlyWhite: 1, plyCount: 2 }), 'white')).toBe(false);
    expect(canOfferDraw(game({ lastDrawOfferPlyWhite: 1, plyCount: 3 }), 'white')).toBe(true);
    expect(canOfferDraw(game({ lastDrawOfferPlyBlack: 1, plyCount: 1 }), 'black')).toBe(false);
    expect(canOfferDraw(game({ lastDrawOfferPlyBlack: 1, plyCount: 2 }), 'black')).toBe(true);
    expect(canOfferDraw(game({ lastDrawOfferPlyBlack: 2, plyCount: 3 }), 'black')).toBe(false);
    expect(canOfferDraw(game({ lastDrawOfferPlyBlack: 2, plyCount: 4 }), 'black')).toBe(true);
  });
});
