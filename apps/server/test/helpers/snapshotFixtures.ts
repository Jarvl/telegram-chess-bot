import { INITIAL_FEN } from '@group-chess/shared';
import type { SnapshotInput } from '../../src/images/snapshotModel';

export const SHARED_AT = new Date('2026-09-24T12:00:00Z');
export const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

/** An active, rated, one-day game at its start, shared by White; override what a test needs. */
export function snapshotInput(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    ply: 0,
    sans: [],
    board: { fen: INITIAL_FEN, lastMove: null, check: false, orientation: 'white' },
    white: { name: '@sam_k', rating: { rating: 1512, rd: 50 }, engineLevel: null },
    black: { name: '@mayachess', rating: { rating: 1587, rd: 50 }, engineLevel: null },
    groupTitle: 'Friday Chess Club',
    timePerMove: 86400,
    rated: true,
    status: 'active',
    result: null,
    endReason: null,
    plyCount: 0,
    deadlineAt: new Date(SHARED_AT.getTime() + 86_400_000),
    sharedAt: SHARED_AT,
    ...overrides,
  };
}
