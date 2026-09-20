import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { jobs } from '../../src/db/schema';
import { enqueue } from '../../src/jobs/queue';
import { JobWorker } from '../../src/jobs/worker';
import type { JobHandlers } from '../../src/jobs/types';
import { createLogger } from '../../src/logger';
import { openTestDb, truncateAll } from '../helpers/db';

const { db, close } = openTestDb();
const log = createLogger('fatal');

beforeEach(() => truncateAll(db));
afterAll(() => close());

const worker = (handlers: JobHandlers) =>
  new JobWorker({ db, log, handlers, workerId: 'test-worker' });
const rows = () => db.select().from(jobs).orderBy(jobs.id);
const secondsFromNow = async (column: 'run_at' | 'locked_until' | 'done_at', id: number) => {
  const [row] = await db.execute(
    sql`select extract(epoch from (${sql.raw(column)} - now())) as seconds from jobs where id = ${id}`,
  );
  return Number(row?.seconds);
};

describe('enqueue', () => {
  it('inserts a pending job that is due now', async () => {
    await enqueue(db, { kind: 'prune', payload: { day: 1 } });
    const [job] = await rows();
    expect(job).toMatchObject({ kind: 'prune', payload: { day: 1 }, attempts: 0, maxAttempts: 8 });
    expect(job?.doneAt).toBeNull();
    expect(await secondsFromNow('run_at', job!.id)).toBeLessThanOrEqual(0);
  });

  it('collapses a re-enqueue on the same dedup key into one row and moves its run_at', async () => {
    await enqueue(db, { kind: 'edit_card', dedupKey: 'card:g:1', delaySeconds: 60 });
    await enqueue(db, { kind: 'edit_card', dedupKey: 'card:g:1' });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(await secondsFromNow('run_at', all[0]!.id)).toBeLessThanOrEqual(0);
  });

  it('allows a new pending job once the previous one with that key is done', async () => {
    await enqueue(db, { kind: 'edit_card', dedupKey: 'card:g:1' });
    await db.update(jobs).set({ doneAt: sql`now()` });
    await enqueue(db, { kind: 'edit_card', dedupKey: 'card:g:1' });
    expect(await rows()).toHaveLength(2);
  });
});

describe('JobWorker', () => {
  it('runs a due job with its payload and marks it done', async () => {
    await enqueue(db, { kind: 'prune', payload: { day: 7 } });
    const seen: unknown[] = [];
    const processed = await worker({
      prune: async ({ job }) => {
        seen.push(job.payload);
      },
    }).runOnce();
    expect(processed).toBe(1);
    expect(seen).toEqual([{ day: 7 }]);
    const [job] = await rows();
    expect(job?.doneAt).not.toBeNull();
    expect(job?.lockedUntil).toBeNull();
    expect(job?.failedAt).toBeNull();
  });

  it('leaves a job that is not yet due alone', async () => {
    await enqueue(db, { kind: 'prune', delaySeconds: 60 });
    expect(await worker({ prune: async () => undefined }).runOnce()).toBe(0);
  });

  it('reschedules with backoff after a thrown error and fails after max attempts', async () => {
    await enqueue(db, { kind: 'prune', maxAttempts: 2 });
    const failing = worker({
      prune: async () => {
        throw new Error('boom');
      },
    });
    await failing.runOnce();
    let [job] = await rows();
    expect(job).toMatchObject({ attempts: 1, lastError: 'boom', doneAt: null, failedAt: null });
    expect(await secondsFromNow('run_at', job!.id)).toBeGreaterThan(4);
    await db
      .update(jobs)
      .set({ runAt: sql`now()` })
      .where(eq(jobs.id, job!.id));
    await failing.runOnce();
    [job] = await rows();
    expect(job?.attempts).toBe(2);
    expect(job?.failedAt).not.toBeNull();
    expect(job?.doneAt).not.toBeNull();
  });

  it('honours a handler-requested retry without counting an attempt', async () => {
    await enqueue(db, { kind: 'lichess_import' });
    await worker({
      lichess_import: async () => ({ outcome: 'retry', delayMs: 30_000, error: 'rate limited' }),
    }).runOnce();
    const [job] = await rows();
    expect(job).toMatchObject({ attempts: 0, lastError: 'rate limited', doneAt: null });
    expect(await secondsFromNow('run_at', job!.id)).toBeGreaterThan(25);
  });

  it('fails a job of a kind with no handler', async () => {
    await enqueue(db, { kind: 'send_welcome' });
    await worker({}).runOnce();
    const [job] = await rows();
    expect(job?.failedAt).not.toBeNull();
    expect(job?.lastError).toMatch(/no handler/);
  });

  it('skips a job leased by another worker until the lease expires', async () => {
    await enqueue(db, { kind: 'prune' });
    await db
      .update(jobs)
      .set({ lockedUntil: sql`now() + interval '60 seconds'`, lockedBy: 'other' });
    const w = worker({ prune: async () => undefined });
    expect(await w.runOnce()).toBe(0);
    await db.update(jobs).set({ lockedUntil: sql`now() - interval '1 second'` });
    expect(await w.runOnce()).toBe(1);
  });

  it('runs a job again when it was re-enqueued while being processed', async () => {
    await enqueue(db, { kind: 'edit_card', dedupKey: 'card:g:1' });
    let calls = 0;
    const w = worker({
      edit_card: async () => {
        calls += 1;
        if (calls === 1) await enqueue(db, { kind: 'edit_card', dedupKey: 'card:g:1' });
      },
    });
    await w.runOnce();
    let [job] = await rows();
    expect(calls).toBe(1);
    expect(job?.doneAt).toBeNull();
    expect(job?.lockedUntil).toBeNull();
    await w.runOnce();
    [job] = await rows();
    expect(calls).toBe(2);
    expect(job?.doneAt).not.toBeNull();
  });
});
