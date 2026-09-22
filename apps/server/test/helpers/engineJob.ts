import type { Db } from '../../src/db/client';
import type { JobRow } from '../../src/db/schema';
import type { Config } from '../../src/config';
import type { Deps } from '../../src/domain/deps';
import type { Engine } from '../../src/engine/engine';
import { engineJobHandlers } from '../../src/jobs/handlers/engine';
import type { Metrics } from '../../src/metrics';

export function buildJob(gameId: number, overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 1,
    kind: 'engine_move',
    dedupKey: null,
    payload: { gameId },
    runAt: new Date(),
    attempts: 0,
    maxAttempts: 8,
    lockedUntil: null,
    lockedBy: null,
    lastError: null,
    createdAt: new Date(),
    doneAt: null,
    failedAt: null,
    ...overrides,
  };
}

/**
 * Builds a `runEngineJob(engine, gameId, jobOverrides?, config?)` bound to one test file's
 * `deps`/`db`/`metrics`/default config, so callers keep the short call shape the integration
 * tests use while still being able to override the config per call (e.g. `ENGINE_ENABLED: false`).
 */
export function createEngineJobRunner(deps: Deps, db: Db, metrics: Metrics, defaultConfig: Config) {
  return function runEngineJob(
    engine: Engine,
    gameId: number,
    jobOverrides: Partial<JobRow> = {},
    config: Config = defaultConfig,
  ) {
    const handlers = engineJobHandlers({ deps, engine, config, metrics });
    const job = buildJob(gameId, jobOverrides);
    return handlers.engine_move!({ job, db, log: deps.log });
  };
}
