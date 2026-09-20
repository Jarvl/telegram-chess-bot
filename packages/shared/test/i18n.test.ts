import { describe, expect, it } from 'vitest';
import {
  endReasonLabel,
  format,
  movesLabel,
  ratedLabel,
  ratingLabel,
  resultLabel,
  t,
  timePerMoveLabel,
  timeSpanLabel,
} from '../src/i18n';

describe('format', () => {
  it('interpolates named parameters', () => {
    expect(format('{a} vs {b}', { a: 'Alice', b: 'Bob' })).toBe('Alice vs Bob');
  });

  it('leaves unknown placeholders in place', () => {
    expect(format('Move {n} · {missing}', { n: 12 })).toBe('Move 12 · {missing}');
  });
});

describe('t', () => {
  it('renders a challenge card title', () => {
    expect(t('card.challenge.direct', { challenger: 'Alice', opponent: 'Bob' })).toBe(
      '♟ Alice challenges Bob',
    );
  });

  it('renders the running card status line', () => {
    expect(
      t('card.running.status', {
        timePerMove: timePerMoveLabel(86400),
        rated: ratedLabel(true),
        moveNumber: 12,
        sideToMove: 'Bob',
      }),
    ).toBe('1 day per move · Rated · Move 12 · Bob to move');
  });
});

describe('labels', () => {
  it.each([
    [3600, '1 hour per move'],
    [28800, '8 hours per move'],
    [86400, '1 day per move'],
    [259200, '3 days per move'],
    [604800, '7 days per move'],
    [null, 'No clock'],
  ] as const)('timePerMoveLabel(%s)', (value, expected) => {
    expect(timePerMoveLabel(value)).toBe(expected);
  });

  it('names a time span for abort reasons', () => {
    expect(timeSpanLabel(86400)).toBe('1 day');
    expect(timeSpanLabel(28800)).toBe('8 hours');
  });

  it('pluralises moves', () => {
    expect(movesLabel(1)).toBe('1 move');
    expect(movesLabel(34)).toBe('34 moves');
  });

  it('names end reasons', () => {
    expect(endReasonLabel('checkmate')).toBe('Checkmate');
    expect(endReasonLabel('seventy_five_moves')).toBe('75-move rule');
    expect(endReasonLabel('voided')).toBe('Voided by an admin');
  });

  it('shows draws with the ½ glyph', () => {
    expect(resultLabel('1/2-1/2')).toBe('½-½');
    expect(resultLabel('1-0')).toBe('1-0');
  });

  it('marks provisional ratings with a question mark', () => {
    expect(ratingLabel(1519.6, false)).toBe('1520');
    expect(ratingLabel(1500, true)).toBe('1500?');
  });

  it('names rated and casual games', () => {
    expect(ratedLabel(true)).toBe('Rated');
    expect(ratedLabel(false)).toBe('Casual');
  });
});
