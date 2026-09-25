import { describe, expect, it } from 'vitest';
import {
  buildSnapshotModel,
  shareMoveNumber,
  snapshotRowLimit,
} from '../../src/images/snapshotModel';
import { AFTER_E4, snapshotInput } from '../helpers/snapshotFixtures';

const sans = (count: number): string[] => Array.from({ length: count }, (_, i) => `m${i + 1}`);

describe('shareMoveNumber', () => {
  it('counts the initial position as move 1 and rounds half-moves up', () => {
    expect([0, 1, 2, 3, 59, 60].map(shareMoveNumber)).toEqual([1, 1, 1, 2, 30, 30]);
  });
});

describe('buildSnapshotModel', () => {
  it('heads the panel with the group and the terms', () => {
    const model = buildSnapshotModel(snapshotInput());
    expect(model.group).toBe('Friday Chess Club');
    expect(model.meta).toBe('1 day per move · Rated');
  });

  it('lists the player at the top of the board first', () => {
    const fromWhite = buildSnapshotModel(snapshotInput());
    expect(fromWhite.players).toEqual([
      { colour: 'black', name: '@mayachess', rating: '1587' },
      { colour: 'white', name: '@sam_k', rating: '1512' },
    ]);
    const fromBlack = buildSnapshotModel(
      snapshotInput({ board: { ...snapshotInput().board, orientation: 'black' } }),
    );
    expect(fromBlack.players.map((player) => player.colour)).toEqual(['white', 'black']);
  });

  it('marks provisional ratings and leaves out a missing one', () => {
    const model = buildSnapshotModel(
      snapshotInput({
        white: { name: 'New', rating: { rating: 1500, rd: 300 }, engineLevel: null },
        black: { name: 'Unrated', rating: null, engineLevel: null },
      }),
    );
    expect(model.players.map((player) => player.rating)).toEqual([null, '1500?']);
  });

  it("shows a bot's level on its own row when a spectator shares a bot game", () => {
    const model = buildSnapshotModel(
      snapshotInput({
        timePerMove: null,
        rated: false,
        black: { name: 'Chess Goat', rating: { rating: 1500, rd: 350 }, engineLevel: 'strong' },
      }),
    );
    expect(model.players[0]).toEqual({ colour: 'black', name: 'Chess Goat', rating: 'Strong' });
    expect(model.players[1]).toEqual({ colour: 'white', name: '@sam_k', rating: '1512' });
    expect(model.meta).toBe('No clock · Casual');
  });

  it('shows every row up to the limit, with the shared move highlighted', () => {
    const even = buildSnapshotModel(snapshotInput({ ply: 12, plyCount: 12, sans: sans(12) }));
    expect(even.rows).toHaveLength(6);
    expect(even.rows[5]).toEqual({
      number: 6,
      white: { san: 'm11', current: false },
      black: { san: 'm12', current: true },
    });
    const odd = buildSnapshotModel(snapshotInput({ ply: 11, plyCount: 11, sans: sans(11) }));
    expect(odd.rows[5]).toEqual({
      number: 6,
      white: { san: 'm11', current: true },
      black: null,
    });
  });

  it('keeps only the last rows once earlier moves are cut', () => {
    const model = buildSnapshotModel(snapshotInput({ ply: 17, plyCount: 17, sans: sans(17) }));
    expect(model.rows.map((row) => row.number)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(model.rows[5]?.white).toEqual({ san: 'm17', current: true });
  });

  it('shows fewer rows under a longer group title, which takes more lines', () => {
    const rows = (groupTitle: string) =>
      buildSnapshotModel(snapshotInput({ ply: 40, plyCount: 40, sans: sans(40), groupTitle })).rows
        .length;
    expect(rows('x'.repeat(30))).toBe(6);
    expect(rows('x'.repeat(31))).toBe(5);
    expect(rows('x'.repeat(60))).toBe(5);
    expect(rows('x'.repeat(61))).toBe(4);
  });

  it('has no rows at the initial position', () => {
    expect(buildSnapshotModel(snapshotInput()).rows).toEqual([]);
  });

  describe('status', () => {
    const status = (overrides: Parameters<typeof snapshotInput>[0]) =>
      buildSnapshotModel(snapshotInput(overrides)).status;

    it('is left out while the game is running, at any position', () => {
      expect(status({})).toBeNull();
      expect(status({ timePerMove: null })).toBeNull();
      expect(
        status({
          ply: 1,
          plyCount: 2,
          sans: ['e4'],
          board: { fen: AFTER_E4, lastMove: 'e2e4', check: false, orientation: 'white' },
        }),
      ).toBeNull();
    });

    it('names the winner, the reason and the score of a finished game', () => {
      const finished = { status: 'finished' as const };
      expect(status({ ...finished, result: '1-0', endReason: 'checkmate' })).toBe(
        '@sam_k won · Checkmate · 1-0',
      );
      expect(status({ ...finished, result: '0-1', endReason: 'timeout' })).toBe(
        '@mayachess won · Timeout · 0-1',
      );
      expect(status({ ...finished, result: '1/2-1/2', endReason: 'draw_agreement' })).toBe(
        'Draw · Draw agreed · ½-½',
      );
    });

    it('says how an unfinished game ended', () => {
      const finished = { status: 'finished' as const, result: '*' as const };
      expect(status({ ...finished, endReason: 'abort' })).toBe('Aborted');
      expect(status({ ...finished, endReason: 'voided' })).toBe('Voided by an admin');
      expect(status({ ...finished, endReason: null })).toBe('Aborted');
    });

    it('names no winner when a finished game was voided by an admin', () => {
      expect(
        status({
          status: 'finished',
          result: '1-0',
          endReason: 'checkmate',
          voided: true,
        }),
      ).toBe('Voided by an admin');
    });

    it('is left out for an earlier position of a voided game', () => {
      expect(
        status({
          status: 'finished',
          result: '1-0',
          endReason: 'checkmate',
          voided: true,
          ply: 1,
          plyCount: 40,
          sans: ['e4'],
          board: { fen: AFTER_E4, lastMove: 'e2e4', check: false, orientation: 'white' },
        }),
      ).toBeNull();
    });

    it('is left out for an earlier position of a finished game', () => {
      expect(
        status({
          status: 'finished',
          result: '1-0',
          endReason: 'resignation',
          ply: 1,
          plyCount: 40,
          sans: ['e4'],
          board: { fen: AFTER_E4, lastMove: 'e2e4', check: false, orientation: 'white' },
        }),
      ).toBeNull();
    });
  });
});

describe('snapshotRowLimit', () => {
  it('counts characters, not UTF-16 units, so emoji titles are not cut early', () => {
    expect(snapshotRowLimit('🐐'.repeat(30))).toBe(6);
  });
});
