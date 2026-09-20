import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { jobs } from '../db/schema';
import type { JobKind, JobPayload } from './types';

export type EnqueueInput = {
  kind: JobKind;
  payload?: JobPayload;
  /** A pending job with the same key is moved to the new run_at instead of duplicated (spec §10). */
  dedupKey?: string;
  delaySeconds?: number;
  maxAttempts?: number;
};

export async function enqueue(tx: DbOrTx, input: EnqueueInput): Promise<void> {
  const runAt = input.delaySeconds
    ? sql`now() + make_interval(secs => ${input.delaySeconds})`
    : sql`now()`;
  const values = {
    kind: input.kind,
    payload: input.payload ?? {},
    dedupKey: input.dedupKey ?? null,
    runAt,
    maxAttempts: input.maxAttempts ?? 8,
  };
  if (!input.dedupKey) {
    await tx.insert(jobs).values(values);
    return;
  }
  await tx
    .insert(jobs)
    .values(values)
    .onConflictDoUpdate({
      target: jobs.dedupKey,
      targetWhere: sql`done_at is null`,
      set: { runAt: sql`excluded.run_at` },
    });
}
