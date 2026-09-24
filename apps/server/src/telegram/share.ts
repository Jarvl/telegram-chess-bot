import {
  INITIAL_FEN,
  sideToMove,
  t,
  type Colour,
  type PreparedShareDto,
} from '@group-chess/shared';
import { Chess } from 'chess.js';
import type { InlineKeyboardMarkup } from 'grammy/types';
import type { Config } from '../config';
import type { DbOrTx } from '../db/client';
import type { GameRow, MoveRow, UserRow } from '../db/schema';
import { DomainError } from '../domain/errors';
import { listMoves } from '../domain/games';
import { displayName, requireUser } from '../domain/users';
import { IMAGE_SIZE, type BoardRenderInput } from '../images/board';
import { boardImagePath } from '../images/signedUrl';
import { renderShareCaption } from './cards';
import type { TelegramApi } from './client';
import { miniAppLink } from './links';

/** The position after `ply` (0 = the initial position) and the move that produced it. */
export function positionAtPly(
  moves: Pick<MoveRow, 'ply' | 'uci' | 'fenAfter'>[],
  ply: number,
): { fen: string; lastMove: string | null } {
  if (ply === 0) return { fen: INITIAL_FEN, lastMove: null };
  const move = moves.find((row) => row.ply === ply);
  if (!move) throw new Error(`no move at ply ${ply}`);
  return { fen: move.fenAfter, lastMove: move.uci };
}

export type ShareView = {
  board: BoardRenderInput;
  caption: string;
  replyMarkup: InlineKeyboardMarkup;
};

/** Spec §7.7: what a shared position shows, whether the bot posts it or the sharer sends it. */
export async function loadShareView(
  tx: DbOrTx,
  config: Pick<Config, 'BOT_USERNAME' | 'MINI_APP_SHORT_NAME'>,
  game: GameRow,
  sharerId: number,
  ply: number,
): Promise<ShareView> {
  const [sharer, white, black, moves] = await Promise.all([
    requireUser(tx, sharerId),
    requireUser(tx, game.whiteId),
    requireUser(tx, game.blackId),
    listMoves(tx, game.id),
  ]);
  const position = positionAtPly(moves, ply);
  const orientation: Colour = sharerId === game.blackId ? 'black' : 'white';
  return {
    board: { ...position, check: new Chess(position.fen).inCheck(), orientation },
    caption: renderShareCaption({
      sharer: displayName(sharer),
      moveNumber: Math.max(1, Math.ceil(ply / 2)),
      white: displayName(white),
      black: displayName(black),
      sideToMove: sideToMove(position.fen),
    }),
    replyMarkup: {
      inline_keyboard: [
        [
          {
            text: t('button.open_game'),
            url: miniAppLink(config, { kind: 'game', gameId: game.publicId }),
          },
        ],
      ],
    },
  };
}

/**
 * Bot API 8.0: stores the shared position as a message the sharer sends from Telegram's share
 * sheet (`WebApp.shareMessage`), to any chat they pick. Nothing is posted until they do.
 */
export async function prepareShare(
  ctx: {
    db: DbOrTx;
    config: Pick<Config, 'BOT_USERNAME' | 'MINI_APP_SHORT_NAME' | 'PUBLIC_URL' | 'SESSION_SECRET'>;
    telegram: TelegramApi;
  },
  game: GameRow,
  user: UserRow,
  ply: number,
): Promise<PreparedShareDto> {
  if (ply > game.plyCount)
    throw new DomainError('validation', 'ply is beyond the game', { plyCount: game.plyCount });
  if (user.telegramUserId === null) throw new DomainError('forbidden', 'not a Telegram user');
  const view = await loadShareView(ctx.db, ctx.config, game, user.id, ply);
  const image = `${ctx.config.PUBLIC_URL.replace(/\/$/, '')}${boardImagePath(
    ctx.config.SESSION_SECRET,
    view.board,
  )}`;
  const prepared = await ctx.telegram.savePreparedInlineMessage(
    user.telegramUserId,
    {
      type: 'photo',
      id: `${game.publicId}-${ply}`,
      photo_url: `${image}/board.jpg`,
      thumbnail_url: `${image}/thumb.jpg`,
      photo_width: IMAGE_SIZE,
      photo_height: IMAGE_SIZE,
      caption: view.caption,
      reply_markup: view.replyMarkup,
    },
    { allow_user_chats: true, allow_group_chats: true, allow_channel_chats: true },
  );
  return { preparedMessageId: prepared.id };
}
