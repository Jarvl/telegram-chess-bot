import type { MoveDto } from '@group-chess/shared';
import { describe, expect, it } from 'vitest';
import { diffNotices, GameStore, positionAt } from '../src/state/game';
import { afterPlies, gameDto } from './support/gameFixtures';

/** A minimal MoveDto for hand-crafted multi-ply fixtures; diffNotices only reads `.uci`. */
const move = (ply: number, uci: string): MoveDto => ({
  ply,
  uci,
  san: uci,
  fenAfter: '',
  playedAt: '2026-09-20T10:00:00.000Z',
});

describe('positionAt', () => {
  it('walks the move list with last move and check', () => {
    const game = afterPlies(4, { status: 'finished', result: '0-1', endReason: 'checkmate' });
    expect(positionAt(game, 0)).toMatchObject({ ply: 0, lastMove: null, check: false });
    expect(positionAt(game, 1)).toMatchObject({ ply: 1, lastMove: ['f2', 'f3'], check: false });
    expect(positionAt(game, 4)).toMatchObject({ ply: 4, lastMove: ['d8', 'h4'], check: true });
    expect(positionAt(game, 4).fen).toBe(game.fen);
  });
});

describe('GameStore', () => {
  it('lets only the player to move move, and only at the latest position', () => {
    const white = new GameStore(afterPlies(2, { viewerRole: 'white' }));
    expect(white.canMove.value).toBe(true);
    expect(white.dests.value.get('g1')).toEqual(['h3']); // f3 holds White's own pawn
    white.viewPly(1);
    expect(white.isLatest.value).toBe(false);
    expect(white.canMove.value).toBe(false);
    expect(white.dests.value.size).toBe(0);
    white.viewPly(null);
    expect(white.canMove.value).toBe(true);

    const waitingBlack = new GameStore(afterPlies(2, { viewerRole: 'black' }));
    expect(waitingBlack.premoveMode.value).toBe(true); // premoves spec: the waiting player premoves
    expect(waitingBlack.canMove.value).toBe(true);
    expect(new GameStore(afterPlies(2, { viewerRole: 'spectator' })).canMove.value).toBe(false);
    expect(
      new GameStore(
        afterPlies(4, {
          viewerRole: 'white',
          status: 'finished',
          result: '0-1',
          endReason: 'checkmate',
        }),
      ).canMove.value,
    ).toBe(false);
  });

  it('orients the board to the viewer and lets spectators flip', () => {
    expect(new GameStore(gameDto({ viewerRole: 'black' })).orientation.value).toBe('black');
    const spectator = new GameStore(gameDto({ viewerRole: 'spectator' }));
    expect(spectator.orientation.value).toBe('white');
    spectator.flip();
    expect(spectator.orientation.value).toBe('black');
  });

  it('applies newer states only and jumps to the latest position when the game moves on', () => {
    const store = new GameStore(afterPlies(1));
    store.viewPly(0);
    expect(store.apply(afterPlies(0))).toBe(false);
    expect(store.dto.value.plyCount).toBe(1);
    expect(store.apply(afterPlies(2))).toBe(true);
    expect(store.viewingPly.value).toBeNull();
    expect(store.position.value.ply).toBe(2);
  });

  it('keeps an earlier position on screen while the viewer is reading the game', () => {
    const store = new GameStore(afterPlies(3, { viewerRole: 'spectator' }));
    store.viewPly(1);
    store.apply(afterPlies(3, { version: 7, drawOffer: { by: 'white', atPly: 3 } }));
    expect(store.viewingPly.value).toBe(1);
  });
});

describe('diffNotices', () => {
  it('derives offers, declines, opponent moves and the end from consecutive states', () => {
    const base = afterPlies(2, { viewerRole: 'white' });
    expect(
      diffNotices(
        base,
        afterPlies(2, { viewerRole: 'white', version: 3, drawOffer: { by: 'black', atPly: 2 } }),
      ),
    ).toEqual(['draw_offered']);
    expect(
      diffNotices(
        afterPlies(2, { viewerRole: 'white', drawOffer: { by: 'white', atPly: 2 } }),
        afterPlies(2, { viewerRole: 'white', version: 3 }),
      ),
    ).toEqual(['draw_declined']);
    expect(
      diffNotices(afterPlies(1, { viewerRole: 'white' }), afterPlies(2, { viewerRole: 'white' })),
    ).toEqual(['opponent_moved']);
    expect(
      diffNotices(afterPlies(2, { viewerRole: 'white' }), afterPlies(3, { viewerRole: 'white' })),
    ).toEqual([]);
    expect(
      diffNotices(
        afterPlies(3, { viewerRole: 'black' }),
        afterPlies(4, {
          viewerRole: 'black',
          status: 'finished',
          result: '0-1',
          endReason: 'checkmate',
        }),
      ),
    ).toEqual(['finished']);
    expect(diffNotices(base, base)).toEqual([]);
  });
});

