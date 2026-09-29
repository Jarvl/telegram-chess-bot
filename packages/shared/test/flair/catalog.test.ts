import { describe, expect, it } from 'vitest';
import {
  FLAIR,
  FLAIR_CATEGORIES,
  flairById,
  flairCategoryKey,
  flairDescriptionKey,
  streak,
  total,
} from '../../src/flair/catalog';
import { t } from '../../src/i18n';

const codePoints = (emoji: string) =>
  [...emoji].map((c) => c.codePointAt(0)!.toString(16).toUpperCase()).join(' ');
const band = (min: number | null, max: number | null) => ({ kind: 'held', min, max });

describe('the flair catalog', () => {
  it('holds the prototype’s 14 flair in display order, code point for code point', () => {
    expect(FLAIR.map((f) => [f.category, f.id, codePoints(f.emoji)])).toEqual([
      ['rank', 'rank_under_1200', '1F98D'],
      ['rank', 'rank_1200', '1F9D1 200D 1F9BC'],
      ['rank', 'rank_1300', '1F9D1 200D 1F9BD'],
      ['rank', 'rank_1400', '1F9D1 200D 1F9AF'],
      ['rank', 'rank_1500', '1F6B6'],
      ['rank', 'rank_1600', '1F3C3'],
      ['rank', 'rank_1700', '1F5FF'],
      ['rank', 'rank_1800', '1F916'],
      ['feat', 'en_passant_win', '1F451'],
      ['feat', 'win_streak_5', '1F525'],
      ['feat', 'queenside_castle_win', '1F3F0'],
      ['feat', 'promotion_win', '265F FE0F'],
      ['feat', 'draws_10', '1F91D'],
      ['dubious', 'scholars_mate_loss', '1FAA4'],
    ]);
  });

  it('gives each flair its rule', () => {
    expect(Object.fromEntries(FLAIR.map((f) => [f.id, f.rule]))).toEqual({
      rank_under_1200: band(null, 1199),
      rank_1200: band(1200, 1299),
      rank_1300: band(1300, 1399),
      rank_1400: band(1400, 1499),
      rank_1500: band(1500, 1599),
      rank_1600: band(1600, 1699),
      rank_1700: band(1700, 1799),
      rank_1800: band(1800, null),
      en_passant_win: { kind: 'won', pattern: 'en_passant' },
      win_streak_5: { kind: 'streak', result: 'win', length: 5, rated: true },
      queenside_castle_win: { kind: 'won', pattern: 'castle_queenside' },
      promotion_win: { kind: 'won', pattern: 'promotion' },
      draws_10: { kind: 'total', result: 'draw', count: 10, rated: false },
      scholars_mate_loss: { kind: 'lost', pattern: 'scholars_mate' },
    });
  });

  it('gives every rating exactly one rung', () => {
    const ladder = FLAIR.filter((f) => f.category === 'rank');
    const bands = ladder.flatMap(({ rule }) => (rule.kind === 'held' ? [rule] : []));
    expect(bands).toHaveLength(ladder.length);

    // Open at both ends, and every other rung starts one rating above the rung before it. A null
    // max below the top becomes NaN, which no min equals.
    expect(bands[0]?.min).toBeNull();
    expect(bands.at(-1)?.max).toBeNull();
    expect(bands.slice(1).map((b) => b.min)).toEqual(
      bands.slice(0, -1).map((b) => (b.max ?? NaN) + 1),
    );

    // A rung whose min is above its max would let the bands overlap and still meet end to end.
    expect(bands.filter((b) => b.min !== null && b.max !== null && b.min > b.max)).toEqual([]);
  });

  it('describes each flair in the prototype’s words', () => {
    expect(FLAIR.map((f) => t(flairDescriptionKey(f.id)))).toEqual([
      'Held a rating under 1200',
      'Held a rating of 1200–1299',
      'Held a rating of 1300–1399',
      'Held a rating of 1400–1499',
      'Held a rating of 1500–1599',
      'Held a rating of 1600–1699',
      'Held a rating of 1700–1799',
      'Held a rating of 1800 or more',
      'Capture en passant and win the game',
      'Win five rated games in a row',
      'Win a game you castled queenside in',
      'Promote a pawn and win the game',
      'Draw ten games',
      'Lose to a scholar’s mate',
    ]);
  });

  it('titles the categories in display order', () => {
    expect(FLAIR_CATEGORIES.map((c) => t(flairCategoryKey(c)))).toEqual([
      'Rank ladder',
      'Feats',
      'Dubious honours',
    ]);
  });

  it('never repeats an id or an emoji', () => {
    expect(new Set(FLAIR.map((f) => f.id)).size).toBe(FLAIR.length);
    expect(new Set(FLAIR.map((f) => f.emoji)).size).toBe(FLAIR.length);
  });

  it('finds a flair by id, and nothing for an id it no longer has', () => {
    expect(flairById('draws_10')?.emoji).toBe('🤝');
    expect(flairById('retired_flair')).toBeUndefined();
  });

  it('leaves streaks and totals unrated unless asked', () => {
    expect(total('draw', 10)).toEqual({ kind: 'total', result: 'draw', count: 10, rated: false });
    expect(streak('win', 5, { rated: true })).toEqual({
      kind: 'streak',
      result: 'win',
      length: 5,
      rated: true,
    });
  });
});
