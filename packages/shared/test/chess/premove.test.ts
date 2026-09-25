import { describe, expect, it } from 'vitest';
import { INITIAL_FEN } from '../../src/chess/arbiter';
import {
  applyPremove,
  checkPremoveChain,
  imaginedBoard,
  isPremoveAllowed,
  isPremovePromotion,
  parsePlacement,
  placementOf,
  premoveTargets,
} from '../../src/chess/premove';

const sorted = (list: string[] | undefined) => [...(list ?? [])].sort();
/** 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5: both sides may still castle short. */
const ITALIAN = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
/** White's rook took Black's knight on b8 with check, and Black's king stepped to d7. */
const AFTER_RXB8 = '1R6/3k4/8/8/8/8/P7/4K3 w - - 1 12';

describe('placement', () => {
  it('round-trips a FEN placement', () => {
    expect(placementOf(parsePlacement(INITIAL_FEN))).toBe(INITIAL_FEN.split(' ')[0]);
    expect(parsePlacement(INITIAL_FEN).get('e1')).toBe('K');
    expect(parsePlacement(INITIAL_FEN).get('d8')).toBe('q');
  });
});

describe('premoveTargets (the pattern rule)', () => {
  const start = imaginedBoard(INITIAL_FEN, []);

  it('lets a pawn go one or two forward from its start rank and to both diagonals, occupied or not', () => {
    expect(sorted(premoveTargets(start, 'white').get('e2'))).toEqual(['d3', 'e3', 'e4', 'f3']);
    expect(sorted(premoveTargets(start, 'black').get('a7'))).toEqual(['a5', 'a6', 'b6']);
  });

  it("ignores blockers for sliders and allows squares held by the player's own pieces", () => {
    const queen = premoveTargets(start, 'black').get('d8') ?? [];
    expect(queen).toContain('h4'); // through the e7 pawn
    expect(queen).toContain('d1'); // the whole file
    expect(queen).toContain('e8'); // the king\'s own square: own-occupied is allowed
    expect(queen).not.toContain('d8');
    expect(sorted(premoveTargets(start, 'white').get('g1'))).toEqual(['e2', 'f3', 'h3']);
  });

  it('offers castling only with the right, the king home and the rook in its corner', () => {
    const board = imaginedBoard(ITALIAN, []);
    expect(premoveTargets(board, 'white').get('e1')).toContain('g1');
    expect(premoveTargets(board, 'white').get('e1')).toContain('c1'); // the pattern ignores b1-d1
    const noRights = imaginedBoard(ITALIAN.replace('KQkq', 'kq'), []);
    expect(premoveTargets(noRights, 'white').get('e1')).not.toContain('g1');
    const rookGone = applyPremove(board, 'h1g1');
    expect(premoveTargets(rookGone, 'white').get('e1')).not.toContain('g1');
    const kingStepped = applyPremove(applyPremove(board, 'e1f1'), 'f1e1');
    expect(premoveTargets(kingStepped, 'white').get('e1')).not.toContain('g1');
  });
});

describe('applyPremove and imaginedBoard', () => {
  it('moves the piece over whatever was on the target', () => {
    const board = imaginedBoard(INITIAL_FEN, ['d7d5', 'd5e4', 'd8d2']);
    expect(board.pieces.get('e4')).toBe('p');
    expect(board.pieces.get('d2')).toBe('q');
    expect(board.pieces.has('d8')).toBe(false);
  });

  it('puts the promotion piece on the target and moves the rook when the king castles', () => {
    const promoted = imaginedBoard('4k3/P7/8/8/8/8/8/4K3 w - - 0 1', ['a7a8n']);
    expect(promoted.pieces.get('a8')).toBe('N');
    const castled = imaginedBoard(ITALIAN, ['e1g1']);
    expect(castled.pieces.get('g1')).toBe('K');
    expect(castled.pieces.get('f1')).toBe('R');
    expect(castled.pieces.has('h1')).toBe(false);
    expect(castled.castling).toBe('kq');
  });

  it('skips an entry whose from square does not hold the owner’s piece, when told the owner', () => {
    // After 1.Rxb8+ Kd7 a queued Nb8-d7 finds White's rook on b8. Moving that rook would put it
    // on top of Black's own king in the imagined position.
    const board = imaginedBoard(AFTER_RXB8, []);
    expect(applyPremove(board, 'b8d7', 'black')).toBe(board);
    expect(imaginedBoard(AFTER_RXB8, ['b8d7'], 'black').pieces.get('d7')).toBe('k');
    expect(imaginedBoard(AFTER_RXB8, ['b8d7']).pieces.get('d7')).toBe('R');
    expect(imaginedBoard(AFTER_RXB8, ['d7d6'], 'black').pieces.get('d6')).toBe('k');
  });

  it('does not remove a pawn for an en passant-shaped premove', () => {
    const board = imaginedBoard('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', ['e5d6']);
    expect(board.pieces.get('d5')).toBe('p');
    expect(board.pieces.get('d6')).toBe('P');
  });
});

