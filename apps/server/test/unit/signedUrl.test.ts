import { describe, expect, it } from 'vitest';
import { boardImagePath, verifyBoardImage } from '../../src/images/signedUrl';

const SECRET = 's'.repeat(32);
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

function parts(path: string): { payload: string; signature: string } {
  const [, , , payload, signature] = path.split('/');
  return { payload: payload!, signature: signature! };
}

describe('signed board image URLs', () => {
  it('round-trips the board the URL was issued for', () => {
    const board = { fen: AFTER_E4, lastMove: 'e2e4', orientation: 'black' as const };
    const path = boardImagePath(SECRET, board);
    expect(path).toMatch(/^\/api\/board-images\/[\w-]+\/[\w-]+$/);
    const { payload, signature } = parts(path);
    expect(verifyBoardImage(SECRET, payload, signature)).toEqual(board);
  });

  it('keeps a null last move for the initial position', () => {
    const board = {
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      lastMove: null,
      orientation: 'white' as const,
    };
    const { payload, signature } = parts(boardImagePath(SECRET, board));
    expect(verifyBoardImage(SECRET, payload, signature)).toEqual(board);
  });

  it('refuses a board it did not sign, or one signed with another secret', () => {
    const { payload, signature } = parts(
      boardImagePath(SECRET, { fen: AFTER_E4, lastMove: 'e2e4', orientation: 'white' }),
    );
    const other = parts(
      boardImagePath(SECRET, { fen: AFTER_E4, lastMove: 'e2e4', orientation: 'black' }),
    );
    expect(verifyBoardImage(SECRET, other.payload, signature)).toBeNull();
    expect(verifyBoardImage('t'.repeat(32), payload, signature)).toBeNull();
    expect(verifyBoardImage(SECRET, payload, signature.slice(1))).toBeNull();
    expect(verifyBoardImage(SECRET, payload, '')).toBeNull();
  });
});
