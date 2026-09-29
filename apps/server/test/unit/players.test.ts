import { describe, expect, it } from 'vitest';
import type { UserRow } from '../../src/db/schema';
import { toPlayerRef } from '../../src/domain/players';

const HASH = 'a'.repeat(64);
const person = (overrides: Partial<UserRow>) =>
  ({
    id: 7,
    firstName: 'Alice',
    username: null,
    deletedAt: null,
    isEngine: false,
    photoHash: null,
    flairWorn: [],
    ...overrides,
  }) as UserRow;

describe('toPlayerRef photo url', () => {
  it("points at the player's stored photo", () => {
    expect(toPlayerRef(person({ photoHash: HASH }), null).photoUrl).toBe(
      `/api/avatars/${HASH}.jpg`,
    );
  });

  it('is null without a photo', () => {
    expect(toPlayerRef(person({ photoHash: null }), null).photoUrl).toBeNull();
  });

  it('is null for the bot, whatever its row holds', () => {
    expect(toPlayerRef(person({ isEngine: true, photoHash: HASH }), null).photoUrl).toBeNull();
  });

  it('is null for a deleted player', () => {
    expect(
      toPlayerRef(person({ deletedAt: new Date(), photoHash: HASH }), null).photoUrl,
    ).toBeNull();
  });
});

describe('toPlayerRef flair', () => {
  it('carries the worn flair in slot order', () =>
    expect(toPlayerRef(person({ flairWorn: ['en_passant_win', 'rank_1500'] }), null).flair).toEqual(
      ['en_passant_win', 'rank_1500'],
    ));

  it('drops ids the catalog no longer has', () =>
    expect(toPlayerRef(person({ flairWorn: ['retired_flair', 'draws_10'] }), null).flair).toEqual([
      'draws_10',
    ]));

  it('sends at most three, whatever is stored, after dropping ids the catalog no longer has', () => {
    // The app refuses a player with more than three, so one bad row would break every screen
    // showing them.
    const four = ['rank_1500', 'en_passant_win', 'draws_10', 'promotion_win'];
    expect(toPlayerRef(person({ flairWorn: four }), null).flair).toEqual(four.slice(0, 3));
    expect(toPlayerRef(person({ flairWorn: ['retired_flair', ...four] }), null).flair).toEqual(
      four.slice(0, 3),
    );
  });

  it('gives a deleted player and the bot no flair', () => {
    expect(
      toPlayerRef(person({ flairWorn: ['draws_10'], deletedAt: new Date() }), null).flair,
    ).toEqual([]);
    expect(toPlayerRef(person({ flairWorn: ['draws_10'], isEngine: true }), null).flair).toEqual(
      [],
    );
  });
});