describe('GameStore premoves', () => {
  // After 1. f3 it is Black's move; White (the viewer) premoves.
  const waiting = (premoves: string[] = []) => afterPlies(1, { viewerRole: 'white', premoves });

  it('enters premove mode only for a player waiting on the latest position', () => {
    expect(new GameStore(waiting()).premoveMode.value).toBe(true);
    expect(new GameStore(afterPlies(2, { viewerRole: 'white' })).premoveMode.value).toBe(false);
    expect(new GameStore(afterPlies(1, { viewerRole: 'spectator' })).premoveMode.value).toBe(false);
    expect(
      new GameStore(afterPlies(1, { viewerRole: 'white', status: 'finished' })).premoveMode.value,
    ).toBe(false);
    const reading = new GameStore(afterPlies(3, { viewerRole: 'black' }));
    reading.viewPly(1);
    expect(reading.premoveMode.value).toBe(false);
    expect(reading.canMove.value).toBe(false);
  });

  it('offers pattern targets for the viewer’s pieces at the end of the chain', () => {
    const store = new GameStore(waiting());
    expect(store.canMove.value).toBe(true);
    expect(store.boardTurn.value).toBe('white');
    expect([...(store.dests.value.get('g1') ?? [])].sort()).toEqual(['e2', 'f3', 'h3']);
    expect(store.dests.value.has('e7')).toBe(false);
  });

  it('shows the imagined board and labels for each step, and targets only at the end', () => {
    const store = new GameStore(waiting(['g1h3', 'h3g5']));
    expect(store.shownStep.value).toBe(2);
    expect(store.atChainEnd.value).toBe(true);
    expect(store.premoveLabels.value).toEqual(['Nh3', 'Ng5']);
    expect(store.boardView.value.fen.split(' ')[0]).toBe(
      'rnbqkbnr/pppppppp/8/6N1/8/5P2/PPPPP1PP/RNBQKB1R',
    );
    expect(store.premoveSquares.value).toEqual(['h3', 'g5']);
    expect(store.viewPremove(1)).toBe(true);
    expect(store.premoveSquares.value).toEqual(['g1', 'h3']);
    expect(store.canMove.value).toBe(false);
    expect(store.dests.value.size).toBe(0);
    store.viewPremove(0);
    expect(store.boardView.value).toEqual(store.position.value);
    expect(store.premoveSquares.value).toEqual([]);
    expect(store.viewPremove(0)).toBe(false);
    expect(store.viewPremove(9)).toBe(true);
    expect(store.premoveStep.value).toBeNull();
  });

  it('applies a same-version state whose chain changed, and it replaces an optimistic chain', () => {
    const store = new GameStore(waiting());
    store.optimisticPremoves.value = ['g1h3'];
    expect(store.premoves.value).toEqual(['g1h3']);
    expect(store.apply(waiting(['b1c3']))).toBe(true);
    expect(store.premoves.value).toEqual(['b1c3']);
    expect(store.optimisticPremoves.value).toBeNull();
    expect(store.apply(waiting(['b1c3']))).toBe(false);
  });

  it('clamps the viewed step to the end when the chain shrinks, and resets it when the game moves on', () => {
    const store = new GameStore(waiting(['g1h3', 'h3g5']));
    store.premoveStep.value = 2;
    store.apply(waiting(['g1h3']));
    // The chain shrank to (at or below) the stored step, so the step itself clamps to the end —
    // not just the derived shownStep — otherwise a later append would jump back to it (fix round 1).
    expect(store.premoveStep.value).toBeNull();
    expect(store.shownStep.value).toBe(1);
    store.apply(waiting(['g1h3', 'b1c3']));
    expect(store.atChainEnd.value).toBe(true);
    store.apply(afterPlies(3, { viewerRole: 'white' }));
    expect(store.premoveStep.value).toBeNull();
  });

  it('stays out of premove mode while the player’s own move is still settling', () => {
    // The stream can show the opponent's turn before the POST /moves answers or while it retries.
    const store = new GameStore(waiting());
    store.moveBusy.value = true;
    expect(store.premoveMode.value).toBe(false);
    expect(store.canMove.value).toBe(false);
    expect(store.dests.value.size).toBe(0);
    store.moveBusy.value = false;
    expect(store.premoveMode.value).toBe(true);
  });

  it('locks the board while a premove edit is being sent', () => {
    const store = new GameStore(waiting());
    store.premoveSending.value = true;
    expect(store.canMove.value).toBe(false);
  });
});

