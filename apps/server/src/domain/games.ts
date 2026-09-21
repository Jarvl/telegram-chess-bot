import {
  applyMove,
  sideToMove,
  timeoutOutcome,
  type EndReason,
  type GameDto,
  type GameResult,
  type TimePerMove,
} from '@group-chess/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { dbNow, type DbOrTx } from '../db/client';
import { adminActions, games, groups, moves, type GameRow, type MoveRow } from '../db/schema';
import { enqueue } from '../jobs/queue';
import type { Deps } from './deps';
import { DomainError } from './errors';
import { buildGameDto, colourOf, positionKeys } from './gameDto';
import { deadlineExpression, reminderExpression } from './limits';
import { applyGameResultToRatings, getPlayerRating } from './ratings';
import { requireUser } from './users';

export type EndInput = { result: GameResult; endReason: EndReason };

export async function requireGameByPublicId(
  tx: DbOrTx,
  publicId: string,
  options: { forUpdate?: boolean } = {},
): Promise<GameRow> {
  const query = tx.select().from(games).where(eq(games.publicId, publicId)).limit(1);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  if (!row) throw new DomainError('not_found', 'game not found');
  return row;
}

export async function requireGameById(
  tx: DbOrTx,
  id: number,
  options: { forUpdate?: boolean } = {},
): Promise<GameRow> {
  const query = tx.select().from(games).where(eq(games.id, id)).limit(1);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  if (!row) throw new DomainError('not_found', 'game not found');
  return row;
}

export async function listMoves(tx: DbOrTx, gameId: number): Promise<MoveRow[]> {
  return tx.select().from(moves).where(eq(moves.gameId, gameId)).orderBy(asc(moves.ply));
}

export async function loadGameDto(
  tx: DbOrTx,
  game: GameRow,
  viewerUserId: number | null,
): Promise<GameDto> {
  const [group] = await tx
    .select({ publicId: groups.publicId, title: groups.title })
    .from(groups)
    .where(eq(groups.id, game.groupId))
    .limit(1);
  if (!group) throw new DomainError('not_found', 'group not found');
  const [moveRows, white, black, whiteRating, blackRating, now] = await Promise.all([
    listMoves(tx, game.id),
    requireUser(tx, game.whiteId),
    requireUser(tx, game.blackId),
    getPlayerRating(tx, game.groupId, game.whiteId),
    getPlayerRating(tx, game.groupId, game.blackId),
    dbNow(tx),
  ]);
  return buildGameDto({
    game,
    moves: moveRows,
    group,
    white,
    black,
    whiteRating,
    blackRating,
    viewerUserId,
    now,
  });
}

export async function getGameDto(
  deps: Deps,
  input: { gameId: string; viewerUserId: number | null },
): Promise<GameDto> {
  const game = await requireGameByPublicId(deps.db, input.gameId);
  return loadGameDto(deps.db, game, input.viewerUserId);
}

/** Ends a game inside `tx`: status and result, ratings and snapshots, then the card, DM and import jobs. */
export async function finishGame(
  tx: DbOrTx,
  game: GameRow,
  end: EndInput,
  now: Date,
): Promise<GameRow> {
  // A voided game is not worth an import; the fallback analysis link still works (review finding 10).
  const importable = game.plyCount > 0 && end.endReason !== 'voided';
  const [updated] = await tx
    .update(games)
    .set({
      status: 'finished',
      result: end.result,
      endReason: end.endReason,
      finishedAt: now,
      deadlineAt: null,
      reminderAt: null,
      drawOfferBy: null,
      drawOfferPly: null,
      lichessImportStatus: importable ? 'pending' : null,
      version: sql`${games.version} + 1`,
    })
    .where(eq(games.id, game.id))
    .returning();
  if (!updated) throw new DomainError('not_found', 'game not found');
  await applyGameResultToRatings(tx, updated, now);
  await enqueue(tx, {
    kind: 'edit_card',
    payload: { gameId: game.id },
    dedupKey: `card:g:${game.publicId}`,
  });
  for (const userId of [game.whiteId, game.blackId]) {
    await enqueue(tx, {
      kind: 'send_dm',
      payload: { userId, template: 'game_end', gameId: game.id },
      dedupKey: `dm:${userId}:g:${game.publicId}:end`,
    });
  }
  if (importable) {
    await enqueue(tx, {
      kind: 'lichess_import',
      payload: { gameId: game.id },
      dedupKey: `lichess:${game.publicId}`,
    });
  }
  return requireGameById(tx, game.id);
}

