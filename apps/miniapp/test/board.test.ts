import { describe, expect, it } from 'vitest';
import { boardConfig, highlightSquares } from '../src/board/adapter';
import { isPromotion, promotionOverlayStyle, promotionPieces } from '../src/board/promotion';
import { sideResult } from '../src/ui/game/result';
import { AFTER_E4, afterPlies } from './support/gameFixtures';

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
  const finished = afterPlies(4, {
    status: 'finished',
    result: '0-1',
    endReason: 'checkmate',
    viewerRole: 'black',
  });

  it('tags the winner Won with the reason, and the loser Lost with none', () => {
    expect(sideResult(finished, 'black')).toEqual({ tag: 'won', reason: 'Checkmate' });
    expect(sideResult(finished, 'white')).toEqual({ tag: 'lost', reason: null });
    // The tags name each side, so they read the same for a spectator.
    expect(sideResult({ ...finished, viewerRole: 'spectator' }, 'black')?.tag).toBe('won');
  });

  it('tags both sides Draw with the reason', () => {
    const draw = { ...finished, result: '1/2-1/2' as const, endReason: 'draw_agreement' as const };
    expect(sideResult(draw, 'white')).toEqual({ tag: 'draw', reason: 'Draw agreed' });
    expect(sideResult(draw, 'black')).toEqual({ tag: 'draw', reason: 'Draw agreed' });
  });

  it('tags both sides Aborted, with the reason under White only', () => {
    const aborted = { ...finished, result: '*' as const, endReason: 'abort' as const };
    expect(sideResult(aborted, 'white')).toEqual({ tag: 'aborted', reason: 'Aborted' });
    expect(sideResult(aborted, 'black')).toEqual({ tag: 'aborted', reason: null });
  });

  it('tags both sides Voided with no reason', () => {
    const voided = { ...finished, voided: true };
    expect(sideResult(voided, 'white')).toEqual({ tag: 'voided', reason: null });
    expect(sideResult(voided, 'black')).toEqual({ tag: 'voided', reason: null });
  });

  it('has no result while the game is on', () => {
    expect(sideResult(afterPlies(2), 'white')).toBeNull();
  });
});

describe('premove highlights and taps', () => {
  const position = {
    fen: AFTER_E4,
    lastMove: null,
    check: false,
    orientation: 'white' as const,
    turnColour: 'white' as const,
  };
  const movable = { colour: 'white' as const, dests: new Map<string, string[]>() };

  it("marks the viewed premove's squares with the premove class", () => {
    expect(highlightSquares(['g1', 'h3'])).toEqual(
      new Map([
        ['g1', 'premove-sq'],
        ['h3', 'premove-sq'],
      ]),
    );
    expect(highlightSquares([]).size).toBe(0);
  });

  it('reports a tapped square to the select handler', () => {
    const taps: string[] = [];
    const config = boardConfig(
      position,
      movable,
      false,
      () => undefined,
      (square) => taps.push(square),
    );
    config.events?.select?.('e4');
    expect(taps).toEqual(['e4']);
  });
});
