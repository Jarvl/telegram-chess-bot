import {
  encodeCallbackData,
  endReasonLabel,
  movesLabel,
  ratedLabel,
  resultLabel,
  t,
  timePerMoveLabel,
  timeSpanLabel,
  type ChallengeStatus,
  type Colour,
  type ColourChoice,
  type EndReason,
  type GameResult,
  type GameStatus,
  type MessageKey,
  type MessageParams,
  type TimePerMove,
  type TimePerMoveSeconds,
} from '@group-chess/shared';
import type { InlineKeyboardButton, InlineKeyboardMarkup, MessageEntity } from 'grammy/types';

export const MAX_BUTTON_URL_LENGTH = 2000;

export type PersonView = { name: string; username: string | null; telegramUserId: number | null };

export type RenderedMessage = {
  text: string;
  entities: MessageEntity[];
  reply_markup?: InlineKeyboardMarkup;
};

export type ChallengeCardView = {
  publicId: string;
  status: ChallengeStatus;
  challenger: PersonView;
  opponent: PersonView | null;
  timePerMove: TimePerMove;
  rated: boolean;
  challengerColour: ColourChoice;
};

export type GameCardView = {
  publicId: string;
  status: GameStatus;
  white: PersonView;
  black: PersonView;
  timePerMove: TimePerMove;
  rated: boolean;
  plyCount: number;
  sideToMove: Colour;
  result: GameResult | null;
  endReason: EndReason | null;
  voided: boolean;
  /** Rating labels (`1520`, `1498?`); null for casual games. */
  whiteRating: { before: string; after: string | null } | null;
  blackRating: { before: string; after: string | null } | null;
  abortedBy: string | null;
  analysisUrl: string | null;
  lichessUrl: string | null;
  openLink: string;
};

const MENTION_MARK = '\u0000';

/** Renders a template whose `{opponent}` slot is a mention: `@username`, else a text_mention entity (spec §5.4). */
function withMention(
  key: MessageKey,
  params: MessageParams,
  slot: string,
  person: PersonView,
): { text: string; entities: MessageEntity[] } {
  const rendered = t(key, { ...params, [slot]: MENTION_MARK });
  const offset = rendered.indexOf(MENTION_MARK);
  if (person.username) {
    return { text: rendered.replace(MENTION_MARK, `@${person.username}`), entities: [] };
  }
  const text = rendered.replace(MENTION_MARK, person.name);
  if (person.telegramUserId === null) return { text, entities: [] };
  return {
    text,
    entities: [
      {
        type: 'text_mention',
        offset,
        length: person.name.length,
        user: { id: person.telegramUserId, first_name: person.name, is_bot: false },
      },
    ],
  };
}

function keyboard(rows: InlineKeyboardButton[][]): InlineKeyboardMarkup | undefined {
  const nonEmpty = rows.filter((row) => row.length > 0);
  return nonEmpty.length > 0 ? { inline_keyboard: nonEmpty } : undefined;
}

function urlButton(text: string, url: string | null): InlineKeyboardButton | null {
  if (!url || url.length > MAX_BUTTON_URL_LENGTH) return null;
  return { text, url };
}

function terms(view: ChallengeCardView): string {
  const base = { timePerMove: timePerMoveLabel(view.timePerMove), rated: ratedLabel(view.rated) };
  if (view.challengerColour === 'random') return t('card.challenge.terms', base);
  return t('card.challenge.terms_colour', {
    ...base,
    challenger: view.challenger.name,
    colour: t(`colour.${view.challengerColour}`),
  });
}

export function renderChallengeCard(view: ChallengeCardView): RenderedMessage {
  const challenger = view.challenger.name;
  if (view.status === 'pending') {
    const line1 = view.opponent
      ? withMention('card.challenge.direct', { challenger }, 'opponent', view.opponent)
      : { text: t('card.challenge.open', { challenger }), entities: [] };
    const accept = {
      text: t('button.accept'),
      callback_data: encodeCallbackData({ action: 'accept_challenge', challengeId: view.publicId }),
    };
    const declineOrCancel = {
      text: t(view.opponent ? 'button.decline' : 'button.cancel'),
      callback_data: encodeCallbackData({
        action: 'decline_challenge',
        challengeId: view.publicId,
      }),
    };
    return {
      text: `${line1.text}\n${terms(view)}`,
      entities: line1.entities,
      reply_markup: keyboard([[accept, declineOrCancel]]),
    };
  }
  const params = { challenger, opponent: view.opponent?.name ?? '' };
  const key: MessageKey = view.opponent
    ? view.status === 'declined'
      ? 'card.challenge.declined'
      : view.status === 'expired'
        ? 'card.challenge.expired'
        : 'card.challenge.withdrawn'
    : view.status === 'expired'
      ? 'card.challenge.open_expired'
      : 'card.challenge.open_withdrawn';
  return { text: t(key, params), entities: [] };
}