/** Spec §7.1: `timeout_abort` when the player to move never moved, otherwise a loss on time (FIDE 6.9). */
export function timeoutEnd(game: Pick<GameRow, 'fen' | 'plyCount'>): EndInput {
  const flagged = sideToMove(game.fen);
  const neverMoved =
    (flagged === 'white' && game.plyCount === 0) || (flagged === 'black' && game.plyCount === 1);
  if (neverMoved) return { result: '*', endReason: 'timeout_abort' };
  return timeoutOutcome(game.fen, flagged);
}

export async function applyTimeout(tx: DbOrTx, game: GameRow, now: Date): Promise<GameRow> {
  return finishGame(tx, game, timeoutEnd(game), now);
}

export type LockedGame = {
  game: GameRow;
  colour: 'white' | 'black';
  /** The database clock; constant for the rest of the transaction. */
  now: Date;
  /** True when the deadline had already passed: `game` is then the finished row and the action must not proceed. */
  ended: boolean;
};

/**
 * Locks an active game for one of its players. A deadline that passed before this transaction is
 * applied right here, so no action (move, resign, abort, draw offer, acceptance or claim) can beat
 * the forfeit scanner (spec §7.3, §7.4).
 */
export async function lockActiveGame(
  tx: DbOrTx,
  publicId: string,
  userId: number,
): Promise<LockedGame> {
  const game = await requireGameByPublicId(tx, publicId, { forUpdate: true });
  const colour = colourOf(game, userId);
  if (!colour) throw new DomainError('forbidden', 'only the players can do that');
  if (game.status !== 'active') throw new DomainError('stale_state', 'the game is over');
  const now = await dbNow(tx);
  if (game.deadlineAt && game.deadlineAt.getTime() < now.getTime()) {
    return { game: await applyTimeout(tx, game, now), colour, now, ended: true };
  }
  return { game, colour, now, ended: false };
}

export type PlayMoveInput = {
  gameId: string;
  userId: number;
  uci: string;
  expectedPly: number;
  clientMoveId: string;
};

/** The move transaction of spec §7.4, step for step. */
export async function playMove(deps: Deps, input: PlayMoveInput): Promise<GameDto> {
  const dto = await deps.db.transaction(async (tx) => {
    const { game, colour, now, ended } = await lockActiveGame(tx, input.gameId, input.userId);
    if (ended) return loadGameDto(tx, game, input.userId);
    // A retried request must return the current state even though it is now the opponent's turn,
    // and a stale client learns that before it learns whose turn it is.
    const history = await listMoves(tx, game.id);
    if (history.some((move) => move.clientMoveId === input.clientMoveId)) {
      return loadGameDto(tx, game, input.userId);
    }
    if (input.expectedPly !== game.plyCount) {
      throw new DomainError('stale_state', 'the position has changed', { plyCount: game.plyCount });
    }
    if (sideToMove(game.fen) !== colour) throw new DomainError('not_your_turn', 'not your turn');
    const result = applyMove(game.fen, positionKeys(history), input.uci);
    if (!result.legal) throw new DomainError('illegal_move', 'illegal move');

    const ply = game.plyCount + 1;
    await tx.insert(moves).values({
      gameId: game.id,
      ply,
      uci: result.uci,
      san: result.san,
      fenAfter: result.fenAfter,
      playedAt: now,
      clientMoveId: input.clientMoveId,
    });
    const opponentId = colour === 'white' ? game.blackId : game.whiteId;
    const opponent = await requireUser(tx, opponentId);
    const timePerMove = game.timePerMove as TimePerMove;
    const offerLapses = game.drawOfferBy !== null && game.drawOfferBy !== colour;
    const [moved] = await tx
      .update(games)
      .set({
        fen: result.fenAfter,
        plyCount: ply,
        version: sql`${games.version} + 1`,
        lastMoveAt: now,
        deadlineAt: deadlineExpression(timePerMove),
        reminderAt: reminderExpression(timePerMove, opponent.dmAllowed),
        ...(offerLapses ? { drawOfferBy: null, drawOfferPly: null } : {}),
      })
      .where(eq(games.id, game.id))
      .returning();
    if (!moved) throw new DomainError('not_found', 'game not found');

    if (result.outcome.kind !== 'continue') {
      const end: EndInput =
        result.outcome.kind === 'checkmate'
          ? { result: result.outcome.winner === 'white' ? '1-0' : '0-1', endReason: 'checkmate' }
          : { result: '1/2-1/2', endReason: result.outcome.reason };
      return loadGameDto(tx, await finishGame(tx, moved, end, now), input.userId);
    }
    await enqueue(tx, {
      kind: 'edit_card',
      payload: { gameId: game.id },
      dedupKey: `card:g:${game.publicId}`,
    });
    await enqueue(tx, {
      kind: 'send_dm',
      payload: { userId: opponentId, template: 'turn', gameId: game.id },
      dedupKey: `dm:${opponentId}:g:${game.publicId}:turn:${ply}`,
    });
    return loadGameDto(tx, moved, input.userId);
  });
  deps.bus.publish(input.gameId);
  return dto;
}

