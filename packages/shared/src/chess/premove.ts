import type { Colour } from '../protocol/enums';
import { parseUci } from './arbiter';

/**
 * A board layout for premoves (premoves spec, "The imagined position"): square (`e4`) to FEN piece
 * letter (`P` a white pawn, `n` a black knight), plus the castling rights still standing. It can be
 * illegal as chess and that is fine: premoves are checked for real by the arbiter when they fire.
 */
export type PremoveBoard = { pieces: Map<string, string>; castling: string };

const FILES = 'abcdefgh';

const CASTLES = [
  { colour: 'white', right: 'K', king: 'e1', to: 'g1', rookFrom: 'h1', rookTo: 'f1', rook: 'R' },
  { colour: 'white', right: 'Q', king: 'e1', to: 'c1', rookFrom: 'a1', rookTo: 'd1', rook: 'R' },
  { colour: 'black', right: 'k', king: 'e8', to: 'g8', rookFrom: 'h8', rookTo: 'f8', rook: 'r' },
  { colour: 'black', right: 'q', king: 'e8', to: 'c8', rookFrom: 'a8', rookTo: 'd8', rook: 'r' },
] as const;

const KNIGHT = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]] as const;
const STRAIGHT = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const DIAGONAL = [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

export function pieceColour(piece: string): Colour {
  return piece === piece.toUpperCase() ? 'white' : 'black';
}

function square(file: number, rank: number): string | null {
  return file >= 0 && file < 8 && rank >= 1 && rank <= 8 ? `${FILES[file]}${rank}` : null;
}

export function parsePlacement(fen: string): Map<string, string> {
  const pieces = new Map<string, string>();
  fen
    .split(' ')[0]!
    .split('/')
    .forEach((row, index) => {
      const rank = 8 - index;
      let file = 0;
      for (const symbol of row) {
        if (symbol >= '1' && symbol <= '8') {
          file += Number(symbol);
          continue;
        }
        pieces.set(`${FILES[file]}${rank}`, symbol);
        file += 1;
      }
    });
  return pieces;
}

export function placementOf(pieces: ReadonlyMap<string, string>): string {
  const rows: string[] = [];
  for (let rank = 8; rank >= 1; rank -= 1) {
    let row = '';
    let empty = 0;
    for (const file of FILES) {
      const piece = pieces.get(`${file}${rank}`);
      if (!piece) {
        empty += 1;
        continue;
      }
      if (empty) row += String(empty);
      empty = 0;
      row += piece;
    }
    if (empty) row += String(empty);
    rows.push(row);
  }
  return rows.join('/');
}

/** A premove from or to a king or rook home square takes away the rights that square carries. */
function dropRights(castling: string, touched: readonly string[]): string {
  let rights = castling;
  for (const castle of CASTLES) {
    if (touched.includes(castle.king) || touched.includes(castle.rookFrom))
      rights = rights.replace(castle.right, '');
  }
  return rights === '' ? '-' : rights;
}

/** Applies one premove to the layout: no legality, no en passant removal (spec). */
export function applyPremove(board: PremoveBoard, uci: string): PremoveBoard {
  const parsed = parseUci(uci);
  const piece = parsed ? board.pieces.get(parsed.from) : undefined;
  if (!parsed || !piece) return board;
  const pieces = new Map(board.pieces);
  pieces.delete(parsed.from);
  const white = pieceColour(piece) === 'white';
  pieces.set(
    parsed.to,
    parsed.promotion ? (white ? parsed.promotion.toUpperCase() : parsed.promotion) : piece,
  );
  const castle =
    piece.toLowerCase() === 'k'
      ? CASTLES.find((c) => c.king === parsed.from && c.to === parsed.to)
      : undefined;
  const rook = castle ? pieces.get(castle.rookFrom) : undefined;
  if (castle && rook) {
    pieces.delete(castle.rookFrom);
    pieces.set(castle.rookTo, rook);
  }
  return { pieces, castling: dropRights(board.castling, [parsed.from, parsed.to]) };
}

export function imaginedBoard(fen: string, premoves: readonly string[]): PremoveBoard {
  let board: PremoveBoard = { pieces: parsePlacement(fen), castling: fen.split(' ')[2] ?? '-' };
  for (const uci of premoves) board = applyPremove(board, uci);
  return board;
}

function patternTargets(board: PremoveBoard, from: string): string[] {
  const piece = board.pieces.get(from);
  if (!piece) return [];
  const colour = pieceColour(piece);
  const file = FILES.indexOf(from[0]!);
  const rank = Number(from[1]);
  const out: string[] = [];
  const add = (target: string | null) => {
    if (target && target !== from && !out.includes(target)) out.push(target);
  };
  const rays = (dirs: readonly (readonly [number, number])[]) => {
    for (const [df, dr] of dirs)
      for (let k = 1; k < 8; k += 1) add(square(file + df * k, rank + dr * k));
  };
  switch (piece.toLowerCase()) {
    case 'p': {
      const dir = colour === 'white' ? 1 : -1;
      add(square(file, rank + dir));
      if (rank === (colour === 'white' ? 2 : 7)) add(square(file, rank + 2 * dir));
      add(square(file - 1, rank + dir));
      add(square(file + 1, rank + dir));
      break;
    }
    case 'n':
      for (const [df, dr] of KNIGHT) add(square(file + df, rank + dr));
      break;
    case 'b':
      rays(DIAGONAL);
      break;
    case 'r':
      rays(STRAIGHT);
      break;
    case 'q':
      rays([...STRAIGHT, ...DIAGONAL]);
      break;
    case 'k':
      for (const [df, dr] of [...STRAIGHT, ...DIAGONAL]) add(square(file + df, rank + dr));
      for (const castle of CASTLES) {
        if (
          castle.colour === colour &&
          from === castle.king &&
          board.castling.includes(castle.right) &&
          board.pieces.get(castle.rookFrom) === castle.rook
        )
          add(castle.to);
      }
      break;
  }
  return out;
}

/** Pattern-rule targets for every piece of `colour`, shaped for chessground's `movable.dests`. */
export function premoveTargets(board: PremoveBoard, colour: Colour): Map<string, string[]> {
  const dests = new Map<string, string[]>();
  for (const [from, piece] of board.pieces) {
    if (pieceColour(piece) !== colour) continue;
    const targets = patternTargets(board, from);
    if (targets.length > 0) dests.set(from, targets);
  }
  return dests;
}

export function isPremovePromotion(board: PremoveBoard, from: string, to: string): boolean {
  const piece = board.pieces.get(from);
  if (!piece || piece.toLowerCase() !== 'p') return false;
  return to[1] === (pieceColour(piece) === 'white' ? '8' : '1');
}

export function isPremoveAllowed(board: PremoveBoard, colour: Colour, uci: string): boolean {
  const parsed = parseUci(uci);
  const piece = parsed ? board.pieces.get(parsed.from) : undefined;
  if (!parsed || !piece || pieceColour(piece) !== colour) return false;
  if (!patternTargets(board, parsed.from).includes(parsed.to)) return false;
  return isPremovePromotion(board, parsed.from, parsed.to) === (parsed.promotion !== undefined);
}

/** Walks a whole chain from the real position; used by the server's `PUT /premoves`. */
export function checkPremoveChain(
  fen: string,
  colour: Colour,
  premoves: readonly string[],
): { ok: true } | { ok: false; index: number } {
  let board = imaginedBoard(fen, []);
  for (const [index, uci] of premoves.entries()) {
    if (!isPremoveAllowed(board, colour, uci)) return { ok: false, index };
    board = applyPremove(board, uci);
  }
  return { ok: true };
}
