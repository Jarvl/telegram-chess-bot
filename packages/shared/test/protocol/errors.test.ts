import { describe, expect, it } from 'vitest';
import {
  ApiErrorBodySchema,
  HTTP_STATUS_BY_ERROR_CODE,
  apiErrorBody,
} from '../../src/protocol/errors';

describe('ApiErrorBodySchema', () => {
  it('parses a body produced by apiErrorBody', () => {
    expect(ApiErrorBodySchema.parse(apiErrorBody('stale_state', 'expected ply 12'))).toEqual({
      error: { code: 'stale_state', message: 'expected ply 12' },
    });
  });

  it('rejects unknown codes', () => {
    expect(ApiErrorBodySchema.safeParse({ error: { code: 'teapot', message: '' } }).success).toBe(
      false,
    );
  });
});

describe('HTTP_STATUS_BY_ERROR_CODE', () => {
  it.each([
    ['stale_state', 409],
    ['not_your_turn', 409],
    ['expired', 409],
    ['illegal_move', 422],
    ['rate_limited', 429],
    ['unauthorized', 401],
    ['validation', 400],
    ['internal', 500],
  ] as const)('%s maps to %d', (code, status) => {
    expect(HTTP_STATUS_BY_ERROR_CODE[code]).toBe(status);
  });
});
