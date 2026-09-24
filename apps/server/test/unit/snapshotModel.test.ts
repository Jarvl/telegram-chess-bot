import { describe, expect, it } from 'vitest';
import {
  buildSnapshotModel,
  formatSnapshotTimeLeft,
  shareMoveNumber,
} from '../../src/images/snapshotModel';
import { AFTER_E4, SHARED_AT, snapshotInput } from '../helpers/snapshotFixtures';

const sans = (count: number): string[] => Array.from({ length: count }, (_, i) => `m${i + 1}`);
const at = (ms: number): Date => new Date(SHARED_AT.getTime() + ms);
const HOUR = 3_600_000;
const MINUTE = 60_000;

describe('shareMoveNumber', () => {
  it('counts the initial position as move 1 and rounds half-moves up', () => {
    expect([0, 1, 2, 3, 59, 60].map(shareMoveNumber)).toEqual([1, 1, 1, 2, 30, 30]);
  });
});

describe('formatSnapshotTimeLeft', () => {
  it('uses days and hours from a day up, hours and minutes below, and never goes negative', () => {
    expect(formatSnapshotTimeLeft(14 * HOUR + 32 * MINUTE + 59_000)).toBe('14h 32m');
    expect(formatSnapshotTimeLeft(26 * HOUR + 5 * MINUTE)).toBe('1d 2h');
    expect(formatSnapshotTimeLeft(24 * HOUR)).toBe('1d 0h');
    expect(formatSnapshotTimeLeft(59_999)).toBe('0h 0m');
    expect(formatSnapshotTimeLeft(-5 * MINUTE)).toBe('0h 0m');
  });
});

describe('buildSnapshotModel', () => {
  it('labels the pill with the move number', () => {
    expect(buildSnapshotModel(snapshotInput()).pill).toBe('Snapshot · Move 1');
    expect(buildSnapshotModel(snapshotInput({ ply: 59, plyCount: 59, sans: sans(59) })).pill).toBe(
      'Snapshot · Move 30',
    );
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
        deadlineAt: null,
        black: { name: 'Chess Goat', rating: { rating: 1500, rd: 350 }, engineLevel: 'strong' },
      }),
    );
    expect(model.players[0]).toEqual({ colour: 'black', name: 'Chess Goat', rating: 'Strong' });
    expect(model.players[1]).toEqual({ colour: 'white', name: '@sam_k', rating: '1512' });
    expect(model.terms).toBe('No clock · Casual');
  });

  it('shows every row up to 8, with the shared move highlighted', () => {
    const even = buildSnapshotModel(snapshotInput({ ply: 16, plyCount: 16, sans: sans(16) }));
    expect(even.rows).toHaveLength(8);
    expect(even.rows.some((row) => row.faded)).toBe(false);
    expect(even.rows[7]).toEqual({
      number: 8,
      white: { san: 'm15', current: false },
      black: { san: 'm16', current: true },
      faded: false,
    });
    const odd = buildSnapshotModel(snapshotInput({ ply: 15, plyCount: 15, sans: sans(15) }));
    expect(odd.rows[7]).toEqual({
      number: 8,
      white: { san: 'm15', current: true },
      black: null,
      faded: false,
    });
  });

  it('keeps the last 8 rows and fades the top one once earlier moves are cut', () => {
    const model = buildSnapshotModel(snapshotInput({ ply: 17, plyCount: 17, sans: sans(17) }));
    expect(model.rows.map((row) => row.number)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(model.rows.map((row) => row.faded)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(model.rows[7]?.white).toEqual({ san: 'm17', current: true });
  });

  it('has no rows at the initial position', () => {
    expect(buildSnapshotModel(snapshotInput()).rows).toEqual([]);
  });

  describe('status', () => {
    const status = (overrides: Parameters<typeof snapshotInput>[0]) =>
      buildSnapshotModel(snapshotInput(overrides)).status;

    it('gives the time left at the moment of sharing for the latest position', () => {
      expect(status({ deadlineAt: at(14 * HOUR + 32 * MINUTE) })).toBe(
        'White to move · 14h 32m left',
      );
      expect(status({ deadlineAt: at(26 * HOUR) })).toBe('White to move · 1d 2h left');
    });

    it('never shows a negative time when the deadline has already passed', () => {
      expect(status({ deadlineAt: at(-3 * MINUTE) })).toBe('White to move · 0h 0m left');
    });

    it('leaves the clock out of an earlier position', () => {
      expect(
        status({
          ply: 1,
          plyCount: 2,
          sans: ['e4'],
          board: { fen: AFTER_E4, lastMove: 'e2e4', check: false, orientation: 'white' },
        }),
      ).toBe('Black to move');
    });

    it('says there is no clock in an untimed game', () => {
      expect(status({ timePerMove: null, deadlineAt: null })).toBe('White to move · No clock');
    });

    it('names the winner, the reason and the score of a finished game', () => {
      const finished = { status: 'finished' as const, deadlineAt: null };
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
      const finished = { status: 'finished' as const, deadlineAt: null, result: '*' as const };
      expect(status({ ...finished, endReason: 'abort' })).toBe('Aborted');
      expect(status({ ...finished, endReason: 'voided' })).toBe('Voided by an admin');
      expect(status({ ...finished, endReason: null })).toBe('Aborted');
    });

    it('shows whose move it was for an earlier position of a finished game', () => {
      expect(
        status({
          status: 'finished',
          result: '1-0',
          endReason: 'resignation',
          deadlineAt: null,
          ply: 1,
          plyCount: 40,
          sans: ['e4'],
          board: { fen: AFTER_E4, lastMove: 'e2e4', check: false, orientation: 'white' },
        }),
      ).toBe('Black to move');
    });
  });

  it('passes the group through and joins the terms', () => {
    const model = buildSnapshotModel(snapshotInput());
    expect(model.group).toBe('Friday Chess Club');
    expect(model.terms).toBe('1 day per move · Rated');
  });
});
