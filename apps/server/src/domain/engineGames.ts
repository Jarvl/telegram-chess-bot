import {
  ENGINE_LEVELS,
  INITIAL_FEN,
  type ColourChoice,
  type EngineLevel,
  type TimePerMove,
} from '@group-chess/shared';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { games, users, type GameRow, type UserRow } from '../db/schema';
import { enqueue } from '../jobs/queue';
import { randomColour } from './challenges';
import type { Deps } from './deps';
import { DomainError } from './errors';
import { requireGroup, settingsOf } from './groups';
import {
  MAX_GAMES_PER_PAIR,
  countActiveGames,
  countActiveGamesBetween,
  deadlineExpression,
  reminderExpression,
} from './limits';
import { isBlocked } from './members';
import { generatePublicId } from '../db/ids';
import { requireUser, wantsDms } from './users';

/** The single engine user, created by migration 0002 (spec §5). */
export async function getEngineUser(tx: DbOrTx): Promise<UserRow> {
  const [row] = await tx.select().from(users).where(eq(users.isEngine, true)).limit(1);
  if (!row) throw new Error('the engine user is missing; migration 0002 did not run');
  return row;
}

export function isEngineGame(game: Pick<GameRow, 'engineLevel'>): boolean {
  return game.engineLevel !== null;
}

export type CreateEngineGameInput = {
  groupId: number;
  userId: number;
  level: EngineLevel;
  colour: ColourChoice;
  timePerMove: TimePerMove;
};

/** Spec §6.1. No challenge, no card, no expiry: there is nothing to accept. */
export async function createEngineGame(
  deps: Deps,
  input: CreateEngineGameInput,
): Promise<GameRow> {
  if (!ENGINE_LEVELS.includes(input.level)) {
    throw new DomainError('validation', 'unknown engine level', {
      reason: 'invalid_level',
      level: input.level,
    });
  }
  const result = await deps.db.transaction(async (tx) => {
    const group = await requireGroup(tx, input.groupId);
    const settings = settingsOf(group);
    const player = await requireUser(tx, input.userId);
    const engine = await getEngineUser(tx);
    if (await isBlocked(tx, group.id, player.id)) {
      throw new DomainError('forbidden', 'blocked in this group', { reason: 'blocked' });
    }
    const active = await countActiveGames(tx, group.id, player.id);
    if (active >= settings.maxActiveGamesPerUser) {
      throw new DomainError('limit_exceeded', 'active games limit reached', {
        reason: 'active_limit',
        userId: player.id,
        name: player.firstName,
        count: active,
      });
    }
    // The engine's own active-game count is exempt — it plays everyone at once — but the pair limit
    // still caps concurrent engine games per user (spec §6.1).
    const pair = await countActiveGamesBetween(tx, group.id, player.id, engine.id);
    if (pair >= MAX_GAMES_PER_PAIR) {
      throw new DomainError('limit_exceeded', 'too many games against the bot', {
        reason: 'pair_limit',
        name: engine.firstName,
        count: pair,
      });
    }
    const playerColour = input.colour === 'random' ? randomColour() : input.colour;
    const white = playerColour === 'white' ? player : engine;
    const black = playerColour === 'white' ? engine : player;
    const engineToMove = white.isEngine;
    const [game] = await tx
      .insert(games)
      .values({
        publicId: generatePublicId(),
        groupId: group.id,
        whiteId: white.id,
        blackId: black.id,
        timePerMove: input.timePerMove,
        rated: false,
        engineLevel: input.level,
        fen: INITIAL_FEN,
        // Spec §9: the engine never carries a deadline, so it can never be forfeited.
        deadlineAt: engineToMove ? null : deadlineExpression(input.timePerMove),
        reminderAt: engineToMove
          ? null
          : reminderExpression(input.timePerMove, wantsDms(player)),
      })
      .returning();
    if (!game) throw new Error('engine game insert returned no row');
    if (engineToMove) await enqueueEngineMove(tx, game);
    return game;
  });
  deps.bus.publish(result.publicId);
  return result;
}

export function enqueueEngineMove(
  tx: DbOrTx,
  game: Pick<GameRow, 'id' | 'publicId' | 'plyCount'>,
): Promise<void> {
  return enqueue(tx, {
    kind: 'engine_move',
    payload: { gameId: game.id },
    dedupKey: `engine:g:${game.publicId}:ply:${game.plyCount}`,
  });
}
