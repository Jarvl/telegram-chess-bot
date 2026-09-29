import { z } from 'zod';
import type { Deps } from '../../domain/deps';
import { awardFlairForGame } from '../../flair/award';
import { canRunBackfill, runFlairBackfill } from '../../flair/backfill';
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

const BackfillPayload = z.object({
  flair: z.array(z.object({ id: z.string(), version: z.number().int() })),
});

/**
 * Backfill spec §4: backfills the payload's flair for every player. A job from a newer build, naming
 * flair or versions this one lacks, waits for a newer worker instead (§4.1).
 */
export function backfillFlairHandler(deps: Deps): JobHandler {
  return async ({ job, log }) => {
    const { flair } = BackfillPayload.parse(job.payload);
    if (!canRunBackfill(flair)) return { outcome: 'retry', delayMs: 30_000 };
    const summary = await runFlairBackfill(deps.db, flair);
    log.info({ ...summary }, 'flair backfill done');
  };
}
