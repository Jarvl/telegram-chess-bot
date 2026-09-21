import { describe, expect, it } from 'vitest';
import { diffNotices, GameStore, positionAt } from '../src/state/game';
import { afterPlies, gameDto } from './support/gameFixtures';

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

    expect(new GameStore(afterPlies(2, { viewerRole: 'black' })).canMove.value).toBe(false);
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
