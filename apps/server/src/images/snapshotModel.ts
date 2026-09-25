import {
  endReasonLabel,
  isProvisional,
  ratedLabel,
  ratingLabel,
  resultLabel,
  sideToMove,
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

/** Snapshot spec §1.2: rows the panel shows before it cuts the oldest. */
export const SNAPSHOT_MAX_ROWS = 8;

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
  deadlineAt: Date | null;
  /** When the user tapped Share: the clock is shown as it was then (spec §3.2). */
  sharedAt: Date;
  /** A finished game keeps its result/endReason when voided; this names no winner instead. */
  voided: boolean;
};

export type SnapshotPlayer = { colour: Colour; name: string; rating: string | null };
export type SnapshotCell = { san: string; current: boolean };
export type SnapshotRow = {
  number: number;
  white: SnapshotCell;
  black: SnapshotCell | null;
  faded: boolean;
};

/** Everything the card shows, already worded (spec §1.2). */
export type SnapshotModel = {
  board: BoardRenderInput;
  pill: string;
  /** The player at the top of the board first. */
  players: [SnapshotPlayer, SnapshotPlayer];
  rows: SnapshotRow[];
  status: string;
  group: string;
  terms: string;
};

/** The move a share names in its pill and caption; the initial position counts as move 1. */
export function shareMoveNumber(ply: number): number {
  return Math.max(1, Math.ceil(ply / 2));
}

/** `1d 2h` from a day up, `14h 32m` below; never negative. */
export function formatSnapshotTimeLeft(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h ${minutes % 60}m`;
}

function player(colour: Colour, side: SnapshotSide): SnapshotPlayer {
  const rating = side.engineLevel
    ? t(`app.level.${side.engineLevel}`)
    : side.rating
      ? ratingLabel(side.rating.rating, isProvisional(side.rating.rd))
      : null;
  return { colour, name: side.name, rating };
}

function moveRows(sans: readonly string[]): SnapshotRow[] {
  const last = sans.length - 1;
  const rows: SnapshotRow[] = [];
  for (let index = 0; index < sans.length; index += 2) {
    const black = sans[index + 1];
    rows.push({
      number: index / 2 + 1,
      white: { san: sans[index]!, current: index === last },
      black: black === undefined ? null : { san: black, current: index + 1 === last },
      faded: false,
    });
  }
  if (rows.length <= SNAPSHOT_MAX_ROWS) return rows;
  return rows
    .slice(-SNAPSHOT_MAX_ROWS)
    .map((row, index) => (index === 0 ? { ...row, faded: true } : row));
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

/** Spec §3.2, first match wins. */
function statusLine(input: SnapshotInput): string {
  const latest = input.ply === input.plyCount;
  if (input.status === 'finished' && latest && input.voided) return t('end_reason.voided');
  if (input.status === 'finished' && latest) return resultLine(input);
  const toMove = t('image.share.to_move', { side: t(`colour.${sideToMove(input.board.fen)}`) });
  if (input.timePerMove === null) return joined([toMove, timePerMoveLabel(null)]);
  if (input.status === 'active' && latest && input.deadlineAt) {
    const left = input.deadlineAt.getTime() - input.sharedAt.getTime();
    return joined([toMove, t('image.share.time_left', { time: formatSnapshotTimeLeft(left) })]);
  }
  return toMove;
}

export function buildSnapshotModel(input: SnapshotInput): SnapshotModel {
  const white = player('white', input.white);
  const black = player('black', input.black);
  return {
    board: input.board,
    pill: t('image.share.snapshot', { moveNumber: shareMoveNumber(input.ply) }),
    players: input.board.orientation === 'white' ? [black, white] : [white, black],
    rows: moveRows(input.sans),
    status: statusLine(input),
    group: input.groupTitle,
    terms: joined([timePerMoveLabel(input.timePerMove), ratedLabel(input.rated)]),
  };
}