export async function resign(
  deps: Deps,
  input: { gameId: string; userId: number },
): Promise<GameDto> {
  const dto = await deps.db.transaction(async (tx) => {
    const { game, colour, now, ended } = await lockActiveGame(tx, input.gameId, input.userId);
    if (ended) return loadGameDto(tx, game, input.userId);
    const end: EndInput = { result: colour === 'white' ? '0-1' : '1-0', endReason: 'resignation' };
    return loadGameDto(tx, await finishGame(tx, game, end, now), input.userId);
  });
  deps.bus.publish(input.gameId);
  return dto;
}

/** PRD §7.3: abort is available before both players have moved; no rating change. */
export async function abortGame(
  deps: Deps,
  input: { gameId: string; userId: number },
): Promise<GameDto> {
  const dto = await deps.db.transaction(async (tx) => {
    const { game, now, ended } = await lockActiveGame(tx, input.gameId, input.userId);
    if (ended) return loadGameDto(tx, game, input.userId);
    if (game.plyCount >= 2)
      throw new DomainError('forbidden', 'abort is no longer available', {
        reason: 'abort_unavailable',
      });
    return loadGameDto(
      tx,
      await finishGame(tx, game, { result: '*', endReason: 'abort' }, now),
      input.userId,
    );
  });
  deps.bus.publish(input.gameId);
  return dto;
}

/** Spec §7.1/§7.5 void: caller has verified admin rights; ratings are rebuilt by the `rebuild_ratings` job. */
export async function voidGame(
  deps: Deps,
  input: { gameId: string; adminUserId: number },
): Promise<GameDto> {
  const dto = await deps.db.transaction(async (tx) => {
    let game = await requireGameByPublicId(tx, input.gameId, { forUpdate: true });
    const now = await dbNow(tx);
    if (game.voidedAt) throw new DomainError('stale_state', 'already voided');
    if (game.status === 'active') {
      game = await finishGame(tx, game, { result: '*', endReason: 'voided' }, now);
    }
    const [voided] = await tx
      .update(games)
      .set({ voidedAt: now, voidedBy: input.adminUserId, version: sql`${games.version} + 1` })
      .where(eq(games.id, game.id))
      .returning();
    if (!voided) throw new DomainError('not_found', 'game not found');
    const [group] = await tx
      .select({ publicId: groups.publicId })
      .from(groups)
      .where(eq(groups.id, game.groupId));
    if (voided.rated) {
      await enqueue(tx, {
        kind: 'rebuild_ratings',
        payload: { groupId: game.groupId },
        dedupKey: `ratings:${group?.publicId}`,
      });
    }
    await enqueue(tx, {
      kind: 'edit_card',
      payload: { gameId: game.id },
      dedupKey: `card:g:${game.publicId}`,
    });
    await tx.insert(adminActions).values({
      groupId: game.groupId,
      adminUserId: input.adminUserId,
      action: 'void',
      targetGameId: game.id,
      details: { previousResult: game.result, previousEndReason: game.endReason },
    });
    return loadGameDto(tx, voided, input.adminUserId);
  });
  deps.bus.publish(input.gameId);
  return dto;
}
