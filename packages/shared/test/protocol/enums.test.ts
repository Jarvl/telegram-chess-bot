import { describe, expect, it } from 'vitest';
import { TimePerMoveSchema, isRatedEndReason, opposite } from '../../src/protocol/enums';

describe('TimePerMoveSchema', () => {
  it.each([3600, 28800, 86400, 259200, 604800, null])('accepts %s', (value) => {
    expect(TimePerMoveSchema.safeParse(value).success).toBe(true);
  });

  it.each([0, 7200, 86400.5, '86400', undefined])('rejects %s', (value) => {
    expect(TimePerMoveSchema.safeParse(value).success).toBe(false);
  });
});

describe('opposite', () => {
  it('flips the colour', () => {
    expect(opposite('white')).toBe('black');
    expect(opposite('black')).toBe('white');
  });
});

describe('isRatedEndReason', () => {
  it.each([
    'checkmate',
    'stalemate',
    'insufficient_material',
    'fivefold_repetition',
    'seventy_five_moves',
    'threefold_claim',
    'fifty_move_claim',
    'draw_agreement',
    'resignation',
    'timeout',
  ] as const)('%s changes ratings', (reason) => {
    expect(isRatedEndReason(reason)).toBe(true);
  });

  it.each(['timeout_abort', 'abort', 'voided'] as const)('%s leaves ratings alone', (reason) => {
    expect(isRatedEndReason(reason)).toBe(false);
  });
});
