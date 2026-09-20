import { describe, expect, it } from 'vitest';
import { PublicIdSchema, UserIdSchema, isPublicId } from '../../src/protocol/ids';

describe('PublicIdSchema', () => {
  it('accepts ten base62 characters', () => {
    expect(PublicIdSchema.safeParse('aZ09bY18cX').success).toBe(true);
  });

  it.each([
    ['nine characters', 'aZ09bY18c'],
    ['eleven characters', 'aZ09bY18cX1'],
    ['a dash', 'aZ09bY18c-'],
    ['a slash', 'aZ09bY18c/'],
    ['an empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(PublicIdSchema.safeParse(value).success).toBe(false);
  });
});

describe('isPublicId', () => {
  it('narrows only strings of the right shape', () => {
    expect(isPublicId('aZ09bY18cX')).toBe(true);
    expect(isPublicId(1234567890)).toBe(false);
    expect(isPublicId('aZ09bY18c_')).toBe(false);
  });
});

describe('UserIdSchema', () => {
  it('accepts a decimal id without leading zeros', () => {
    expect(UserIdSchema.safeParse('42').success).toBe(true);
    expect(UserIdSchema.safeParse('9007199254740993').success).toBe(true);
  });

  it.each([
    ['zero', '0'],
    ['a leading zero', '042'],
    ['a negative number', '-1'],
    ['letters', '4a2'],
    ['twenty digits', '12345678901234567890'],
  ])('rejects %s', (_label, value) => {
    expect(UserIdSchema.safeParse(value).success).toBe(false);
  });
});