export function renderGameCard(view: GameCardView): RenderedMessage {
  const white = view.white.name;
  const black = view.black.name;
  const rematch = {
    text: t('button.rematch'),
    callback_data: encodeCallbackData({ action: 'rematch', gameId: view.publicId }),
  };
  const analyse = urlButton(t('button.analyse'), view.lichessUrl ?? view.analysisUrl);

  if (view.voided) {
    const lines = [t('card.voided.title', { white, black })];
    if (view.result && view.result !== '*' && view.endReason && view.endReason !== 'voided') {
      lines.push(
        t('card.voided.status', {
          endReason: endReasonLabel(view.endReason),
          result: resultLabel(view.result),
        }),
      );
    }
    const buttons = view.plyCount > 0 && analyse ? [analyse] : [];
    return { text: lines.join('\n'), entities: [], reply_markup: keyboard([buttons]) };
  }

  if (view.status === 'active') {
    const title =
      view.rated && view.whiteRating && view.blackRating
        ? t('card.running.title', {
            white,
            black,
            whiteRating: view.whiteRating.before,
            blackRating: view.blackRating.before,
          })
        : t('card.running.title_casual', { white, black });
    const status = t('card.running.status', {
      timePerMove: timePerMoveLabel(view.timePerMove),
      rated: ratedLabel(view.rated),
      moveNumber: Math.floor(view.plyCount / 2) + 1,
      sideToMove: view.sideToMove === 'white' ? white : black,
    });
    return {
      text: `${title}\n${status}`,
      entities: [],
      reply_markup: keyboard([[{ text: t('button.open_game'), url: view.openLink }]]),
    };
  }

  if (view.endReason === 'abort' || view.endReason === 'timeout_abort') {
    const reason =
      view.endReason === 'timeout_abort' && view.timePerMove !== null
        ? t('card.aborted.no_move', { span: timeSpanLabel(view.timePerMove as TimePerMoveSeconds) })
        : view.abortedBy
          ? t('card.aborted.by_player', { name: view.abortedBy })
          : null;
    const lines = [t('card.aborted.title', { white, black })];
    if (reason) lines.push(reason);
    return { text: lines.join('\n'), entities: [], reply_markup: keyboard([[rematch]]) };
  }

  const title =
    view.rated && view.whiteRating && view.blackRating
      ? t('card.finished.title', {
          white,
          whiteBefore: view.whiteRating.before,
          whiteAfter: view.whiteRating.after ?? view.whiteRating.before,
          black,
          blackBefore: view.blackRating.before,
          blackAfter: view.blackRating.after ?? view.blackRating.before,
        })
      : t('card.finished.title_casual', { white, black });
  const status = t('card.finished.status', {
    endReason: view.endReason ? endReasonLabel(view.endReason) : '',
    result: view.result ? resultLabel(view.result) : '',
    moves: movesLabel(Math.ceil(view.plyCount / 2)),
    timePerMove: timePerMoveLabel(view.timePerMove),
  });
  const buttons = analyse ? [rematch, analyse] : [rematch];
  return { text: `${title}\n${status}`, entities: [], reply_markup: keyboard([buttons]) };
}

export function renderWelcomeCard(openChessLink: string): RenderedMessage {
  return {
    text: t('card.welcome'),
    entities: [],
    reply_markup: keyboard([[{ text: t('button.open_chess'), url: openChessLink }]]),
  };
}

export function renderShareCaption(view: {
  sharer: string;
  moveNumber: number;
  white: string;
  black: string;
  sideToMove: Colour;
}): string {
  return t('card.share.caption', {
    sharer: view.sharer,
    moveNumber: view.moveNumber,
    white: view.white,
    black: view.black,
    sideToMove: t(`colour.${view.sideToMove}`),
  });
}
