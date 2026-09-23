import { describe, expect, it } from 'vitest';
import { boardConfig } from '../src/board/adapter';
import { isPromotion, promotionOverlayStyle, promotionPieces } from '../src/board/promotion';
import { resultForViewer, ratingChangeFor } from '../src/ui/game/result';
import { AFTER_E4, afterPlies, gameDto } from './support/gameFixtures';

describe('boardConfig', () => {
  it('maps a position and the movable set onto chessground options', () => {
    const dests = new Map([['e2', ['e3', 'e4']]]);
    const config = boardConfig(
      {
        fen: AFTER_E4,
        lastMove: ['e2', 'e4'],
        check: false,
        orientation: 'black',
        turnColour: 'black',
      },
      { colour: 'black', dests },
      false,
      () => undefined,
    );
    expect(config).toMatchObject({
      fen: AFTER_E4,
      orientation: 'black',
      turnColor: 'black',
      lastMove: ['e2', 'e4'],
      check: false,
      viewOnly: false,
      coordinates: true,
      movable: { free: false, color: 'black', showDests: true },
      premovable: { enabled: false },
      drawable: { enabled: false },
      selectable: { enabled: true },
      blockTouchScroll: true,
    });
    expect(config.movable?.dests?.get('e2')).toEqual(['e3', 'e4']);
  });

  it('lifts nothing for spectators and out of turn', () => {
    const config = boardConfig(
      { fen: AFTER_E4, lastMove: null, check: true, orientation: 'white', turnColour: 'black' },
      { colour: 'none', dests: new Map() },
      true,
      () => undefined,
    );
    expect(config.movable?.color).toBeUndefined();
    expect(config.viewOnly).toBe(true);
    expect(config.check).toBe(true);
  });
});

describe('promotion', () => {
  const WHITE_PAWN_E7 = '4k3/4P3/8/8/8/8/8/4K3 w - - 0 1';
  const BLACK_PAWN_D2 = '4k3/8/8/8/8/8/3p4/4K3 b - - 0 1';

  it('recognises a pawn reaching the last rank for either colour', () => {
    expect(isPromotion(WHITE_PAWN_E7, 'e7', 'e8')).toBe(true);
    expect(isPromotion(BLACK_PAWN_D2, 'd2', 'd1')).toBe(true);
    expect(isPromotion(AFTER_E4, 'e2', 'e4')).toBe(false);
    expect(isPromotion(WHITE_PAWN_E7, 'e1', 'e2')).toBe(false);
  });

  it('lists queen, rook, bishop and knight and positions the chooser over the target square', () => {
    expect(promotionPieces()).toEqual(['q', 'r', 'b', 'n']);
    expect(promotionOverlayStyle('e8', 'white')).toEqual({ left: '50%', top: '0%' });
    expect(promotionOverlayStyle('e8', 'black')).toEqual({ left: '37.5%', top: '87.5%' });
    expect(promotionOverlayStyle('d1', 'black')).toEqual({ left: '50%', top: '0%' });
  });
});

describe('result labels', () => {
  it('describes the result from the viewer’s side with the reason and the rating change', () => {
    const finished = afterPlies(4, {
      status: 'finished',
      result: '0-1',
      endReason: 'checkmate',
      viewerRole: 'black',
      black: {
        ...gameDto().black,
        rating: 1500,
        provisional: true,
        isBot: false,
        ratingAfter: 1662,
        provisionalAfter: true,
      },
    });
    expect(resultForViewer(finished)).toBe('You won');
    expect(resultForViewer({ ...finished, viewerRole: 'white' })).toBe('You lost');
    expect(resultForViewer({ ...finished, viewerRole: 'spectator' })).toBe('Black won');
    expect(resultForViewer({ ...finished, result: '1/2-1/2', endReason: 'draw_agreement' })).toBe(
      'Draw',
    );
    expect(resultForViewer({ ...finished, result: '*', endReason: 'abort' })).toBe('Aborted');
    expect(ratingChangeFor(finished)).toBe('1500? → 1662?');
    expect(ratingChangeFor({ ...finished, viewerRole: 'spectator' })).toBeNull();
    expect(ratingChangeFor({ ...finished, rated: false })).toBeNull();
  });
});
