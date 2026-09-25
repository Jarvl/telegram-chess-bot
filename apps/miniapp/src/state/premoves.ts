import { parseUci, pieceColour, type Colour, type PremoveBoard } from '@group-chess/shared';

export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * A SAN-like chip label for a premove on the board left by the ones before it (premoves spec, Move
 * strip). An entry the opponent has since made impossible (its from square empty, or holding their
 * piece) keeps its raw UCI until the server cancels it.
 */
export function premoveLabel(board: PremoveBoard, uci: string, owner?: Colour): string {
  const parsed = parseUci(uci);
  const piece = parsed ? board.pieces.get(parsed.from) : undefined;
  if (!parsed || !piece) return uci;
  if (owner !== undefined && pieceColour(piece) !== owner) return uci;
  const kind = piece.toLowerCase();
  const fromFile = parsed.from.charCodeAt(0);
  const toFile = parsed.to.charCodeAt(0);
  if (kind === 'k' && Math.abs(toFile - fromFile) === 2) return toFile > fromFile ? 'O-O' : 'O-O-O';
  if (kind === 'p') {
    const diagonal = fromFile !== toFile ? `${parsed.from[0]}x` : '';
    const promotion = parsed.promotion ? `=${parsed.promotion.toUpperCase()}` : '';
    return `${diagonal}${parsed.to}${promotion}`;
  }
  const target = board.pieces.get(parsed.to);
  const captures = target !== undefined && pieceColour(target) !== pieceColour(piece);
  return `${kind.toUpperCase()}${captures ? 'x' : ''}${parsed.to}`;
}
