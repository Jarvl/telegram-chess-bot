import { INITIAL_FEN } from '@group-chess/shared';
import type { SnapshotInput } from '../../src/images/snapshotModel';

export const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

/** An active, rated game at its start, shared by White; override what a test needs. */
export function snapshotInput(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    ply: 0,
    board: { fen: INITIAL_FEN, lastMove: null, check: false, orientation: 'white' },
    white: {
      id: '7',
      name: '@sam_k',
      isBot: false,
      rating: { rating: 1512, rd: 50 },
      engineLevel: null,
      ratingChange: null,
      photo: null,
    },
    black: {
      id: '8',
      name: '@mayachess',
      isBot: false,
      rating: { rating: 1587, rd: 50 },
      engineLevel: null,
      ratingChange: null,
      photo: null,
    },
    status: 'active',
    result: null,
    plyCount: 0,
    voided: false,
    botUsername: 'ChessGoatBot',
    ...overrides,
  };
}
