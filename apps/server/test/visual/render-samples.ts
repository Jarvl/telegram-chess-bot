// Snapshot spec §6 "By eye": writes sample cards to compare with the Claude Design prototype.
// Usage: pnpm --filter @group-chess/server exec tsx test/visual/render-samples.ts <out-dir>
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import type { BoardRenderInput } from '../../src/images/board';
import { loadFonts } from '../../src/images/fonts';
import { renderSnapshotPng, renderSnapshotSvg } from '../../src/images/snapshot';
import { buildSnapshotModel, type SnapshotInput } from '../../src/images/snapshotModel';
import { SHARED_AT, snapshotInput } from '../helpers/snapshotFixtures';

/** Kasparov–Topalov, Wijk aan Zee 1999, through 30…Qc4 (the design's long-game example). */
const KASPAROV_TOPALOV =
  'e4 d6 d4 Nf6 Nc3 g6 Be3 Bg7 Qd2 c6 f3 b5 Nge2 Nbd7 Bh6 Bxh6 Qxh6 Bb7 a3 e5 O-O-O Qe7 Kb1 a6 Nc1 O-O-O Nb3 exd4 Rxd4 c5 Rd1 Nb6 g3 Kb8 Na5 Ba8 Bh3 d5 Qf4+ Ka7 Rhe1 d4 Nd5 Nbxd5 exd5 Qd6 Rxd4 cxd4 Re7+ Kb6 Qxd4+ Kxa5 b4+ Ka4 Qc3 Qxd5 Ra7 Bb7 Rxb7 Qc4'.split(
    ' ',
  );

/** The position after playing `sans` from the start, as the share job would build it. */
function replay(sans: string[], orientation: 'white' | 'black' = 'white'): BoardRenderInput {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  const last = chess.history({ verbose: true }).at(-1);
  return {
    fen: chess.fen(),
    lastMove: last ? `${last.from}${last.to}` : null,
    check: chess.inCheck(),
    orientation,
  };
}

const samples: Record<string, Partial<SnapshotInput>> = {
  opening: {
    ply: 1,
    plyCount: 1,
    sans: ['e4'],
    board: replay(['e4']),
    deadlineAt: new Date(SHARED_AT.getTime() + (14 * 60 + 32) * 60_000),
  },
  'long-game': {
    ply: 60,
    plyCount: 60,
    sans: KASPAROV_TOPALOV,
    board: replay(KASPAROV_TOPALOV),
  },
  finished: {
    ply: 60,
    plyCount: 60,
    sans: KASPAROV_TOPALOV,
    board: replay(KASPAROV_TOPALOV),
    status: 'finished',
    result: '1-0',
    endReason: 'resignation',
    deadlineAt: null,
  },
  'cjk-emoji': {
    white: { name: '李小龍', rating: { rating: 1500, rd: 300 }, engineLevel: null },
    black: { name: 'さくら 🐐', rating: null, engineLevel: null },
    groupTitle: '♞ 김민수의 체스 클럽 🔥🔥🔥 and a very long title that must end in an ellipsis',
  },
  'black-bot': {
    board: replay(['e4'], 'black'),
    ply: 1,
    plyCount: 1,
    sans: ['e4'],
    timePerMove: null,
    rated: false,
    deadlineAt: null,
    white: { name: 'Chess Goat', rating: null, engineLevel: 'club' },
  },
};

const out = process.argv[2];
if (!out) throw new Error('usage: render-samples.ts <out-dir>');
await mkdir(out, { recursive: true });
const fonts = await loadFonts();
for (const [name, overrides] of Object.entries(samples)) {
  const svg = await renderSnapshotSvg(buildSnapshotModel(snapshotInput(overrides)), fonts);
  await writeFile(join(out, `${name}.png`), renderSnapshotPng(svg));
  console.log(join(out, `${name}.png`));
}
