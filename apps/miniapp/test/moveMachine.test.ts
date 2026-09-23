import { describe, expect, it } from 'vitest';
import {
  newClientMoveId,
  reduceMove,
  retryDelayMs,
  type MoveEvent,
  type MoveState,
} from '../src/state/moveMachine';

const drop: MoveEvent = { type: 'drop', uci: 'e2e4', expectedPly: 0, clientMoveId: 'm-0000000001' };
const run = (events: MoveEvent[], from: MoveState = { kind: 'idle' }) => {
  let state = from;
  const effects: string[] = [];
  for (const event of events) {
    const out = reduceMove(state, event);
    state = out.state;
    effects.push(...out.effects.map((effect) => effect.type));
  }
  return { state, effects };
};

describe('reduceMove', () => {
  it('sends a dropped move immediately', () => {
    const { state, effects } = run([drop]);
    expect(state).toEqual({
      kind: 'sending',
      move: { uci: 'e2e4', expectedPly: 0, clientMoveId: 'm-0000000001' },
      attempt: 1,
    });
    expect(effects).toEqual(['send']);
  });

  it('returns to idle and restores the position on a stale rejection', () => {
    const sending = run([drop]).state;
    const { state, effects } = run([{ type: 'rejected' }], sending);
    expect(state).toEqual({ kind: 'idle' });
    expect(effects).toEqual(['restore', 'reload']);
  });

  it('keeps the client move id and backs off across network retries', () => {
    const sending = run([drop]).state;
    const first = run([{ type: 'networkError', now: 1_000 }], sending);
    expect(first.state).toEqual({
      kind: 'retry',
      move: { uci: 'e2e4', expectedPly: 0, clientMoveId: 'm-0000000001' },
      attempt: 1,
      nextAt: 2_000,
    });
    expect(first.effects).toEqual(['telemetryRetry']);
    const early = run([{ type: 'tick', now: 1_999 }], first.state);
    expect(early.state.kind).toBe('retry');
    expect(early.effects).toEqual([]);
    const second = run([{ type: 'tick', now: 2_000 }], first.state);
    expect(second.state).toMatchObject({
      kind: 'sending',
      attempt: 2,
      move: { clientMoveId: 'm-0000000001' },
    });
    expect(second.effects).toEqual(['send']);
    const third = run([{ type: 'networkError', now: 5_000 }], second.state);
    expect(third.state).toMatchObject({ kind: 'retry', attempt: 2, nextAt: 7_000 });
    expect(third.effects).toEqual([]);
    const manual = run([{ type: 'retryNow' }], third.state);
    expect(manual.state).toMatchObject({ kind: 'sending', attempt: 3 });
    expect(manual.effects).toEqual(['send']);
  });

  it('caps the retry delay at thirty seconds', () => {
    expect(retryDelayMs(1)).toBe(1_000);
    expect(retryDelayMs(2)).toBe(2_000);
    expect(retryDelayMs(5)).toBe(16_000);
    expect(retryDelayMs(6)).toBe(30_000);
    expect(retryDelayMs(20)).toBe(30_000);
  });

  it('ignores a drop while a move is in flight and a stray answer while idle', () => {
    const sending = run([drop]).state;
    const ignored = run([{ ...drop, uci: 'd2d4' }], sending);
    expect(ignored.state).toBe(sending);
    expect(ignored.effects).toEqual([]);
    expect(run([{ type: 'sent' }]).state).toEqual({ kind: 'idle' });
  });

  it('makes client move ids that satisfy the API pattern', () => {
    const id = newClientMoveId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(newClientMoveId()).not.toBe(id);
    expect(newClientMoveId(() => 0)).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(newClientMoveId(() => 1)).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });
});
