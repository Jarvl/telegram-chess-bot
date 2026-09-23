import { effect } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { createBoardAdapter, type BoardAdapter, type MoveHandler } from '../../board/adapter';
import type { GameStore } from '../../state/game';

/** Mounts the adapter once and pushes position, movable set and view-only flag from the store. */
export function Board(props: {
  store: GameStore;
  onMove: MoveHandler;
  onReady: (adapter: BoardAdapter) => void;
  children?: preact.ComponentChildren;
}) {
  const element = useRef<HTMLDivElement>(null);
  const onMoveRef = useRef(props.onMove);
  onMoveRef.current = props.onMove;
  const { store } = props;
  useEffect(() => {
    const spectator = store.dto.value.viewerRole === 'spectator';
    const adapter = createBoardAdapter(
      element.current!,
      {
        ...store.position.value,
        orientation: store.orientation.value,
        turnColour: store.sideToMove.value,
      },
      { viewOnly: spectator },
    );
    adapter.onMove((orig, dest, meta) => onMoveRef.current(orig, dest, meta));
    props.onReady(adapter);
    const disposers = [
      effect(() => {
        const next = {
          ...store.position.value,
          orientation: store.orientation.value,
          turnColour: store.sideToMove.value,
        };
        adapter.setPosition(next);
      }),
      effect(() =>
        adapter.setMovable({
          colour: store.canMove.value ? (store.dto.value.viewerRole as 'white' | 'black') : 'none',
          dests: store.dests.value,
        }),
      ),
      effect(() => adapter.setViewOnly(store.dto.value.viewerRole === 'spectator')),
    ];
    return () => {
      for (const dispose of disposers) dispose();
      adapter.destroy();
    };
  }, [store]);
  return (
    <div class="board-wrap">
      <div ref={element} />
      {props.children}
    </div>
  );
}
