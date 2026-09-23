export type PendingMove = { uci: string; expectedPly: number; clientMoveId: string };

export type MoveState =
  | { kind: 'idle' }
  | { kind: 'sending'; move: PendingMove; attempt: number }
  | { kind: 'retry'; move: PendingMove; attempt: number; nextAt: number };

export type MoveEvent =
  | { type: 'drop'; uci: string; expectedPly: number; clientMoveId?: string }
  | { type: 'sent' }
  /** 409 or 422: reload the state and snap back without a message (spec §6.3). */
  | { type: 'rejected' }
  | { type: 'networkError'; now: number }
  | { type: 'retryNow' }
  | { type: 'tick'; now: number };

export type MoveEffect =
  | { type: 'send'; move: PendingMove }
  | { type: 'restore' }
  | { type: 'reload' }
  | { type: 'telemetryRetry' };

const RETRY_MAX_MS = 30_000;

/** 1 s, 2 s, 4 s … capped at 30 s (spec §6.3). */
export function retryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), RETRY_MAX_MS);
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Sixteen characters from `[a-z0-9]`, well inside the API's `^[A-Za-z0-9_-]{8,64}$`. */
export function newClientMoveId(random: () => number = Math.random): string {
  let id = '';
  for (let i = 0; i < 16; i += 1)
    id += ALPHABET[Math.floor(random() * ALPHABET.length) % ALPHABET.length];
  return id;
}

/** The move state machine of spec §6.3 as a pure reducer; the screen runs the effects. */
export function reduceMove(
  state: MoveState,
  event: MoveEvent,
): { state: MoveState; effects: MoveEffect[] } {
  const same = { state, effects: [] as MoveEffect[] };
  switch (state.kind) {
    case 'idle': {
      if (event.type !== 'drop') return same;
      const move: PendingMove = {
        uci: event.uci,
        expectedPly: event.expectedPly,
        clientMoveId: event.clientMoveId ?? newClientMoveId(),
      };
      return { state: { kind: 'sending', move, attempt: 1 }, effects: [{ type: 'send', move }] };
    }
    case 'sending': {
      if (event.type === 'sent') return { state: { kind: 'idle' }, effects: [] };
      if (event.type === 'rejected') {
        return { state: { kind: 'idle' }, effects: [{ type: 'restore' }, { type: 'reload' }] };
      }
      if (event.type === 'networkError') {
        return {
          state: {
            kind: 'retry',
            move: state.move,
            attempt: state.attempt,
            nextAt: event.now + retryDelayMs(state.attempt),
          },
          effects: state.attempt === 1 ? [{ type: 'telemetryRetry' }] : [],
        };
      }
      return same;
    }
    case 'retry': {
      const due = event.type === 'retryNow' || (event.type === 'tick' && event.now >= state.nextAt);
      if (!due) return same;
      return {
        state: { kind: 'sending', move: state.move, attempt: state.attempt + 1 },
        effects: [{ type: 'send', move: state.move }],
      };
    }
  }
}
