import { applyMove, positionKey } from '@group-chess/shared';
import type { StoredMove } from '../../src/flair/patterns';

/** White to move, with a pawn on e7 one step from promoting on e8 (flair spec §7). */
export const PROMOTION_FEN = '3k4/4P3/8/8/8/8/8/4K3 w - - 0 1';

/**
 * Games for the flair move-pattern tests (flair spec §1.8, §7), in coordinate notation from the
 * initial position. Each line was replayed with the shared arbiter, and the mates are mates at the
 * plies noted.
 */
export const LINES = {
  enPassant: ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6'],
  ordinarySixthRankCapture: ['e2e4', 'd7d5', 'e4d5', 'e7e6', 'd5e6'],
  blackEnPassant: ['a2a3', 'e7e5', 'a3a4', 'e5e4', 'd2d4', 'e4d3'],
  bothCastleQueenside: [
    'd2d4',
    'd7d5',
    'c1f4',
    'c8f5',
    'b1c3',
    'b8c6',
    'd1d2',
    'd8d7',
    'e1c1',
    'e8c8',
  ],
  whiteCastlesKingside: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'e1g1'],
  scholarsMateQh5: ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6', 'h5f7'], // Qxf7# at ply 7
  scholarsMateQf3: ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1f3', 'd7d6', 'f3f7'], // Qxf7# at ply 7
  blackScholarsMate: ['a2a3', 'e7e5', 'h2h3', 'f8c5', 'b2b3', 'd8h4', 'c2c3', 'h4f2'], // Qxf2# at ply 8
  mateOnMoveFive: ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'a7a6', 'b1c3', 'g8f6', 'h5f7'], // ply 9
  checkNotMate: ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'h5f7'], // Qxf7+
} as const;

/**
 * Replays `ucis` from `start` with the shared arbiter, carrying the position keys as the server
 * does, and returns the rows the `moves` table would hold. Plies start at 1, so White moves at odd
 * plies when `start` has White to move, as in every stored game. Throws on an illegal move.
 */
export function play(start: string, ...ucis: string[]): StoredMove[] {
  const keys = [positionKey(start)];
  let fen = start;
  return ucis.map((uci, index) => {
    const result = applyMove(fen, keys, uci);
    if (!result.legal) throw new Error(`illegal move ${uci} at ply ${index + 1} in ${fen}`);
    fen = result.fenAfter;
    keys.push(positionKey(fen));
    return { ply: index + 1, uci: result.uci, san: result.san, fenAfter: result.fenAfter };
  });
}
