import type { BoardAdapter, BoardPosition, Movable, MoveHandler } from '../../src/board/adapter';

export type StubAdapter = BoardAdapter & {
  positions: BoardPosition[];
  movables: Movable[];
  viewOnly: boolean | null;
  restored: number;
  drop(orig: string, dest: string, captured?: boolean): void;
};

/** What the game screen sees instead of chessground; tests drive drops through `drop`. */
export function stubAdapter(): StubAdapter {
  let handler: MoveHandler | null = null;
  const stub: StubAdapter = {
    positions: [],
    movables: [],
    viewOnly: null,
    restored: 0,
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
    flip: () => undefined,
    cancelMove: () => {
      stub.restored += 1;
    },
    destroy: () => undefined,
    drop: (orig, dest, captured = false) => handler?.(orig, dest, { captured }),
  };
  return stub;
}
