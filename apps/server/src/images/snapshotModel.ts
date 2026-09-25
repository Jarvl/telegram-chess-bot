import {
  endReasonLabel,
  isProvisional,
  ratedLabel,
  ratingLabel,
  resultLabel,
  t,
  timePerMoveLabel,
  type Colour,
  type EndReason,
  type EngineLevel,
  type GameResult,
  type GameStatus,
  type TimePerMove,
} from '@group-chess/shared';
import type { BoardRenderInput } from './board';

/**
 * Move rows the panel shows before it cuts the oldest: fewer under a longer group title, which
 * wraps onto more lines above them.
 */
export function snapshotRowLimit(groupTitle: string): number {
  const length = [...groupTitle].length;
  return length > 60 ? 4 : length > 30 ? 5 : 6;
}

export type SnapshotSide = {
  name: string;
  rating: { rating: number; rd: number } | null;
  /** Set for the engine's side of a bot game; shown instead of a rating. */
  engineLevel: EngineLevel | null;
};

export type SnapshotInput = {
  ply: number;
  /** SAN of plies 1..ply, in order. */
  sans: readonly string[];
  board: BoardRenderInput;
  white: SnapshotSide;
  black: SnapshotSide;
  groupTitle: string;
  timePerMove: TimePerMove;
  rated: boolean;
  status: GameStatus;
  result: GameResult | null;
  endReason: EndReason | null;
  plyCount: number;
  /** A finished game keeps its result/endReason when voided; this names no winner instead. */
  voided: boolean;
};

export type SnapshotPlayer = { colour: Colour; name: string; rating: string | null };
export type SnapshotCell = { san: string; current: boolean };
export type SnapshotRow = {
  number: number;
  white: SnapshotCell;
  black: SnapshotCell | null;
};

/** Everything the card shows, already worded (spec §1.2). */
export type SnapshotModel = {
  board: BoardRenderInput;
  group: string;
  /** Time per move and rated or casual, under the group. */
  meta: string;
  /** The player at the top of the board first. */
  players: [SnapshotPlayer, SnapshotPlayer];
  rows: SnapshotRow[];
  /** The result, only for a finished game's final position. */
  status: string | null;
};

/** The move a share names in its pill and caption; the initial position counts as move 1. */
export function shareMoveNumber(ply: number): number {
  return Math.max(1, Math.ceil(ply / 2));
}

function player(colour: Colour, side: SnapshotSide): SnapshotPlayer {
  const rating = side.engineLevel
    ? t(`app.level.${side.engineLevel}`)
    : side.rating
      ? ratingLabel(side.rating.rating, isProvisional(side.rating.rd))
      : null;
  return { colour, name: side.name, rating };
}

function moveRows(sans: readonly string[], limit: number): SnapshotRow[] {
  const last = sans.length - 1;
  const rows: SnapshotRow[] = [];
  for (let index = 0; index < sans.length; index += 2) {
    const black = sans[index + 1];
    rows.push({
      number: index / 2 + 1,
      white: { san: sans[index]!, current: index === last },
      black: black === undefined ? null : { san: black, current: index + 1 === last },
    });
  }
  return rows.slice(-limit);
}

const joined = (parts: (string | null)[]): string => parts.filter(Boolean).join(' · ');

function resultLine(input: SnapshotInput): string {
  const reason = input.endReason ? endReasonLabel(input.endReason) : null;
  if (input.result === '1-0' || input.result === '0-1') {
    const winner = input.result === '1-0' ? input.white : input.black;
    return joined([
      t('image.share.won', { player: winner.name }),
      reason,
      resultLabel(input.result),
    ]);
  }
  if (input.result === '1/2-1/2')
    return joined([t('app.game.result.draw'), reason, resultLabel(input.result)]);
  // A finished game always carries a result; a null one here falls back to the aborted wording.
  return reason ?? t('app.game.result.aborted');
}

/** Spec §3.2: a running game or an earlier position carries no status line. */
function statusLine(input: SnapshotInput): string | null {
  if (input.status !== 'finished' || input.ply !== input.plyCount) return null;
  return input.voided ? t('end_reason.voided') : resultLine(input);
}

export function buildSnapshotModel(input: SnapshotInput): SnapshotModel {
  const white = player('white', input.white);
  const black = player('black', input.black);
  return {
    board: input.board,
    group: input.groupTitle,
    meta: joined([timePerMoveLabel(input.timePerMove), ratedLabel(input.rated)]),
    players: input.board.orientation === 'white' ? [black, white] : [white, black],
    rows: moveRows(input.sans, snapshotRowLimit(input.groupTitle)),
    status: statusLine(input),
  };
}
