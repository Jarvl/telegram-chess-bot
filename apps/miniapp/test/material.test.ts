import { INITIAL_FEN } from '@group-chess/shared';
import { describe, expect, it } from 'vitest';
import { material } from '../src/ui/game/material';

describe('material', () => {
  it('has nothing taken and nobody ahead at the start', () => {
    expect(material(INITIAL_FEN)).toEqual({
      white: { captured: [], lead: 0 },
      black: { captured: [], lead: 0 },
    });
  });

  it('lists what each side took, biggest first, and gives the lead to the side ahead', () => {
    // White is missing a knight and a pawn; black is missing its queen.
    const fen = 'rnb1kbnr/pppppppp/8/8/8/8/PPPPPPP1/RNBQKB1R w KQkq - 0 1';
    expect(material(fen)).toEqual({
      white: { captured: ['q'], lead: 5 },
      black: { captured: ['n', 'p'], lead: 0 },
    });
  });

  it('shows the trade but no lead when material is even', () => {
    const fen = 'rnbqkbnr/ppp1pppp/8/8/8/8/PPP1PPPP/RNBQKBNR w KQkq - 0 1';
    expect(material(fen)).toEqual({
      white: { captured: ['p'], lead: 0 },
      black: { captured: ['p'], lead: 0 },
    });
  });

  it('counts a promoted piece towards the lead without listing a negative capture', () => {
    // White promoted its a-pawn to a second queen and lost a rook; black lost a pawn.
    const fen = 'rnbqkbnr/1ppppppp/8/8/8/8/1PPPPPPP/QNBQKBNR w Kkq - 0 1';
    expect(material(fen)).toEqual({
      white: { captured: ['p'], lead: 4 },
      black: { captured: ['r', 'p'], lead: 0 },
    });
  });
});
