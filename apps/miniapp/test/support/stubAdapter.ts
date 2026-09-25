import type { BoardAdapter, BoardPosition, Movable, MoveHandler } from '../../src/board/adapter';

export type StubAdapter = BoardAdapter & {
  positions: BoardPosition[];
  movables: Movable[];
  viewOnly: boolean | null;
  restored: number;
  highlights: string[][];
  drop(orig: string, dest: string, captured?: boolean): void;
  select(square: string): void;
};

/** What the game screen sees instead of chessground; tests drive drops through `drop`. */
export function stubAdapter(): StubAdapter {
  let handler: MoveHandler | null = null;
  let selectHandler: ((square: string) => void) | null = null;
  const stub: StubAdapter = {
    positions: [],
    movables: [],
    viewOnly: null,
    restored: 0,
    highlights: [],
    setPosition: (position) => {
      stub.positions.push(position);
    },
    setMovable: (movable) => {
      stub.movables.push(movable);
    },
    setViewOnly: (value) => {
      stub.viewOnly = value;
    },
    onMove: (callback) => {
      handler = callback;
    },
    setHighlights: (squares) => {
      stub.highlights.push(squares);
    },
    onSelect: (callback) => {
      selectHandler = callback;
    },
    flip: () => undefined,
    cancelMove: () => {
      stub.restored += 1;
    },
    destroy: () => undefined,
    drop: (orig, dest, captured = false) => handler?.(orig, dest, { captured }),
    select: (square) => selectHandler?.(square),
  };
  return stub;
}
