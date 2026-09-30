import { describe, expect, it } from 'vitest';
import type { UserRow } from '../../src/db/schema';
import { nameWithFlair } from '../../src/domain/users';
import {
  challengeStub,
  deletedStub,
  drawOfferText,
  gameEndedStub,
  reminderText,
  resultText,
  turnText,
  waitingText,
} from '../../src/telegram/dmText';

const turn = {
  opponent: '@bob 👑',
  lastMove: '12. Nf3',
  timeLeft: '2 d',
  drawOffered: false,
  premovesCancelled: false,
};

describe('turnText', () => {
  it('keeps the plain turn line', () => {
    expect(turnText(turn)).toBe('Your move vs @bob 👑 · 12. Nf3 · 2 d left');
  });

  it('adds the draw offer line when the opponent offered', () => {
    expect(turnText({ ...turn, drawOffered: true })).toBe(
      'Your move vs @bob 👑 · 12. Nf3 · 2 d left\n\n@bob 👑 offers a draw.',
    );
  });

  it('puts the draw offer line before the premoves line', () => {
    expect(turnText({ ...turn, drawOffered: true, premovesCancelled: true })).toBe(
      'Your move vs @bob 👑 · 12. Nf3 · 2 d left\n\n@bob 👑 offers a draw.\n\nYour premoves were cancelled.',
    );
  });

  it('drops the clock and the last move when there are none', () => {
    expect(turnText({ ...turn, lastMove: null, timeLeft: null })).toBe('Your move vs @bob 👑');
  });
});

describe('reminderText', () => {
  it('names the time left and the opponent', () => {
    expect(reminderText({ opponent: '@bob', timeLeft: '7 h' })).toBe(
      '7 h left for your move vs @bob',
    );
  });
});

describe('drawOfferText', () => {
  it.each([
    ['12. Nf3', '2 d', '@bob offers a draw · 12. Nf3 · 2 d left'],
    ['12. Nf3', null, '@bob offers a draw · 12. Nf3'],
    [null, '2 d', '@bob offers a draw · 2 d left'],
    [null, null, '@bob offers a draw'],
  ])('with last move %s and time %s', (lastMove, timeLeft, expected) => {
    expect(drawOfferText({ opponent: '@bob', lastMove, timeLeft })).toBe(expected);
  });
});

describe('resultText', () => {
  it('reports a win with the new rating and its gain', () => {
    expect(
      resultText({
        outcome: 'win',
        opponent: '@bob',
        endReason: 'resignation',
        rating: { before: 1504.4, after: 1512.3, rdAfter: 60 },
      }),
    ).toBe('You won vs @bob · Resignation · 1512 (+8)');
  });

  it('reports a loss with a minus sign', () => {
    expect(
      resultText({
        outcome: 'loss',
        opponent: '@bob',
        endReason: 'timeout',
        rating: { before: 1499, after: 1490, rdAfter: 60 },
      }),
    ).toBe('You lost vs @bob · Timeout · 1490 (−9)');
  });

  it('shows ±0 when the rounded rating did not move', () => {
    expect(
      resultText({
        outcome: 'draw',
        opponent: '@bob',
        endReason: 'draw_agreement',
        rating: { before: 1500.2, after: 1499.8, rdAfter: 60 },
      }),
    ).toBe('Draw vs @bob · Draw agreed · 1500 (±0)');
  });

  it('marks a provisional rating', () => {
    expect(
      resultText({
        outcome: 'win',
        opponent: '@bob',
        endReason: 'checkmate',
        rating: { before: 1500, after: 1650, rdAfter: 200 },
      }),
    ).toBe('You won vs @bob · Checkmate · 1650? (+150)');
  });

  it('leaves the rating off a casual game', () => {
    expect(
      resultText({ outcome: 'loss', opponent: '@bob', endReason: 'checkmate', rating: null }),
    ).toBe('You lost vs @bob · Checkmate');
  });
});

describe('waiting line and stubs', () => {
  it('writes the waiting line', () => {
    expect(waitingText({ move: '12... Nf6', opponent: '@tom 🔥' })).toBe(
      '✓ You played 12... Nf6 · waiting for @tom 🔥',
    );
  });

  it('names the challenger and the outcome', () => {
    expect(challengeStub('@alice', 'expired')).toBe('Challenge from @alice expired');
    expect(challengeStub('@alice', 'accepted')).toBe('Challenge from @alice accepted');
  });

  it('names a deleted opponent without flair', () => {
    const deleted = {
      firstName: 'Tom',
      username: 'tom',
      deletedAt: new Date(),
      isEngine: false,
      flairWorn: ['rank_under_1200'],
    } as UserRow;
    expect(gameEndedStub(nameWithFlair(deleted))).toBe('Game vs Deleted player ended');
  });

  it('has a nameless stub for a deleted account', () => {
    expect(deletedStub()).toBe('Game ended');
  });
});
