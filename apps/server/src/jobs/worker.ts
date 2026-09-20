import { and, eq, getTableColumns, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { jobs, type JobRow } from '../db/schema';
import type { Logger } from '../logger';
import type { JobHandlers, JobKind, JobResult } from './types';

export type WorkerOptions = {
  db: Db;
  log: Logger;
  handlers: JobHandlers;
  workerId?: string;
  batchSize?: number;
  leaseSeconds?: number;
  pollMs?: number;
};

type LeasedJob = JobRow & { runAtText: string };

type Outcome = JobResult | { outcome: 'error'; error: string };

/** Spec §10: `min(5 s · 2^attempts, 1 h)` where `attempts` counts failures so far. */
export function backoffSeconds(attempts: number): number {
  return Math.min(5 * 2 ** attempts, 3600);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class JobWorker {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly options: WorkerOptions) {}

  /** One poll: lease due jobs and run them in order. Returns how many were processed. */
  async runOnce(): Promise<number> {
    const leased = await this.lease();
    for (const job of leased) await this.process(job);
    return leased.length;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    const tick = async (): Promise<void> => {
      this.inFlight = this.runOnce()
        .then(() => undefined)
        .catch((error: unknown) => {
          this.options.log.error({ err: error }, 'job worker poll failed');
        });
      await this.inFlight;
      if (!this.stopped) this.timer = setTimeout(() => void tick(), this.options.pollMs ?? 1000);
    };
    this.timer = setTimeout(() => void tick(), 0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.inFlight) await this.inFlight;
  }

  private async lease(): Promise<LeasedJob[]> {
    const { db, batchSize = 20, leaseSeconds = 60, workerId = 'worker' } = this.options;
    return db.transaction(async (tx) => {
      const due = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            isNull(jobs.doneAt),
            lte(jobs.runAt, sql`now()`),
            or(isNull(jobs.lockedUntil), sql`${jobs.lockedUntil} < now()`),
          ),
        )
        .orderBy(jobs.runAt)
        .limit(batchSize)
        .for('update', { skipLocked: true });
      if (due.length === 0) return [];
      return tx
        .update(jobs)
        .set({
          lockedUntil: sql`now() + make_interval(secs => ${leaseSeconds})`,
          lockedBy: workerId,
        })
        .where(
          inArray(
            jobs.id,
            due.map((row) => row.id),
          ),
        )
        .returning({ ...getTableColumns(jobs), runAtText: sql<string>`${jobs.runAt}::text` });
    });
  }

  private async process(job: LeasedJob): Promise<void> {
    const { db, log, handlers } = this.options;
    const handler = handlers[job.kind as JobKind];
    let outcome: Outcome;
    if (!handler) {
      outcome = { outcome: 'fail', error: `no handler for kind ${job.kind}` };
    } else {
      try {
        outcome = (await handler({ job, db, log })) ?? { outcome: 'done' };
      } catch (error) {
        outcome = { outcome: 'error', error: errorMessage(error) };
      }
    }
    const unlock = { lockedUntil: null, lockedBy: null };
    switch (outcome.outcome) {
      case 'done': {
        // Only mark done if nobody moved run_at while we were working; otherwise it runs again.
        const updated = await db
          .update(jobs)
          .set({ doneAt: sql`now()`, ...unlock })
          .where(and(eq(jobs.id, job.id), sql`${jobs.runAt}::text = ${job.runAtText}`))
          .returning({ id: jobs.id });
        if (updated.length === 0) {
          await db.update(jobs).set(unlock).where(eq(jobs.id, job.id));
          log.debug(
            { jobId: job.id, kind: job.kind },
            'job re-enqueued while running; will run again',
          );
        }
        return;
      }
      case 'retry':
        await db
          .update(jobs)
          .set({
            runAt: sql`now() + make_interval(secs => ${outcome.delayMs / 1000})`,
            lastError: outcome.error ?? null,
            ...unlock,
          })
          .where(eq(jobs.id, job.id));
        return;
      case 'fail':
        await db
          .update(jobs)
          .set({ failedAt: sql`now()`, doneAt: sql`now()`, lastError: outcome.error, ...unlock })
          .where(eq(jobs.id, job.id));
        log.error({ jobId: job.id, kind: job.kind, error: outcome.error }, 'job failed');
        return;
      case 'error': {
        const attempts = job.attempts + 1;
        if (attempts >= job.maxAttempts) {
          await db
            .update(jobs)
            .set({
              attempts,
              failedAt: sql`now()`,
              doneAt: sql`now()`,
              lastError: outcome.error,
              ...unlock,
            })
            .where(eq(jobs.id, job.id));
          log.error(
            { jobId: job.id, kind: job.kind, error: outcome.error, attempts },
            'job exhausted',
          );
        } else {
          await db
            .update(jobs)
            .set({
              attempts,
              runAt: sql`now() + make_interval(secs => ${backoffSeconds(job.attempts)})`,
              lastError: outcome.error,
              ...unlock,
            })
            .where(eq(jobs.id, job.id));
          log.warn(
            { jobId: job.id, kind: job.kind, error: outcome.error, attempts },
            'job failed; retrying',
          );
        }
      }
    }
  }
}
