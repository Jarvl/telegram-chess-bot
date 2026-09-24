import { checkPremoveChain, sideToMove, type GameDto } from '@group-chess/shared';
import { eq } from 'drizzle-orm';
import { games } from '../db/schema';
import type { Deps } from './deps';
import { DomainError } from './errors';
import { loadGameDto, lockActiveGame } from './games';

export type SetPremovesInput = {
  gameId: string;
  userId: number;
  /** The chain the device showed when the player made the edit. */
  base: string[];
  premoves: string[];
  expectedPly: number;
};

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Compare-and-set of the caller's premove chain (premoves spec, API and Several devices). Never
 * bumps the version; an edit is pushed to the owner's streams only, so nothing reaches the opponent.
 */
export async function setPremoves(deps: Deps, input: SetPremovesInput): Promise<GameDto> {
  const outcome: { publish: 'all' | 'owner' | null } = { publish: null };
  const dto = await deps.db.transaction(async (tx) => {
    const { game, colour, ended } = await lockActiveGame(tx, input.gameId, input.userId);
    if (ended) {
      outcome.publish = 'all';
      return loadGameDto(tx, game, input.userId);
    }
    if (sideToMove(game.fen) === colour) throw new DomainError('not_your_turn', 'it is your move');
    if (input.expectedPly !== game.plyCount) {
      throw new DomainError('stale_state', 'the position has changed', { plyCount: game.plyCount });
    }
    if (!sameList(game.premoves, input.base)) {
      throw new DomainError('stale_state', 'the premoves have changed', {
        reason: 'premoves_changed',
      });
    }
    const check = checkPremoveChain(game.fen, colour, input.premoves);
    if (!check.ok) throw new DomainError('illegal_move', 'illegal premove', { index: check.index });
    if (sameList(game.premoves, input.premoves)) return loadGameDto(tx, game, input.userId);
    const [updated] = await tx
      .update(games)
      .set({ premoves: input.premoves })
      .where(eq(games.id, game.id))
      .returning();
    if (!updated) throw new DomainError('not_found', 'game not found');
    outcome.publish = 'owner';
    return loadGameDto(tx, updated, input.userId);
  });
  if (outcome.publish === 'all') deps.bus.publish(input.gameId);
  if (outcome.publish === 'owner') deps.bus.publish(input.gameId, { userId: input.userId });
  return dto;
}
