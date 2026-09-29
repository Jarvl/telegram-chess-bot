import type { Colour, MovePattern } from '@group-chess/shared';
import type { MoveRow } from '../db/schema';

/** The columns of a stored move that the detectors read. */
export type StoredMove = Pick<MoveRow, 'ply' | 'uci' | 'san' | 'fenAfter'>;

/**
 * Flair spec §1.8: whether `side` made a pattern. A pure function of the game's stored moves, in
 * ply order; it needs no chess.js replay.
 */
type Detector = (moves: readonly StoredMove[], side: Colour) => boolean;

/** White moves at odd plies, Black at even ones. */
function isBy(move: StoredMove, side: Colour): boolean {
  return move.ply % 2 === (side === 'white' ? 1 : 0);
}

/** The fourth FEN field: the square a pawn could capture onto en passant, or `-`. */
function enPassantSquare(fen: string): string | undefined {
  return fen.split(' ')[3];
}

/**
 * The queen's mating capture on f7 (White) or f2 (Black), and the last ply at which it counts: the
 * side's fourth move.
 */
const SCHOLARS_MATE: Record<Colour, { san: string; lastPly: number }> = {
  white: { san: 'Qxf7#', lastPly: 7 },
  black: { san: 'Qxf2#', lastPly: 8 },
};

/** One detector per pattern; a pattern without one fails the typecheck. */
const DETECTORS: Record<MovePattern, Detector> = {
  // A pawn capture onto the third or sixth rank whose destination is the en-passant square of the
  // position before it. The first move of a game has no position before it, so it is never one.
  en_passant: (moves, side) =>
    moves.some((move, index) => {
      const before = moves[index - 1];
      return (
        before !== undefined &&
        isBy(move, side) &&
        /^[a-h]x[a-h][36]/.test(move.san) &&
        enPassantSquare(before.fenAfter) === move.uci.slice(2, 4)
      );
    }),
  castle_queenside: (moves, side) =>
    moves.some((move) => isBy(move, side) && move.san.startsWith('O-O-O')),
  // A fifth UCI character names the piece promoted to, whichever it is.
  promotion: (moves, side) => moves.some((move) => isBy(move, side) && move.uci.length === 5),
  // The game's last move is the side's mating capture, made by its fourth move at the latest.
  scholars_mate: (moves, side) => {
    const last = moves.at(-1);
    const mate = SCHOLARS_MATE[side];
    return (
      last !== undefined && isBy(last, side) && last.san === mate.san && last.ply <= mate.lastPly
    );
  },
};

/** Whether `side` made `pattern` in the game whose stored moves are `moves`, in ply order. */
export function madePattern(
  pattern: MovePattern,
  moves: readonly StoredMove[],
  side: Colour,
): boolean {
  return DETECTORS[pattern](moves, side);
}
