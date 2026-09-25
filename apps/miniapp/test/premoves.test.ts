import { imaginedBoard, INITIAL_FEN } from '@group-chess/shared';
import { describe, expect, it } from 'vitest';
import { premoveLabel, sameList } from '../src/state/premoves';

describe('premoveLabel', () => {
  const start = imaginedBoard(INITIAL_FEN, []);
  it('names piece moves, pawn pushes and pawn diagonals', () => {
    expect(premoveLabel(start, 'g1h3')).toBe('Nh3');
    expect(premoveLabel(start, 'e2e4')).toBe('e4');
    expect(premoveLabel(start, 'e2d3')).toBe('exd3');
  });
  it('marks a capture only when an opposing piece stands on the target', () => {
    const board = imaginedBoard(INITIAL_FEN, ['f1b5']);
    expect(premoveLabel(board, 'b5d7')).toBe('Bxd7');
    expect(premoveLabel(board, 'd1d2')).toBe('Qd2'); // own pawn on d2: a recapture premove
  });
  it('writes castling and promotion the usual way', () => {
    const castle = imaginedBoard('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1', []);
    expect(premoveLabel(castle, 'e1g1')).toBe('O-O');
    expect(premoveLabel(castle, 'e1c1')).toBe('O-O-O');
    const promote = imaginedBoard('4k3/P7/8/8/8/8/8/4K3 w - - 0 1', []);
    expect(premoveLabel(promote, 'a7a8q')).toBe('a8=Q');
  });
});

describe('premoveLabel for an entry that no longer fits', () => {
  it('falls back to the raw UCI when the from square is empty or holds the other side’s piece', () => {
    const board = imaginedBoard('1R6/3k4/8/8/8/8/P7/4K3 w - - 1 12', []);
    expect(premoveLabel(board, 'c8c6', 'black')).toBe('c8c6');
    expect(premoveLabel(board, 'b8c6', 'black')).toBe('b8c6');
    expect(premoveLabel(board, 'd7d6', 'black')).toBe('Kd6');
  });
});

describe('sameList', () => {
  it('compares order and content', () => {
    expect(sameList(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameList(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameList([], [])).toBe(true);
  });
});
