import { buildPgn, type TimePerMove } from '@group-chess/shared';
import type { DbOrTx } from '../db/client';
import type { GameRow } from '../db/schema';
import { listMoves } from './games';
import { requireGroup } from './groups';
import { displayName, requireUser } from './users';

/** Spec §7.6 headers and movetext from the moves table. */
export async function buildGamePgn(tx: DbOrTx, game: GameRow): Promise<string> {
  const [group, white, black, moves] = await Promise.all([
    requireGroup(tx, game.groupId),
    requireUser(tx, game.whiteId),
    requireUser(tx, game.blackId),
    listMoves(tx, game.id),
  ]);
  return buildPgn(
    {
      site: group.title,
      date: game.startedAt,
      white: displayName(white),
      black: displayName(black),
      result: game.result ?? '*',
      whiteElo: game.rated ? (game.whiteRatingBefore ?? null) : null,
      blackElo: game.rated ? (game.blackRatingBefore ?? null) : null,
      timePerMove: game.timePerMove as TimePerMove,
      endReason: game.endReason,
    },
    moves.map((move) => move.san),
  );
}
