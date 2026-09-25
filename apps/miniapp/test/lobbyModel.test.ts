import { describe, expect, it } from 'vitest';
import { rankOf, scopedGames } from '../src/state/lobby';
import { gameSummary, playerRef } from './support/summaryFixtures';

const mine = gameSummary({ id: 'MineAaaaaa', yourTurn: false });
const mineWaiting = gameSummary({ id: 'MineBbbbbb', yourTurn: true });
const theirs = gameSummary({
  id: 'TheirsAaaa',
  white: playerRef('3', 'Carol'),
  black: playerRef('4', 'Dan'),
  yourTurn: false,
});
const data = {
  active: [mine, theirs, mineWaiting],
  finished: { items: [theirs, mine], nextCursor: null },
};

describe('scopedGames', () => {
  it('keeps only the viewer’s games in "mine", their move first', () => {
    const { active, finished } = scopedGames(data, 'mine', '1');
    expect(active.map((g) => g.id)).toEqual(['MineBbbbbb', 'MineAaaaaa']);
    expect(finished.map((g) => g.id)).toEqual(['MineAaaaaa']);
  });

  it('keeps only games the viewer is not in under "others"', () => {
    const { active, finished } = scopedGames(data, 'others', '1');
    expect(active.map((g) => g.id)).toEqual(['TheirsAaaa']);
    expect(finished.map((g) => g.id)).toEqual(['TheirsAaaa']);
  });
});

describe('rankOf', () => {
  const entry = (id: string) => ({
    ...playerRef(id, id),
    gamesPlayed: 6,
    record: { wins: 3, draws: 1, losses: 2 },
  });

  it('finds the viewer’s 1-based rank', () => {
    expect(rankOf([entry('5'), entry('1')], '1')).toMatchObject({ rank: 2, entry: { id: '1' } });
  });

  it('is null when the viewer is not on the board', () => {
    expect(rankOf([entry('5')], '1')).toBeNull();
    expect(rankOf([entry('5')], null)).toBeNull();
  });
});
