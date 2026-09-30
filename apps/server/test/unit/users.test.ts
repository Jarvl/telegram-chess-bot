import { describe, expect, it } from 'vitest';
import type { UserRow } from '../../src/db/schema';
import { displayName, flairEmoji, nameWithFlair } from '../../src/domain/users';

const person = (overrides: Partial<UserRow>) =>
  ({
    firstName: 'Andrew',
    username: null,
    deletedAt: null,
    isEngine: false,
    flairWorn: [],
    ...overrides,
  }) as UserRow;

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

describe('flairEmoji', () => {
  it('joins the worn flair in slot order', () => {
    expect(flairEmoji(person({ flairWorn: ['en_passant_win', 'rank_1500', 'draws_10'] }))).toBe(
      '👑🚶🤝',
    );
  });

  it('is empty when nothing is worn', () => {
    expect(flairEmoji(person({ flairWorn: [] }))).toBe('');
  });

  it('drops ids the catalog no longer has and stops at three', () => {
    const worn = ['retired_flair', 'rank_1500', 'en_passant_win', 'draws_10', 'promotion_win'];
    expect(flairEmoji(person({ flairWorn: worn }))).toBe('🚶👑🤝');
  });

  it('is empty for deleted players and the bot, whatever their rows hold', () => {
    expect(flairEmoji(person({ flairWorn: ['draws_10'], deletedAt: new Date() }))).toBe('');
    expect(flairEmoji(person({ flairWorn: ['draws_10'], isEngine: true }))).toBe('');
  });
});

describe('nameWithFlair', () => {
  it('puts the worn flair after the name, one space apart', () => {
    expect(nameWithFlair(person({ username: 'jarvl', flairWorn: ['en_passant_win'] }))).toBe(
      '@jarvl 👑',
    );
  });

  it('is the bare name without flair', () => {
    expect(nameWithFlair(person({ flairWorn: [] }))).toBe('Andrew');
  });

  it('keeps deleted players anonymous and bare', () => {
    expect(nameWithFlair(person({ flairWorn: ['draws_10'], deletedAt: new Date() }))).toBe(
      'Deleted player',
    );
  });
});