describe('diffNotices premoves', () => {
  it('tells a played premove from a cancelled chain', () => {
    const before = afterPlies(1, { viewerRole: 'white', premoves: ['g2g4'] });
    expect(diffNotices(before, afterPlies(3, { viewerRole: 'white' }))).toEqual(['premove_played']);
    expect(diffNotices(before, afterPlies(2, { viewerRole: 'white' }))).toContain(
      'premoves_cancelled',
    );
    expect(
      diffNotices(afterPlies(1, { viewerRole: 'white' }), afterPlies(2, { viewerRole: 'white' })),
    ).not.toContain('premoves_cancelled');
  });

  it('also flags a played premove that left a trimmed leftover chain behind', () => {
    // The controller ruling: the first premove fired, but the server trimmed the rest of the
    // chain at its first pattern-invalid entry, so the owner needs to know it lost more than
    // just the one that played.
    const prev = afterPlies(1, { viewerRole: 'white', premoves: ['g2g4', 'a2a3', 'b2b3'] });
    expect(diffNotices(prev, afterPlies(3, { viewerRole: 'white', premoves: [] }))).toEqual([
      'premove_played',
      'premoves_cancelled',
    ]);
    expect(
      diffNotices(prev, afterPlies(3, { viewerRole: 'white', premoves: ['a2a3', 'b2b3'] })),
    ).toEqual(['premove_played']);
  });

  it('cancels a chain whose first premove never played', () => {
    // After ply 2 it is also White's move again, so 'opponent_moved' legitimately fires too.
    const before = afterPlies(1, { viewerRole: 'white', premoves: ['g2g4'] });
    expect(diffNotices(before, afterPlies(2, { viewerRole: 'white' }))).toEqual([
      'opponent_moved',
      'premoves_cancelled',
    ]);
  });

  // Fix round 1: a backgrounded app resumes and applyState diffs across several plies at once, so
  // more than one queued premove can have fired between `prev` and `next`. Black is to move after
  // an odd number of plies (5 here), so the fen keeps 'opponent_moved' from also firing for White.
  const BLACK_TO_MOVE_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1';

  it('counts every fired premove after a multi-ply jump, not just the first', () => {
    const prev = gameDto({
      viewerRole: 'white',
      plyCount: 1,
      version: 1,
      premoves: ['g2g4', 'b1c3'],
    });
    const bothFired = gameDto({
      viewerRole: 'white',
      plyCount: 5,
      version: 5,
      premoves: [],
      fen: BLACK_TO_MOVE_FEN,
      moves: [move(1, 'f2f3'), move(2, 'e7e5'), move(3, 'g2g4'), move(4, 'e5e4'), move(5, 'b1c3')],
    });
    expect(diffNotices(prev, bothFired)).toEqual(['premove_played']);
  });

  it('drops two fired premoves off a three-long chain without a spurious cancellation', () => {
    const prev = gameDto({
      viewerRole: 'white',
      plyCount: 1,
      version: 1,
      premoves: ['a2a3', 'b2b3', 'c2c3'],
    });
    const twoFired = gameDto({
      viewerRole: 'white',
      plyCount: 5,
      version: 5,
      premoves: ['c2c3'],
      fen: BLACK_TO_MOVE_FEN,
      moves: [move(1, 'f2f3'), move(2, 'e7e5'), move(3, 'a2a3'), move(4, 'e5e4'), move(5, 'b2b3')],
    });
    expect(diffNotices(prev, twoFired)).toEqual(['premove_played']);
  });
});
