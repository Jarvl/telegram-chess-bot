import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Colour } from '@group-chess/shared';

/** What a board image URL carries; `check` is derived from the FEN when the image is drawn. */
export type SignedBoard = { fen: string; lastMove: string | null; orientation: Colour };

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

function signature(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(`board-image:${payload}`).digest('base64url');
}

/**
 * `/api/board-images/<board>/<signature>`, with `/board.jpg` or `/thumb.jpg` appended. Telegram
 * fetches share-sheet photos by URL, so the URL itself says what to draw and nothing is stored;
 * the signature keeps the endpoint to boards this server issued.
 */
export function boardImagePath(secret: string, board: SignedBoard): string {
  const payload = Buffer.from(
    [board.fen, board.orientation, board.lastMove ?? ''].join('|'),
    'utf8',
  ).toString('base64url');
  return `/api/board-images/${payload}/${signature(secret, payload)}`;
}

/** The board a URL names, or null when the signature does not match. */
export function verifyBoardImage(
  secret: string,
  payload: string,
  given: string,
): SignedBoard | null {
  const expected = Buffer.from(signature(secret, payload));
  const actual = Buffer.from(given);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  const [fen, orientation, lastMove = ''] = Buffer.from(payload, 'base64url')
    .toString('utf8')
    .split('|');
  if (!fen || (orientation !== 'white' && orientation !== 'black')) return null;
  if (lastMove !== '' && !UCI.test(lastMove)) return null;
  return { fen, orientation, lastMove: lastMove || null };
}
