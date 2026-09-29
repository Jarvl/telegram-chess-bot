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

  it('sends at most three, whatever is stored, after dropping ids the catalog no longer has', () => {
    // The app refuses a player with more than three, so one bad row would break every screen
    // showing them.
    const four = ['rank_1500', 'en_passant_win', 'draws_10', 'promotion_win'];
    expect(toPlayerRef({ ...maya, flairWorn: four }, null).flair).toEqual(four.slice(0, 3));
    expect(toPlayerRef({ ...maya, flairWorn: ['retired_flair', ...four] }, null).flair).toEqual(
      four.slice(0, 3),
    );
  });

  it('gives a deleted player and the bot no flair', () => {
    expect(
      toPlayerRef({ ...maya, flairWorn: ['draws_10'], deletedAt: new Date() }, null).flair,
    ).toEqual([]);
    expect(toPlayerRef({ ...maya, flairWorn: ['draws_10'], isEngine: true }, null).flair).toEqual(
      [],
    );
  });
});
