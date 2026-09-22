import type { EngineLevel } from '@group-chess/shared';
import type { BestMove, Engine } from '../../src/engine/engine';

export type EngineCall = { fen: string; level: EngineLevel; deadlineMs: number };

export type FakeEngineOptions = {
  /** Replies in order; the last one repeats once the list runs out. */
  replies?: BestMove[];
  /** Thrown instead of replying, for the crash and timeout paths. */
  fail?: Error;
  available?: boolean;
};

export type FakeEngine = Engine & { calls: EngineCall[] };

export function fakeEngine(options: FakeEngineOptions = {}): FakeEngine {
  const replies = options.replies ?? [{ uci: 'e7e5' }];
  const calls: EngineCall[] = [];
  return {
    calls,
    async bestMove(fen, level, deadlineMs) {
      calls.push({ fen, level, deadlineMs });
      if (options.fail) throw options.fail;
      return replies[Math.min(calls.length - 1, replies.length - 1)]!;
    },
    async probe() {
      return { available: options.available ?? true, version: 'fake 1' };
    },
  };
}
