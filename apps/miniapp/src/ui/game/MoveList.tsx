import { t } from '@group-chess/shared';
import { useEffect, useRef } from 'preact/hooks';
import type { GameStore } from '../../state/game';

/** `locked` while a move waits for Confirm move: the board holds that move, so the strip can't switch position. */
export function MoveList(props: { store: GameStore; locked?: boolean }) {
  const { store } = props;
  const moves = store.dto.value.moves;
  const viewing = store.position.value.ply;
  const strip = useRef<HTMLDivElement>(null);
  // A new move scrolls the strip to its end, unless the viewer is replaying an earlier one.
  useEffect(() => {
    const element = strip.current;
    if (element && store.isLatest.value) element.scrollLeft = element.scrollWidth;
  }, [moves.length]);
  if (moves.length === 0) return <p class="move-list hint">{t('app.game.no_moves')}</p>;
  return (
    <div class="move-list" ref={strip}>
      {moves.map((move) => (
        <>
          {move.ply % 2 === 1 ? <span class="number">{Math.ceil(move.ply / 2)}.</span> : null}
          <button
            key={move.ply}
            data-ply={move.ply}
            aria-current={viewing === move.ply ? 'true' : 'false'}
            disabled={props.locked}
            onClick={() => store.viewPly(move.ply)}
          >
            {move.san}
          </button>
        </>
      ))}
      {!store.isLatest.value ? (
        <button
          class="badge"
          data-action="latest"
          disabled={props.locked}
          onClick={() => store.viewPly(null)}
        >
          {t('app.game.latest')}
        </button>
      ) : null}
    </div>
  );
}
