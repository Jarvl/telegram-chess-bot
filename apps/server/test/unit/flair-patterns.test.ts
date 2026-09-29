import { INITIAL_FEN } from '@group-chess/shared';
import { describe, expect, it } from 'vitest';
import { madePattern } from '../../src/flair/patterns';
import { LINES, play, PROMOTION_FEN } from '../helpers/chess';

const from = (line: readonly string[]) => play(INITIAL_FEN, ...line);

describe('en_passant', () => {
  it('sees a capture en passant, for the side that made it', () => {
    expect(madePattern('en_passant', from(LINES.enPassant), 'white')).toBe(true);
    expect(madePattern('en_passant', from(LINES.enPassant), 'black')).toBe(false);
    expect(madePattern('en_passant', from(LINES.blackEnPassant), 'black')).toBe(true);
  });
  it('ignores an ordinary pawn capture onto the sixth rank', () =>
    expect(madePattern('en_passant', from(LINES.ordinarySixthRankCapture), 'white')).toBe(false));
});

describe('castle_queenside', () => {
  it('sees O-O-O for each side that played it, and not O-O', () => {
    expect(madePattern('castle_queenside', from(LINES.bothCastleQueenside), 'white')).toBe(true);
    expect(madePattern('castle_queenside', from(LINES.bothCastleQueenside), 'black')).toBe(true);
    expect(madePattern('castle_queenside', from(LINES.whiteCastlesKingside), 'white')).toBe(false);
    // By ply 9 only White has castled.
    expect(
      madePattern('castle_queenside', from(LINES.bothCastleQueenside.slice(0, 9)), 'black'),
    ).toBe(false);
  });
});

describe('promotion', () => {
  it('sees a promotion to any piece, for the side that made it', () => {
    expect(madePattern('promotion', play(PROMOTION_FEN, 'e7e8q'), 'white')).toBe(true);
    expect(madePattern('promotion', play(PROMOTION_FEN, 'e7e8n'), 'white')).toBe(true);
    expect(madePattern('promotion', play(PROMOTION_FEN, 'e7e8q'), 'black')).toBe(false);
    // A game with no promotion.
    expect(madePattern('promotion', from(LINES.enPassant), 'white')).toBe(false);
  });
});

describe('scholars_mate', () => {
  it('sees the queen mate on f7 by White’s fourth move, through h5 or f3', () => {
    for (const line of [LINES.scholarsMateQh5, LINES.scholarsMateQf3]) {
      expect(madePattern('scholars_mate', from(line), 'white')).toBe(true);
      expect(madePattern('scholars_mate', from(line), 'black')).toBe(false);
    }
  });
  it('sees Black’s mirror on f2', () =>
    expect(madePattern('scholars_mate', from(LINES.blackScholarsMate), 'black')).toBe(true));
  it('ignores the same mate on move five and a Qxf7+ that is not mate', () => {
    expect(madePattern('scholars_mate', from(LINES.mateOnMoveFive), 'white')).toBe(false);
    expect(madePattern('scholars_mate', from(LINES.checkNotMate), 'white')).toBe(false);
  });
});
