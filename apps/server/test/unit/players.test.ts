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
