import { parseUci, pieceColour, type PremoveBoard } from '@group-chess/shared';

export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** A SAN-like chip label for a premove on the board left by the ones before it (premoves spec, Move strip). */
export function premoveLabel(board: PremoveBoard, uci: string): string {
  const parsed = parseUci(uci);
  const piece = parsed ? board.pieces.get(parsed.from) : undefined;
  if (!parsed || !piece) return uci;
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
