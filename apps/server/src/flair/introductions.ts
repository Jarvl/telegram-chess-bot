import { FLAIR } from '@group-chess/shared';
import type { DbOrTx } from '../db/client';
import { flairIntroductions } from '../db/schema';

/**
 * Flair spec §3.1: records every catalog id as introduced now. An id already recorded keeps its
 * first date, so an id's introduction is the first boot that knew it.
 */
export async function recordFlairIntroductions(db: DbOrTx): Promise<void> {
  await db
    .insert(flairIntroductions)
    .values(FLAIR.map((flair) => ({ flairId: flair.id })))
    .onConflictDoNothing();
}

/**
 * When each flair id was introduced (spec §1.5), for every id recorded, including any that has
 * since left the catalog.
 */
export async function loadIntroductions(tx: DbOrTx): Promise<ReadonlyMap<string, Date>> {
  const rows = await tx.select().from(flairIntroductions);
  return new Map(rows.map((row) => [row.flairId, row.introducedAt]));
}
