import { describe, expect, it } from 'vitest';
import {
  GLICKO2,
  INITIAL_RATING,
  inflateForInactivity,
  isProvisional,
  ratePeriod,
} from '../../src/rating/glicko2';

describe('ratePeriod', () => {
  it("reproduces the worked example in Glickman's paper", () => {
    const player = { rating: 1500, rd: 200, volatility: 0.06 };
    const result = ratePeriod(
      player,
      [
        { opponent: { rating: 1400, rd: 30, volatility: 0.06 }, score: 1 },
        { opponent: { rating: 1550, rd: 100, volatility: 0.06 }, score: 0 },
        { opponent: { rating: 1700, rd: 300, volatility: 0.06 }, score: 0 },
      ],
      0.5,
    );
    expect(result.rating).toBeCloseTo(1464.06, 1);
    expect(result.rd).toBeCloseTo(151.52, 2);
    expect(result.volatility).toBeCloseTo(0.05999, 4);
  });

  it('only widens the deviation in a period without games', () => {
    const result = ratePeriod({ rating: 1500, rd: 200, volatility: 0.06 }, []);
    expect(result.rating).toBe(1500);
    expect(result.rd).toBeCloseTo(200.27, 1);
    expect(result.volatility).toBe(0.06);
  });

  it('raises the winner and lowers the loser by the same amount for equal players', () => {
    const a = { rating: 1500, rd: 100, volatility: 0.06 };
    const b = { rating: 1500, rd: 100, volatility: 0.06 };
    const winner = ratePeriod(a, [{ opponent: b, score: 1 }]);
    const loser = ratePeriod(b, [{ opponent: a, score: 0 }]);
    expect(winner.rating).toBeGreaterThan(1500);
    expect(loser.rating).toBeLessThan(1500);
    expect(winner.rating - 1500).toBeCloseTo(1500 - loser.rating, 6);
  });

  it('leaves equal players equal after a draw while shrinking their deviation', () => {
    const a = { rating: 1500, rd: 200, volatility: 0.06 };
    const result = ratePeriod(a, [{ opponent: a, score: 0.5 }]);
    expect(result.rating).toBeCloseTo(1500, 6);
    expect(result.rd).toBeLessThan(200);
  });

  it('never drops the deviation below the floor', () => {
    const settled = { rating: 1500, rd: 45, volatility: 0.06 };
    const manyDraws = Array.from({ length: 50 }, () => ({
      opponent: settled,
      score: 0.5 as const,
    }));
    const result = ratePeriod(settled, manyDraws);
    expect(result.rd).toBe(GLICKO2.rdFloor);
  });

  it('stays finite for an extreme rating gap', () => {
    const newcomer = { rating: 1500, rd: 350, volatility: 0.06 };
    const result = ratePeriod(newcomer, [
      { opponent: { rating: 3000, rd: 350, volatility: 0.06 }, score: 1 },
    ]);
    expect(Number.isFinite(result.rating)).toBe(true);
    expect(result.rating).toBeGreaterThan(1500);
    expect(result.rd).toBeGreaterThanOrEqual(GLICKO2.rdFloor);
    expect(result.rd).toBeLessThanOrEqual(GLICKO2.rdCeiling);
    expect(Number.isFinite(result.volatility)).toBe(true);
  });
});

describe('inflateForInactivity', () => {
  it('applies one volatility step per idle day', () => {
    const result = inflateForInactivity({ rating: 1600, rd: 50, volatility: 0.06 }, 100);
    expect(result.rating).toBe(1600);
    expect(result.rd).toBeCloseTo(115.6, 1);
  });

  it('never inflates the deviation above the ceiling', () => {
    const result = inflateForInactivity({ rating: 1600, rd: 340, volatility: 0.06 }, 10_000);
    expect(result.rd).toBe(GLICKO2.rdCeiling);
  });

  it('changes nothing for zero idle days', () => {
    const player = { rating: 1600, rd: 50, volatility: 0.06 };
    expect(inflateForInactivity(player, 0)).toEqual(player);
  });
});

describe('isProvisional', () => {
  it('is provisional above a deviation of 110', () => {
    expect(isProvisional(INITIAL_RATING.rd)).toBe(true);
    expect(isProvisional(110.5)).toBe(true);
    expect(isProvisional(110)).toBe(false);
  });
});
