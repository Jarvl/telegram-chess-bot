import { describe, expect, it } from 'vitest';
import { toPlayerRef } from '../../src/domain/players';

const maya = {
  id: 7,
  firstName: 'Maya',
  username: 'maya',
  deletedAt: null as Date | null,
  isEngine: false,
  flairWorn: [] as string[],
};

describe('toPlayerRef', () => {
  it('carries the worn flair in slot order', () =>
    expect(
      toPlayerRef({ ...maya, flairWorn: ['en_passant_win', 'rank_1500'] }, null).flair,
    ).toEqual(['en_passant_win', 'rank_1500']));

  it('drops ids the catalog no longer has', () =>
    expect(toPlayerRef({ ...maya, flairWorn: ['retired_flair', 'draws_10'] }, null).flair).toEqual([
      'draws_10',
    ]));

  it('gives a deleted player and the bot no flair', () => {
    expect(
      toPlayerRef({ ...maya, flairWorn: ['draws_10'], deletedAt: new Date() }, null).flair,
    ).toEqual([]);
    expect(toPlayerRef({ ...maya, flairWorn: ['draws_10'], isEngine: true }, null).flair).toEqual(
      [],
    );
  });
});
