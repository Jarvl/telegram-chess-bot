import { z } from 'zod';
import type { Deps } from '../../domain/deps';
import { awardFlairForGame } from '../../flair/award';
import type { JobHandler } from '../types';

const Payload = z.object({ gameId: z.number().int() });

/**
 * Flair spec §3.2: scores the players of a finished game. It runs outside the transaction that
 * ended the game, so a rule that throws fails only this job, never the game ending.
 */
export function awardFlairHandler(deps: Deps): JobHandler {
  return async ({ job }) => {
    const { gameId } = Payload.parse(job.payload);
    await deps.db.transaction((tx) => awardFlairForGame(tx, gameId));
  };
}
