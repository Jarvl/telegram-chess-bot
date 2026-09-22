import { describe, expect, it } from 'vitest';
import {
  renderChallengeCard,
  renderGameCard,
  renderShareCaption,
  renderWelcomeCard,
  type ChallengeCardView,
  type GameCardView,
} from '../../src/telegram/cards';

const alice = { name: 'Alice', username: 'alice', telegramUserId: 1 };
const bob = { name: 'Bob', username: 'bob', telegramUserId: 2 };
const bobNoHandle = { name: 'Bob', username: null, telegramUserId: 2 };

const challenge = (over: Partial<ChallengeCardView> = {}): ChallengeCardView => ({
  publicId: 'chal000001',
  status: 'pending',
  challenger: alice,
  opponent: bob,
  timePerMove: 86400,
  rated: true,
  challengerColour: 'random',
  ...over,
});

const game = (over: Partial<GameCardView> = {}): GameCardView => ({
  publicId: 'game000001',
  status: 'active',
  white: alice,
  black: bob,
  timePerMove: 86400,
  rated: true,
  plyCount: 12,
  sideToMove: 'white',
  result: null,
  endReason: null,
  voided: false,
  whiteRating: { before: '1520', after: null },
  blackRating: { before: '1498?', after: null },
  abortedBy: null,
  analysisUrl: null,
  lichessUrl: null,
  openLink: 'https://t.me/GroupChessBot/chess?startapp=g_game000001',
  ...over,
});

describe('renderChallengeCard', () => {
  it('mentions a challenged player with a username by handle', () => {
    const card = renderChallengeCard(challenge());
    expect(card.text).toBe('♟ Alice challenges @bob\n1 day per move · Rated');
    expect(card.entities).toEqual([]);
    expect(card.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: 'Accept', callback_data: 'ch/acc/chal000001' },
          { text: 'Decline', callback_data: 'ch/dec/chal000001' },
        ],
      ],
    });
  });

  it('mentions a challenged player without a username through a text_mention entity', () => {
    const card = renderChallengeCard(
      challenge({ opponent: bobNoHandle, challengerColour: 'white' }),
    );
    expect(card.text).toBe('♟ Alice challenges Bob\n1 day per move · Rated · Alice plays White');
    expect(card.entities).toEqual([
      {
        type: 'text_mention',
        offset: 19,
        length: 3,
        user: { id: 2, first_name: 'Bob', is_bot: false },
      },
    ]);
  });

  it('renders an open challenge with Accept and Cancel', () => {
    const card = renderChallengeCard(challenge({ opponent: null, rated: false }));
    expect(card.text).toBe('♟ Alice is looking for a game\n1 day per move · Casual');
    expect(card.reply_markup?.inline_keyboard[0]?.map((b) => b.text)).toEqual(['Accept', 'Cancel']);
  });

  it.each([
    ['declined', bob, '♟ Alice vs Bob · Declined'],
    ['cancelled', bob, '♟ Alice vs Bob · Challenge withdrawn'],
    ['expired', bob, '♟ Alice vs Bob · Challenge expired'],
    ['cancelled', null, '♟ Alice · Challenge withdrawn'],
    ['expired', null, '♟ Alice · Challenge expired'],
  ] as const)('renders a %s challenge without buttons', (status, opponent, text) => {
    const card = renderChallengeCard(challenge({ status, opponent }));
    expect(card.text).toBe(text);
    expect(card.reply_markup).toBeUndefined();
  });
});

