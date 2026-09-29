import type { Colour } from '../protocol/enums';

export type PieceLetter = 'q' | 'r' | 'b' | 'n' | 'p';

export type SideMaterial = {
  /** The opponent's pieces this side has taken, biggest first. */
  captured: PieceLetter[];
  /** How far ahead this side is; 0 when level or behind. */
  lead: number;
};

const ORDER: PieceLetter[] = ['q', 'r', 'b', 'n', 'p'];
const VALUE: Record<PieceLetter, number> = { q: 9, r: 5, b: 3, n: 3, p: 1 };
const START: Record<PieceLetter, number> = { q: 1, r: 2, b: 2, n: 2, p: 8 };

/**
 * Material for both sides, counted from the placement field against the starting set. A promoted
 * piece adds to its side's total but never shows as a negative capture.
 */
export function material(fen: string): Record<Colour, SideMaterial> {
  const count: Record<Colour, Record<PieceLetter, number>> = {
    white: { q: 0, r: 0, b: 0, n: 0, p: 0 },
    black: { q: 0, r: 0, b: 0, n: 0, p: 0 },
  };
  for (const ch of fen.split(' ')[0] ?? '') {
    const letter = ch.toLowerCase() as PieceLetter;
    if (!(letter in VALUE)) continue;
    count[ch === letter ? 'black' : 'white'][letter]++;
  }
  const total = (side: Colour) => ORDER.reduce((sum, k) => sum + VALUE[k] * count[side][k], 0);
  const side = (me: Colour, them: Colour): SideMaterial => ({
    captured: ORDER.flatMap((k) =>
      Array<PieceLetter>(Math.max(0, START[k] - count[them][k])).fill(k),
    ),
    lead: Math.max(0, total(me) - total(them)),
  });
  return { white: side('white', 'black'), black: side('black', 'white') };
}
