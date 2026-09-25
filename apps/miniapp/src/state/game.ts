import {
  imaginedBoard,
  INITIAL_FEN,
  legalDests,
  placementOf,
  premoveTargets,
  sideToMove,
  type Colour,
  type GameDto,
} from '@group-chess/shared';
import { computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';
import { Chess } from 'chess.js';
import { premoveLabel, sameList } from './premoves';

export type Position = {
  ply: number;
  fen: string;
  lastMove: [string, string] | null;
  check: boolean;
};

export type Notice =
  | 'draw_offered'
  | 'draw_declined'
  | 'opponent_moved'
  | 'finished'
  | 'premove_played'
  | 'premoves_cancelled';

function inCheck(fen: string): boolean {
  try {
    return new Chess(fen).inCheck();
  } catch {
    return false;
  }
}

/** The position after `ply` plies; ply 0 is the initial position. */
export function positionAt(dto: GameDto, ply: number): Position {
  if (ply <= 0) return { ply: 0, fen: INITIAL_FEN, lastMove: null, check: false };
  const move = dto.moves[ply - 1];
  const fen = move ? move.fenAfter : dto.fen;
  return {
    ply: move ? move.ply : dto.plyCount,
    fen,
    lastMove: move ? [move.uci.slice(0, 2), move.uci.slice(2, 4)] : null,
    check: inCheck(fen),
  };
}

/** Spec §6.4: banners come from the diff between consecutive states, never from separate events. */
export function diffNotices(prev: GameDto, next: GameDto): Notice[] {
  const notices: Notice[] = [];
  const viewer = next.viewerRole;
  if (prev.status === 'active' && next.status === 'finished') {
    notices.push('finished');
    return notices;
  }
  if (next.drawOffer && !prev.drawOffer && next.drawOffer.by !== viewer)
    notices.push('draw_offered');
  if (
    prev.drawOffer &&
    prev.drawOffer.by === viewer &&
    !next.drawOffer &&
    next.plyCount === prev.plyCount &&
    next.status === 'active'
  ) {
    notices.push('draw_declined');
  }
  if (
    next.plyCount > prev.plyCount &&
    next.status === 'active' &&
    (viewer === 'white' || viewer === 'black') &&
    sideToMove(next.fen) === viewer
  ) {
    notices.push('opponent_moved');
  }
  // Premoves spec, Notices: the viewer's chain either played moves or was cancelled. A resumed
  // app can jump several plies at once (fix round 1), so count how many queued premoves fired in
  // order — the queue's own side moves every other ply, starting two plies after `prev` — rather
  // than assuming only the first one could have played.
  if (next.plyCount > prev.plyCount && next.status === 'active' && prev.premoves.length > 0) {
    let fired = 0;
    while (
      fired < prev.premoves.length &&
      next.moves[prev.plyCount + 1 + 2 * fired]?.uci === prev.premoves[fired]
    ) {
      fired += 1;
    }
    if (fired >= 1) notices.push('premove_played');
    // A chain that lost more than the fired moves was cancelled after them: across a multi-ply
    // jump, a premove played and a later reply found the next one illegal. The server keeps a
    // fired premove's leftover chain whole, so this is always a real cancel.
    if (next.premoves.length < prev.premoves.length - fired) notices.push('premoves_cancelled');
  }
  return notices;
}

export class GameStore {
  readonly dto: Signal<GameDto>;
  /** null shows the latest position; a number shows an earlier one view-only (spec §6.3). */
  readonly viewingPly: Signal<number | null> = signal(null);
  readonly flipped: Signal<boolean> = signal(false);
  readonly position: ReadonlySignal<Position>;
  readonly isLatest: ReadonlySignal<boolean>;
  readonly orientation: ReadonlySignal<Colour>;
  readonly sideToMove: ReadonlySignal<Colour>;
  readonly canMove: ReadonlySignal<boolean>;
  readonly dests: ReadonlySignal<Map<string, string[]>>;
  /**
   * The chain the player has made but the server hasn't confirmed yet. A state from the server
   * replaces it, except a same-ply one while a save is running: the save owns it until it settles
   * (premoves spec, Queuing).
   */
  readonly optimisticPremoves: Signal<string[] | null> = signal(null);
  /** null is the end of the chain; 0 the current position; k the position after premove k. */
  readonly premoveStep: Signal<number | null> = signal(null);
  /** A premove save is running. The board stays live; further edits wait their turn. */
  readonly premoveSending: Signal<boolean> = signal(false);
  /**
   * True while the player's own move is anywhere short of settled (waiting for Confirm, sending,
   * retrying). The stream can already show the opponent's turn then, but every drop would be
   * refused until the move settles, so the board offers no premoves meanwhile.
   */
  readonly moveBusy: Signal<boolean> = signal(false);
  readonly premoves: ReadonlySignal<string[]>;
  /** Premoves are possible: the player waits on the opponent. True while an earlier move is shown. */
  readonly premoveOpen: ReadonlySignal<boolean>;
  /** Premoves are possible and the latest position is shown, so the board shows the chain. */
  readonly premoveMode: ReadonlySignal<boolean>;
  /** The slider's last index: the real plies, then the premoves while they are possible. */
  readonly timelineEnd: ReadonlySignal<number>;
  /** Where the slider stands: a ply, or past the last one, a premove step. */
  readonly timelineAt: ReadonlySignal<number>;
  readonly shownStep: ReadonlySignal<number>;
  readonly atChainEnd: ReadonlySignal<boolean>;
  readonly boardView: ReadonlySignal<Position>;
  readonly boardTurn: ReadonlySignal<Colour>;
  readonly premoveSquares: ReadonlySignal<string[]>;
  readonly premoveLabels: ReadonlySignal<string[]>;

  constructor(initial: GameDto) {
    this.dto = signal(initial);
    this.isLatest = computed(() => this.viewingPly.value === null);
    this.position = computed(() =>
      positionAt(this.dto.value, this.viewingPly.value ?? this.dto.value.plyCount),
    );
    this.orientation = computed(() => {
      const own: Colour = this.dto.value.viewerRole === 'black' ? 'black' : 'white';
      return this.flipped.value ? (own === 'white' ? 'black' : 'white') : own;
    });
    this.sideToMove = computed(() => sideToMove(this.position.value.fen));
    this.premoves = computed(() => this.optimisticPremoves.value ?? this.dto.value.premoves);
    this.premoveOpen = computed(() => {
      const dto = this.dto.value;
      return (
        dto.status === 'active' &&
        (dto.viewerRole === 'white' || dto.viewerRole === 'black') &&
        sideToMove(dto.fen) !== dto.viewerRole &&
        !this.moveBusy.value
      );
    });
    this.premoveMode = computed(() => this.premoveOpen.value && this.isLatest.value);
    this.shownStep = computed(() =>
      Math.min(this.premoveStep.value ?? Number.POSITIVE_INFINITY, this.premoves.value.length),
    );
    this.atChainEnd = computed(() => this.shownStep.value === this.premoves.value.length);
    this.timelineEnd = computed(
      () => this.dto.value.plyCount + (this.premoveOpen.value ? this.premoves.value.length : 0),
    );
    this.timelineAt = computed(() =>
      this.premoveMode.value
        ? this.dto.value.plyCount + this.shownStep.value
        : this.position.value.ply,
    );
    // The queue belongs to the viewer; an entry that would move the other side's piece (one that
    // captured the piece it was queued for) is skipped, as the server's check skips it.
    const owner = (): Colour | undefined => {
      const role = this.dto.value.viewerRole;
      return role === 'white' || role === 'black' ? role : undefined;
    };
    const imagined = (count: number) =>
      imaginedBoard(this.dto.value.fen, this.premoves.value.slice(0, count), owner());
    this.boardView = computed(() => {
      const real = this.position.value;
      if (!this.premoveMode.value || this.shownStep.value === 0) return real;
      const side = this.dto.value.viewerRole === 'black' ? 'b' : 'w';
      const placement = placementOf(imagined(this.shownStep.value).pieces);
      return { ...real, fen: `${placement} ${side} - - 0 1`, check: false };
    });
    this.boardTurn = computed(() =>
      this.premoveMode.value ? (this.dto.value.viewerRole as Colour) : this.sideToMove.value,
    );
    this.premoveSquares = computed(() => {
      const step = this.shownStep.value;
      const uci = this.premoveMode.value && step > 0 ? this.premoves.value[step - 1] : undefined;
      return uci ? [uci.slice(0, 2), uci.slice(2, 4)] : [];
    });
    this.premoveLabels = computed(() =>
      this.premoves.value.map((uci, index) => premoveLabel(imagined(index), uci, owner())),
    );
    this.canMove = computed(() => {
      const dto = this.dto.value;
      if (this.premoveMode.value) return this.atChainEnd.value;
      return (
        dto.status === 'active' &&
        this.isLatest.value &&
        (dto.viewerRole === 'white' || dto.viewerRole === 'black') &&
        sideToMove(dto.fen) === dto.viewerRole
      );
    });
    this.dests = computed(() => {
      if (!this.canMove.value) return new Map<string, string[]>();
      if (this.premoveMode.value)
        return premoveTargets(
          imagined(this.premoves.value.length),
          this.dto.value.viewerRole as Colour,
        );
      return legalDests(this.dto.value.fen);
    });
  }

  /**
   * Applies a newer snapshot; an older or equal version is ignored and leaves the signals alone,
   * so a refresh that brings nothing new does not re-render the board. Returns whether it applied.
   */
  apply(next: GameDto): boolean {
    const current = this.dto.value;
    if (next.version < current.version) return false;
    if (
      next.version === current.version &&
      next.plyCount === current.plyCount &&
      next.status === current.status &&
      sameList(next.premoves, current.premoves)
    ) {
      return false;
    }
    const viewing = this.viewingPly.value;
    this.dto.value = next;
    const samePly = next.plyCount === current.plyCount && next.status === current.status;
    if (!(this.premoveSending.value && samePly)) this.optimisticPremoves.value = null;
    // The step clamps to the end when the game moves on, or when the chain shrinks to at or
    // below it — otherwise a later append would jump the view back to a stale step (fix round 1).
    if (
      next.plyCount !== current.plyCount ||
      next.premoves.length <= (this.premoveStep.value ?? Number.POSITIVE_INFINITY)
    ) {
      this.premoveStep.value = null;
    }
    // A player reading an old position is brought back when the game moves on; spectators stay.
    if (viewing !== null && next.plyCount > current.plyCount && next.viewerRole !== 'spectator') {
      this.viewingPly.value = null;
    }
    return true;
  }

  viewPly(ply: number | null): void {
    const max = this.dto.value.plyCount;
    this.viewingPly.value = ply === null || ply >= max ? null : Math.max(0, ply);
  }

  /**
   * Shows index `at` on the slider: a ply up to the last real move, a premove step past it. The
   * last real move with a chain queued is step 0, the real position. Returns whether the view changed.
   */
  viewTimeline(at: number): boolean {
    const plies = this.dto.value.plyCount;
    const k = Math.max(0, Math.min(this.timelineEnd.value, at));
    if (k === this.timelineAt.value) return false;
    if (k < plies) {
      this.viewPly(k);
      return true;
    }
    this.viewPly(null);
    if (this.premoveOpen.value) this.viewPremove(k - plies);
    return true;
  }

  flip(): void {
    this.flipped.value = !this.flipped.value;
  }

  /** Views premove `step` (0 = the current position); returns whether the view changed. */
  viewPremove(step: number): boolean {
    const length = this.premoves.value.length;
    const k = Math.max(0, Math.min(length, step));
    if (k === this.shownStep.value) return false;
    this.premoveStep.value = k === length ? null : k;
    return true;
  }
}