describe('isPremoveAllowed and checkPremoveChain', () => {
  it('requires a promotion piece exactly when a pawn reaches the last rank', () => {
    const board = imaginedBoard('4k3/P7/8/8/8/8/8/4K3 b - - 0 1', []);
    expect(isPremovePromotion(board, 'a7', 'a8')).toBe(true);
    expect(isPremovePromotion(board, 'e1', 'e2')).toBe(false);
    expect(isPremoveAllowed(board, 'white', 'a7a8q')).toBe(true);
    expect(isPremoveAllowed(board, 'white', 'a7a8')).toBe(false);
    expect(isPremoveAllowed(board, 'white', 'e1e2q')).toBe(false);
  });

  it('rejects an empty or foreign from square and an off-pattern target', () => {
    const board = imaginedBoard(INITIAL_FEN, []);
    expect(isPremoveAllowed(board, 'black', 'e4e5')).toBe(false);
    expect(isPremoveAllowed(board, 'black', 'e2e4')).toBe(false);
    expect(isPremoveAllowed(board, 'black', 'g8g6')).toBe(false);
    expect(isPremoveAllowed(board, 'black', 'nonsense')).toBe(false);
  });

  it('checks each premove on the board left by the ones before it, and names the first bad one', () => {
    expect(checkPremoveChain(INITIAL_FEN, 'black', ['e7e5', 'e5e4', 'e4e3'])).toEqual({ ok: true });
    expect(checkPremoveChain(INITIAL_FEN, 'black', ['e7e5', 'e7e6'])).toEqual({
      ok: false,
      index: 1,
    });
    expect(checkPremoveChain(INITIAL_FEN, 'black', [])).toEqual({ ok: true });
  });

  it('checks only from `from` on, walking the entries before it unchecked, with absolute indexes', () => {
    // d7d4 is off the pattern, but a stored entry before `from` is not the edit's to answer for.
    expect(checkPremoveChain(INITIAL_FEN, 'black', ['d7d4', 'd4d3'])).toEqual({
      ok: false,
      index: 0,
    });
    expect(checkPremoveChain(INITIAL_FEN, 'black', ['d7d4', 'd4d3'], 1)).toEqual({ ok: true });
    // The unchecked entry still moved the pawn: the next one is checked from d4.
    expect(checkPremoveChain(INITIAL_FEN, 'black', ['d7d4', 'd4d1'], 1)).toEqual({
      ok: false,
      index: 1,
    });
    expect(checkPremoveChain(INITIAL_FEN, 'black', ['d7d4', 'd4d3', 'e7e1'], 1)).toEqual({
      ok: false,
      index: 2,
    });
    // A pure truncation or an unchanged chain checks nothing.
    expect(checkPremoveChain(INITIAL_FEN, 'black', ['d7d4'], 1)).toEqual({ ok: true });
  });

  it('never moves the opponent’s piece for an unchecked entry', () => {
    // Black's stored Nb8-d7 now finds White's rook on b8: skipped, so the king is still on d7.
    expect(checkPremoveChain(AFTER_RXB8, 'black', ['b8d7', 'd7d6'], 1)).toEqual({ ok: true });
  });

  it('accepts a long chain', () => {
    const shuffle = Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? 'g8f6' : 'f6g8'));
    expect(checkPremoveChain(INITIAL_FEN, 'black', shuffle)).toEqual({ ok: true });
  });
});
