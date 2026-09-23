import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { analysisUrl, buildPgn, formatPgnDate } from '../../src/chess/pgn';

const base = {
  site: 'Chess Club',
  date: new Date('2026-09-20T18:30:00Z'),
  white: 'Alice',
  black: 'Bob',
  result: '1-0' as const,
  whiteElo: 1520,
  blackElo: 1498,
  timePerMove: 86400 as const,
  endReason: 'checkmate' as const,
};
const scholarsMate = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#'];

describe('buildPgn', () => {
  it('writes the seven-tag roster followed by the Chess Goat tags', () => {
    expect(buildPgn(base, scholarsMate)).toBe(
      [
        '[Event "Chess Goat"]',
        '[Site "Chess Club"]',
        '[Date "2026.09.20"]',
        '[Round "-"]',
        '[White "Alice"]',
        '[Black "Bob"]',
        '[Result "1-0"]',
        '[WhiteElo "1520"]',
        '[BlackElo "1498"]',
        '[TimeControl "-"]',
        '[TimePerMove "86400"]',
        '[Termination "Normal"]',
        '',
        '1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0',
        '',
      ].join('\n'),
    );
  });

  it('round-trips through chess.js', () => {
    const chess = new Chess();
    chess.loadPgn(buildPgn(base, scholarsMate));
    expect(chess.history()).toEqual(scholarsMate);
    expect(chess.getHeaders().White).toBe('Alice');
    expect(chess.getHeaders().TimePerMove).toBe('86400');
  });

  it('escapes quotes and backslashes in tag values', () => {
    const pgn = buildPgn({ ...base, white: 'Bob "Rook" O\\Neil' }, ['e4']);
    expect(pgn).toContain('[White "Bob \\"Rook\\" O\\\\Neil"]');
  });

  it('omits Elo tags for casual games and marks unfinished games', () => {
    const pgn = buildPgn(
      { ...base, whiteElo: null, blackElo: null, result: '*', endReason: null, timePerMove: null },
      [],
    );
    expect(pgn).not.toContain('Elo');
    expect(pgn).toContain('[TimePerMove "-"]');
    expect(pgn).toContain('[Termination "Unterminated"]');
    expect(pgn.endsWith('\n\n*\n')).toBe(true);
  });

  it.each([
    ['timeout', 'Time forfeit'],
    ['timeout_abort', 'Abandoned'],
    ['abort', 'Abandoned'],
    ['voided', 'Adjudication'],
    ['resignation', 'Normal'],
  ] as const)('maps %s to Termination "%s"', (reason, termination) => {
    expect(buildPgn({ ...base, endReason: reason }, ['e4'])).toContain(
      `[Termination "${termination}"]`,
    );
  });

  it('wraps the movetext at 80 columns', () => {
    const moves = Array.from({ length: 120 }, (_, i) => (i % 2 === 0 ? 'Nf3' : 'Nf6'));
    const movetext = buildPgn(base, moves).split('\n\n')[1] ?? '';
    const lines = movetext.trimEnd().split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    expect(lines.at(-1)?.endsWith('1-0')).toBe(true);
  });
});

describe('formatPgnDate', () => {
  it('formats in UTC with dots', () => {
    expect(formatPgnDate(new Date('2026-01-05T23:30:00Z'))).toBe('2026.01.05');
  });
});

describe('analysisUrl', () => {
  it('joins SAN with underscores and URL-encodes symbols', () => {
    expect(analysisUrl(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'Bxf7+'])).toBe(
      'https://lichess.org/analysis/pgn/e4_e5_Nf3_Nc6_Bc4_Bc5_Bxf7%2B',
    );
    expect(analysisUrl(scholarsMate)).toContain('Qxf7%23');
  });
});
