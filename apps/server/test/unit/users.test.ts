import { describe, expect, it } from 'vitest';
import type { UserRow } from '../../src/db/schema';
import { displayName } from '../../src/domain/users';

const person = (overrides: Partial<UserRow>) =>
  ({ firstName: 'Andrew', username: null, deletedAt: null, ...overrides }) as UserRow;

describe('displayName', () => {
  it('names people by their Telegram handle', () => {
    expect(displayName(person({ username: 'jarvl' }))).toBe('@jarvl');
  });

  it('falls back to the first name when there is no handle', () => {
    expect(displayName(person({ username: null }))).toBe('Andrew');
  });

  it('keeps deleted players anonymous whatever their handle was', () => {
    expect(displayName(person({ username: 'jarvl', deletedAt: new Date() }))).toBe(
      'Deleted player',
    );
  });
});