describe('renderGameCard', () => {
  it('renders a running rated game with the move number and the player to move', () => {
    const card = renderGameCard(game());
    expect(card.text).toBe(
      '♟ Alice (1520) vs Bob (1498?)\n1 day per move · Rated · Move 7 · Alice to move',
    );
    expect(card.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: '♟ Open game', url: 'https://t.me/GroupChessBot/chess?startapp=g_game000001' }],
      ],
    });
  });

  it('renders a running casual game without ratings', () => {
    const card = renderGameCard(
      game({
        rated: false,
        whiteRating: null,
        blackRating: null,
        plyCount: 3,
        sideToMove: 'black',
      }),
    );
    expect(card.text).toBe('♟ Alice vs Bob\n1 day per move · Casual · Move 2 · Bob to move');
  });

  it('renders a finished rated game with deltas, Rematch and Analyse', () => {
    const card = renderGameCard(
      game({
        status: 'finished',
        result: '1-0',
        endReason: 'checkmate',
        plyCount: 67,
        whiteRating: { before: '1520', after: '1534' },
        blackRating: { before: '1498', after: '1484' },
        lichessUrl: 'https://lichess.org/abcdefgh',
        analysisUrl: 'https://lichess.org/analysis/pgn/e4',
      }),
    );
    expect(card.text).toBe(
      '♟ Alice (1520 → 1534) vs Bob (1498 → 1484)\nCheckmate · 1-0 · 34 moves · 1 day per move',
    );
    expect(card.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: '🔁 Rematch', callback_data: 'gm/rem/game000001' },
          { text: '🔍 Analyse on Lichess', url: 'https://lichess.org/abcdefgh' },
        ],
      ],
    });
  });

  it('falls back to the analysis board and omits an over-long analysis URL', () => {
    const short = renderGameCard(
      game({
        status: 'finished',
        result: '1/2-1/2',
        endReason: 'draw_agreement',
        analysisUrl: 'https://lichess.org/analysis/pgn/e4_e5',
      }),
    );
    expect(short.reply_markup?.inline_keyboard[0]?.[1]).toEqual({
      text: '🔍 Analyse on Lichess',
      url: 'https://lichess.org/analysis/pgn/e4_e5',
    });
    expect(short.text).toContain('Draw agreed · ½-½');
    const long = renderGameCard(
      game({
        status: 'finished',
        result: '1/2-1/2',
        endReason: 'draw_agreement',
        analysisUrl: `https://lichess.org/analysis/pgn/${'e4_'.repeat(700)}`,
      }),
    );
    expect(long.reply_markup?.inline_keyboard[0]).toEqual([
      { text: '🔁 Rematch', callback_data: 'gm/rem/game000001' },
    ]);
  });

  it('renders aborted games with the reason and a Rematch button', () => {
    const noMove = renderGameCard(
      game({ status: 'finished', result: '*', endReason: 'timeout_abort' }),
    );
    expect(noMove.text).toBe('♟ Alice vs Bob · Aborted\nno move within 1 day');
    expect(noMove.reply_markup?.inline_keyboard[0]?.map((b) => b.text)).toEqual(['🔁 Rematch']);
    const byPlayer = renderGameCard(
      game({ status: 'finished', result: '*', endReason: 'abort', abortedBy: 'Bob' }),
    );
    expect(byPlayer.text).toBe('♟ Alice vs Bob · Aborted\naborted by Bob');
  });

  it('renders a voided game with its former result and Analyse when it had moves', () => {
    const card = renderGameCard(
      game({
        status: 'finished',
        result: '1-0',
        endReason: 'checkmate',
        voided: true,
        plyCount: 40,
        analysisUrl: 'https://lichess.org/analysis/pgn/e4',
      }),
    );
    expect(card.text).toBe('♟ Alice vs Bob · Voided by an admin\nwas Checkmate · 1-0');
    expect(card.reply_markup?.inline_keyboard[0]?.map((b) => b.text)).toEqual([
      '🔍 Analyse on Lichess',
    ]);
    const noMoves = renderGameCard(
      game({ status: 'finished', result: '*', endReason: 'voided', voided: true, plyCount: 0 }),
    );
    expect(noMoves.text).toBe('♟ Alice vs Bob · Voided by an admin');
    expect(noMoves.reply_markup).toBeUndefined();
  });
});

describe('welcome and share', () => {
  it('renders the welcome card with the Open Chess button', () => {
    const card = renderWelcomeCard('https://t.me/GroupChessBot/chess?startapp=l_grp0000001');
    expect(card.text).toBe(
      'Play chess with this group on a real board inside Telegram. The chat only sees results and shared positions.',
    );
    expect(card.reply_markup?.inline_keyboard).toEqual([
      [{ text: '♟ Open Chess', url: 'https://t.me/GroupChessBot/chess?startapp=l_grp0000001' }],
    ]);
  });

  it('renders the share caption', () => {
    expect(
      renderShareCaption({
        sharer: 'Carol',
        moveNumber: 23,
        white: 'Alice',
        black: 'Bob',
        sideToMove: 'black',
      }),
    ).toBe('Carol shared move 23 · Alice vs Bob · Black to move');
  });
});
